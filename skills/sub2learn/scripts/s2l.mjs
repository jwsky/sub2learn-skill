#!/usr/bin/env node
// s2l.mjs — drive https://sub2learn.com in a (headless) browser to extract, merge and
// translate subtitles. Videos are read by the page's own File API code inside the local
// browser; nothing but subtitle text ever leaves the machine (and only for `translate`).
//
//   node scripts/s2l.mjs <command> [options]      run `help` for the full list
//
// stdout carries exactly one JSON object (the result); progress goes to stderr.
// Exit codes: 0 ok · 1 failed · 2 usage error.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.1';
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(SKILL_DIR, 'assets');
const DEFAULT_SITE = 'https://sub2learn.com/';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // the site rejects bigger subtitle uploads

// Every page hook this CLI relies on lives here, so a site redesign is a one-place fix.
const SELECTORS = {
  // home page · subtitle-file flow (upload → level-graded translation → download)
  level: '#english_level',
  from: '#trans_source',
  to: '#trans_target',
  srtInput: '#file',
  srtSubmit: '#upload',
  uploadedName: '#realfilename',
  rows: '#sub_table tbody tr th[scope="row"]',
  rowError: '#sub_table td.text-danger',
  startTranslate: '#start_translate',
  downloadModal: '#downloadModal.show',
  downloadBoth: '#link1',
  downloadOnly: '#link2',
  // home page · local MKV/WebM overlay
  mkvOpen: '[data-bs-target="#s2lmkvModal"]',
  mkvModal: '#s2lmkvModal.show',
  mkvInput: '#s2lmkv-file',
  mkvPct: '#s2lmkv-pct',
  mkvStatus: '#s2lmkv-statLine',
  mkvWarn: '#s2lmkv-statLine .s2lmkv-warn',
  mkvTable: '#s2lmkv-results .s2lmkv-tbl',
  mkvRows: '#s2lmkv-results .s2lmkv-tbl tbody tr',
  trackCard: n => `#s2lmkv-results .s2lmkv-card[data-track="${n}"]`,
  srtButton: 'button[data-srt]',
  ocrLang: 'select.ocrlang',
  ocrButton: 'button.ocrbtn',
  ocrStatus: '.ocrstat',
  ocrDone: '.trtools button[data-srt]', // appears when OCR finishes
  ocrWarn: '.ocrstat .s2lmkv-warn',
  merge: '#s2lmkv-results .s2lmkv-merge',
  mergeTop: 'select.mg-top',
  mergeBottom: 'select.mg-bot',
  mergeDownload: 'button.mg-dl',
  mergeStatus: '.mg-stat',
  mergeOk: '.mg-stat .s2lmkv-ok',
};

// --level → the site's #english_level value (sub_gen.php maps these to word-frequency lists)
const LEVELS = {
  all: '0english', none: '0english', '0': '0english',
  kindergarten: 'kindergarten_level', primary: 'primary_school_level', middle: 'middle_school_level',
  high: 'high_school_level', cet4: 'cet4_level', cet6: 'cet6_level',
};
const OCR_LANGS = ['eng', 'chi_sim', 'chi_tra', 'eng+chi_sim'];
const VIDEO_EXT = new Set(['.mkv', '.webm', '.mk3d', '.mka', '.mks']);
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sbv', '.txt']);
const BROWSER_PATHS = [
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

// ---------------------------------------------------------------- errors, logging, output
class UsageError extends Error {}
class S2LError extends Error { constructor(message, hint) { super(message); this.hint = hint; } }

let verbose = false;
const log = (...a) => process.stderr.write('[s2l] ' + a.join(' ') + '\n');
const debug = (...a) => { if (verbose) log(...a); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const emit = obj => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

// ---------------------------------------------------------------- arguments
const BOOL_FLAGS = new Set(['all', 'ocr', 'headed', 'with-translate', 'with-ocr', 'verbose', 'force', 'help', 'version', 'keep']);
const LIST_FLAGS = new Set(['track', 'lang']);
const VALUE_FLAGS = new Set(['site', 'ui', 'browser', 'executable-path', 'cdp', 'proxy', 'timeout', 'out', 'track', 'lang',
  'top', 'bottom', 'ocr-lang', 'level', 'from', 'to', 'mode']);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    let key = a.slice(2), val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (BOOL_FLAGS.has(key)) { opts[key] = val === undefined ? true : !/^(0|false|no)$/i.test(val); continue; }
    if (!VALUE_FLAGS.has(key)) throw new UsageError(`Unknown option --${key}. Run "node scripts/s2l.mjs help".`);
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined || val.startsWith('--')) throw new UsageError(`Option --${key} needs a value.`);
    }
    if (LIST_FLAGS.has(key)) (opts[key] ||= []).push(...val.split(',').map(s => s.trim()).filter(Boolean));
    else opts[key] = val;
  }
  return opts;
}

function timeoutMs(opts, defMinutes) {
  if (opts.timeout === undefined) return defMinutes * 60000;
  const m = Number(opts.timeout);
  if (!(m > 0)) throw new UsageError('--timeout takes a number of minutes, e.g. --timeout 90');
  return m * 60000;
}

// ---------------------------------------------------------------- subtitle text helpers
function fmtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000); ms %= 3600000;
  const m = Math.floor(ms / 60000); ms %= 60000;
  const s = Math.floor(ms / 1000), mil = ms % 1000;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(mil, 3)}`;
}

function parseTime(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const frac = m[4] || '0';
  const ms = frac.length === 1 ? +frac * 100 : frac.length === 2 ? +frac * 10 : +frac;
  return ((+(m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + ms;
}

// decode a subtitle file: BOM-aware UTF-8/UTF-16, then GB18030 (common for Chinese subs), then latin1
function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xFE && buf[1] === 0xFF) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gb18030', { fatal: true }).decode(buf); } catch {}
  return buf.toString('latin1');
}

const stripTags = s => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// SRT / WebVTT / SBV: blocks separated by blank lines, timing line holds "-->" (or "," for SBV)
function parseBlocks(text, kind) {
  const cues = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    let ti = -1, s = null, e = null;
    for (let i = 0; i < lines.length; i++) {
      if (kind === 'sbv') {
        const m = lines[i].match(/^\s*([\d:.]+)\s*,\s*([\d:.]+)\s*$/);
        if (m) { s = parseTime(m[1]); e = parseTime(m[2]); ti = i; break; }
      } else if (lines[i].includes('-->')) {
        const [a, b] = lines[i].split('-->');
        s = parseTime(a); e = parseTime((b || '').trim().split(/\s+/)[0]); ti = i; break;
      }
    }
    if (ti < 0 || s === null || e === null) continue;
    let t = lines.slice(ti + 1).join('\n').trim();
    if (kind === 'vtt') t = stripTags(t);
    cues.push({ s, e, t });
  }
  return cues;
}

function parseAss(text) {
  const cues = [];
  let inEvents = false, fields = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { inEvents = /^\[events\]$/i.test(line); continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) { fields = line.replace(/^format\s*:/i, '').split(',').map(f => f.trim().toLowerCase()); continue; }
    if (!/^dialogue\s*:/i.test(line) || !fields) continue;
    const parts = line.replace(/^dialogue\s*:/i, '').split(',');
    const vals = parts.slice(0, fields.length - 1).concat(parts.slice(fields.length - 1).join(','));
    const get = k => (vals[fields.indexOf(k)] || '').trim();
    const s = parseTime(get('start')), e = parseTime(get('end'));
    const t = get('text').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ').trim();
    if (s === null || e === null || !t) continue;
    cues.push({ s, e, t });
  }
  return cues;
}

function parseSubtitleFile(file) {
  const ext = path.extname(file).toLowerCase();
  const text = decodeText(fs.readFileSync(file));
  let cues;
  if (ext === '.ass' || ext === '.ssa') cues = parseAss(text);
  else cues = parseBlocks(text, ext === '.vtt' ? 'vtt' : ext === '.sbv' ? 'sbv' : 'srt');
  return cues.sort((a, b) => a.s - b.s);
}

const toSrt = cues => cues.map((c, i) => `${i + 1}\n${fmtTime(c.s)} --> ${fmtTime(c.e)}\n${c.t}\n`).join('\n');

// Same alignment as the site's merge card: the top track's timeline is authoritative; each top
// cue collects every bottom cue that overlaps it (deduplicated). Output matches the site byte for
// byte, except that the site keeps any CRLF a Matroska text cue carries inside multi-line cues.
function mergeCues(top, bottom) {
  const out = []; let lo = 0;
  for (const a of top) {
    if (!a) continue;
    while (lo < bottom.length && bottom[lo].e <= a.s) lo++;
    const parts = [];
    for (let j = lo; j < bottom.length && bottom[j].s < a.e; j++) { const b = bottom[j]; if (b.e > a.s && b.t && !parts.includes(b.t)) parts.push(b.t); }
    out.push({ s: a.s, e: a.e, top: a.t || '', bottom: parts.join('\n') });
  }
  return out;
}
const mergedSrt = list => list.map((c, i) => {
  let body = c.top; if (c.bottom) body += (c.top ? '\n' : '') + c.bottom;
  return `${i + 1}\n${fmtTime(c.s)} --> ${fmtTime(c.e)}\n${body}\n`;
}).join('\n');

// ---------------------------------------------------------------- language matching
const LANG_GROUPS = {
  en: ['en', 'eng', 'english', 'en-us', 'en-gb', 'en-au', 'en-ca'],
  zh: ['zh', 'chi', 'zho', 'chinese', 'cmn', '中文', 'zh-cn', 'zh-hans', 'zh-sg', 'chs', 'sc', 'zh-tw', 'zh-hant', 'zh-hk', 'cht', 'tc', '简体', '繁體', '繁体'],
  ja: ['ja', 'jpn', 'japanese'], ko: ['ko', 'kor', 'korean'], es: ['es', 'spa', 'spanish'],
  fr: ['fr', 'fre', 'fra', 'french'], de: ['de', 'ger', 'deu', 'german'], ru: ['ru', 'rus', 'russian'],
  pt: ['pt', 'por', 'portuguese', 'pt-br'], it: ['it', 'ita', 'italian'], vi: ['vi', 'vie', 'vietnamese'],
  th: ['th', 'tha', 'thai'], ar: ['ar', 'ara', 'arabic'],
};
const groupOf = code => {
  const c = String(code || '').toLowerCase();
  for (const [g, list] of Object.entries(LANG_GROUPS)) if (list.includes(c) || c.split('-')[0] === g) return g;
  return null;
};
const SIMPLIFIED_Q = ['zh-cn', 'zh-hans', 'zh-sg', 'chs', 'sc', '简体'];
const TRADITIONAL_Q = ['zh-tw', 'zh-hant', 'zh-hk', 'cht', 'tc', '繁體', '繁体'];
const SIMPLIFIED_NAME = /简|chs|\bsc\b|simplified|hans|zh-cn|\bgb\b/i;
const TRADITIONAL_NAME = /繁|cht|\btc\b|traditional|hant|zh-tw|zh-hk|big5/i;

// what callers see of a track (internal OCR bookkeeping stays private)
const publicTrack = ({ number, type, kind, codec, lang, name, cues, frames }) => ({ number, type, kind, codec, lang, name, cues, frames });
const describeTrack = t => `#${t.number} ${t.lang}${t.name ? ` "${t.name}"` : ''} (${t.kind === 'image' ? `image, ${t.frames} frames` : `${t.cues} cue${t.cues === 1 ? '' : 's'}`})`;

// Pick one subtitle track for a spec: a track number, or a language with sensible tie-breaks
// (skip "forced" tracks, prefer text over image, prefer non-SDH, honour 简/繁 hints, most cues).
function resolveTrack(spec, subs, exclude) {
  const s = String(spec).trim();
  if (/^#?\d+$/.test(s)) {
    const t = subs.find(x => x.number === +s.replace('#', ''));
    if (!t) throw new S2LError(`There is no subtitle track #${s.replace('#', '')}.`, `Subtitle tracks: ${subs.map(describeTrack).join(', ')}`);
    return { track: t, note: null };
  }
  const q = s.toLowerCase(), g = groupOf(q);
  const cands = subs.filter(t => t !== exclude && (t.lang.toLowerCase() === q || (g && groupOf(t.lang) === g)));
  if (!cands.length) return { track: null, note: null };
  const wantSimp = SIMPLIFIED_Q.includes(q), wantTrad = TRADITIONAL_Q.includes(q);
  const score = t => {
    let v = 0; const n = t.name || '';
    if (/forced|強制|强制/i.test(n)) v -= 1000;
    if (/sdh|hearing|\bcc\b|听障|聽障/i.test(n)) v -= 5;
    if (t.kind === 'text') v += 100;
    if (g === 'zh') {
      if (wantTrad) v += TRADITIONAL_NAME.test(n) ? 50 : 0;
      else if (wantSimp) v += SIMPLIFIED_NAME.test(n) ? 50 : (TRADITIONAL_NAME.test(n) ? -20 : 0);
      else v += TRADITIONAL_NAME.test(n) ? -10 : 0; // plain "zh": mainland simplified first
    }
    return v;
  };
  const ranked = cands.slice().sort((a, b) => score(b) - score(a) || (b.cues || b.frames || 0) - (a.cues || a.frames || 0) || a.number - b.number);
  const note = ranked.length > 1 ? `"${spec}" matched ${ranked.length} tracks; picked ${describeTrack(ranked[0])} over ${ranked.slice(1).map(describeTrack).join(', ')}` : null;
  return { track: ranked[0], note };
}

// ---------------------------------------------------------------- browser session
async function loadPlaywright() {
  try { return await import('playwright'); } catch (err) {
    throw new S2LError('Playwright is not installed for this skill.', 'Run once: bash scripts/setup.sh   (installs the npm dependency and a browser)');
  }
}

function playwrightVersion() {
  try { return createRequire(import.meta.url)('playwright/package.json').version; } catch { return null; }
}

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0;

async function launchBrowser(pw, opts) {
  const { chromium } = pw;
  const headless = !opts.headed;
  const args = isRoot() ? ['--no-sandbox'] : []; // Chromium refuses to run as root without it (typical on a VPS)
  const proxyServer = opts.proxy || process.env.S2L_PROXY;
  const proxy = proxyServer ? { proxy: { server: proxyServer } } : {};
  const cdp = opts.cdp || process.env.S2L_CDP_URL;
  if (cdp) {
    const browser = await chromium.connectOverCDP(cdp);
    return { browser, how: `cdp ${cdp}`, own: false };
  }
  const exe = opts['executable-path'] || process.env.S2L_CHROME;
  if (exe) return { browser: await chromium.launch({ executablePath: exe, headless, args, ...proxy }), how: `executable ${exe}`, own: true };
  if (opts.browser && opts.browser !== 'chromium') {
    return { browser: await chromium.launch({ channel: opts.browser, headless, args, ...proxy }), how: `channel ${opts.browser}`, own: true };
  }
  try {
    return { browser: await chromium.launch({ headless, args, ...proxy }), how: 'playwright chromium', own: true };
  } catch (err) {
    if (!/Executable doesn't exist|executable doesn't exist|Failed to launch/i.test(err.message) || opts.browser === 'chromium') throw err;
    debug('bundled Chromium unavailable:', err.message.split('\n')[0]);
  }
  try { return { browser: await chromium.launch({ channel: 'chrome', headless, args, ...proxy }), how: 'channel chrome (fallback)', own: true }; } catch {}
  for (const p of BROWSER_PATHS) {
    if (!fs.existsSync(p)) continue;
    try { return { browser: await chromium.launch({ executablePath: p, headless, args, ...proxy }), how: `executable ${p} (fallback)`, own: true }; } catch (e) { debug(`cannot launch ${p}:`, e.message.split('\n')[0]); }
  }
  throw new S2LError('No usable Chromium or Google Chrome was found.', 'Run: bash scripts/setup.sh   (or install Google Chrome and pass --browser chrome)');
}

async function openSession(opts) {
  const pw = await loadPlaywright();
  const { browser, how, own } = await launchBrowser(pw, opts);
  const context = await browser.newContext({ acceptDownloads: true, locale: 'en-US', viewport: { width: 1366, height: 900 } });
  // a returning visitor has dismissed the cookie bar; without this it can sit over buttons
  await context.addInitScript(() => { try { localStorage.setItem('s2l_cookie_ok', '1'); } catch (e) {} });
  const session = { browser, context, how, version: browser.version(), dialogs: [] };
  session.newPage = async () => {
    const page = await context.newPage();
    page.on('dialog', async d => { session.dialogs.push(d.message()); log('site alert:', d.message()); await d.dismiss().catch(() => {}); });
    page.on('pageerror', e => debug('page error:', e.message));
    return page;
  };
  session.close = async () => {
    await context.close().catch(() => {});
    if (own) await browser.close().catch(() => {});
    // a CDP-connected browser belongs to the user: we only drop our own context (above)
  };
  log(`browser: ${how} · ${session.version}`);
  return session;
}

function siteUrl(opts) {
  const u = new URL(opts.site || process.env.S2L_SITE || DEFAULT_SITE);
  if (!u.searchParams.has('force')) u.searchParams.set('force', opts.ui === 'cn' ? 'cn' : 'global');
  return u.toString();
}

async function gotoSite(page, opts) {
  const url = siteUrl(opts);
  let resp;
  try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }); } catch (err) {
    throw new S2LError(`Cannot open ${url}: ${err.message.split('\n')[0]}`, 'Check the network/DNS of this machine, or pass --site with a reachable mirror.');
  }
  if (!resp || resp.status() >= 400) throw new S2LError(`${url} answered HTTP ${resp ? resp.status() : 'nothing'}.`);
  await page.waitForFunction(() => window.jQuery && window.jQuery.isReady === true, null, { timeout: 60000 }).catch(() => {});
  await sleep(300); // let jQuery ready-handlers attach
  return url;
}

// click something that triggers a download and save it where destFor(suggestedName) says
async function clickAndSave(page, locator, destFor, opts, timeout = 60000) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout }), locator.click()]);
  const failure = await dl.failure();
  if (failure) throw new S2LError(`Download failed: ${failure}`);
  const dest = uniquePath(destFor(dl.suggestedFilename()), opts);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try { await dl.saveAs(dest); } catch (err) {
    throw new S2LError(`Cannot write ${dest}: ${err.message.split('\n')[0]}`, 'Pass --out with a writable directory.');
  }
  return dest;
}

// never clobber an existing file unless --force: "name.srt" → "name (1).srt"
function uniquePath(p, opts) {
  if (opts.force || !fs.existsSync(p)) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 1; ; i++) { const c = `${base} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
}

// --out FILE.srt (single output) or --out DIR; default: next to the input file
function outTarget(opts, input, suggested, single) {
  if (opts.out) {
    const o = path.resolve(opts.out);
    if (/\.srt$/i.test(o)) {
      if (!single) throw new UsageError('--out names a single .srt file, but this command writes several files; pass a directory instead.');
      return o;
    }
    return path.join(o, suggested);
  }
  return path.join(path.dirname(path.resolve(input)), suggested);
}

// ---------------------------------------------------------------- MKV / WebM overlay
async function loadVideo(session, video, opts) {
  const file = path.resolve(video);
  if (!fs.existsSync(file)) throw new UsageError(`File not found: ${video}`);
  const ext = path.extname(file).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    throw new S2LError(`${path.basename(file)} is not an MKV/WebM file.`, ext === '.mp4' || ext === '.avi' || ext === '.mov'
      ? 'MP4/AVI/MOV keep subtitles outside the video or in formats the site cannot read; ask the user for the .srt file, or extract it with ffmpeg first.'
      : 'Supported videos: .mkv, .webm (Matroska containers).');
  }
  const page = await session.newPage();
  await gotoSite(page, opts);
  await page.locator(SELECTORS.mkvOpen).first().click();
  await page.waitForSelector(SELECTORS.mkvModal, { timeout: 30000 });
  const size = fs.statSync(file).size;
  log(`reading ${path.basename(file)} (${(size / 1048576).toFixed(1)} MB) locally in the browser…`);
  await page.setInputFiles(SELECTORS.mkvInput, file);
  const limit = timeoutMs(opts, 30), t0 = Date.now();
  let lastLog = Date.now(), lastPct = '';
  for (;;) {
    if (await page.locator(SELECTORS.mkvWarn).count()) {
      const msg = (await page.locator(SELECTORS.mkvWarn).first().innerText()).trim();
      throw new S2LError(`The site could not read this video: ${msg}`, /MKV|WebM/i.test(msg) ? 'Only Matroska (.mkv/.webm) containers are supported.' : undefined);
    }
    if (await page.locator(SELECTORS.mkvTable).count()) break;
    if (Date.now() - t0 > limit) throw new S2LError(`Reading the video timed out after ${Math.round(limit / 60000)} min.`, 'Large files need ≈ one full sequential read; raise --timeout (minutes).');
    if (Date.now() - lastLog > 10000) {
      const [pct, stat] = await page.evaluate(([a, b]) => [a, b].map(s => { const n = document.querySelector(s); return n ? n.innerText.replace(/\s+/g, ' ').trim() : ''; }), [SELECTORS.mkvPct, SELECTORS.mkvStatus]).catch(() => ['', '']);
      if (pct && pct !== lastPct && !pct.includes('✓')) { log(`reading ${pct}${stat ? ' · ' + stat : ''}`); lastPct = pct; }
      lastLog = Date.now();
    }
    await sleep(500);
  }
  const tracks = await readTracks(page);
  const subs = tracks.filter(t => t.type === 'subtitle');
  log(`parsed in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${tracks.length} tracks, ${subs.length} subtitle`);
  return { page, file, tracks, subs };
}

async function readTracks(page) {
  return page.$$eval(SELECTORS.mkvRows, rows => rows.map(tr => {
    const td = tr.querySelectorAll('td');
    const num = s => { const m = String(s || '').match(/(\d+)/); return m ? +m[1] : null; };
    const pill = td[1] && td[1].querySelector('.s2lmkv-pill');
    const cls = pill ? ([...pill.classList].find(c => c !== 's2lmkv-pill') || '') : '';
    const type = { vid: 'video', aud: 'audio', sub: 'subtitle', img: 'subtitle' }[cls] || 'other';
    const codecNode = td[2] && td[2].childNodes[0];
    return {
      number: num(td[0] && td[0].textContent), type,
      kind: type === 'subtitle' ? (cls === 'img' ? 'image' : 'text') : null,
      codec: codecNode ? codecNode.textContent.trim() : '',
      lang: (td[3] && td[3].textContent.trim()) || 'und',
      name: (td[5] && td[5].textContent.trim()) || '',
      cues: cls === 'sub' ? num(td[4] && td[4].textContent) : null,
      frames: cls === 'img' ? num(td[4] && td[4].textContent) : null,
    };
  }));
}

function defaultOcrLang(t) {
  if (groupOf(t.lang) === 'zh') return TRADITIONAL_NAME.test(t.name) ? 'chi_tra' : 'chi_sim';
  return 'eng';
}

// OCR an image (Blu-ray PGS) track in the page; afterwards it behaves like a text track
async function ocrTrack(page, t, opts) {
  const card = page.locator(SELECTORS.trackCard(t.number));
  if (t.ocrDone) return;
  const btn = card.locator(SELECTORS.ocrButton);
  if (!(await btn.count()) || await btn.isDisabled()) {
    const msg = (await card.locator(SELECTORS.ocrStatus).innerText().catch(() => '')).trim();
    throw new S2LError(`Track #${t.number} (${t.codec}) cannot be OCR'd${msg ? ': ' + msg : ''}.`, 'Only Blu-ray PGS image subtitles are supported (DVD VobSub is not).');
  }
  const lang = opts['ocr-lang'] || defaultOcrLang(t);
  if (!OCR_LANGS.includes(lang)) throw new UsageError(`--ocr-lang must be one of ${OCR_LANGS.join(', ')}`);
  await card.locator(SELECTORS.ocrLang).selectOption(lang);
  log(`OCR track #${t.number} (${t.frames} PGS packets, ${lang}) — runs locally, can take a while…`);
  await btn.click();
  const limit = timeoutMs(opts, 120), t0 = Date.now();
  let lastLog = Date.now();
  for (;;) {
    if (await card.locator(SELECTORS.ocrDone).count()) break;
    if (await card.locator(SELECTORS.ocrWarn).count()) {
      throw new S2LError(`OCR of track #${t.number} failed: ${(await card.locator(SELECTORS.ocrWarn).first().innerText()).trim()}`);
    }
    if (Date.now() - t0 > limit) throw new S2LError(`OCR timed out after ${Math.round(limit / 60000)} min.`, 'Raise --timeout (minutes); OCR time grows with the number of subtitle images and shrinks with CPU speed.');
    if (Date.now() - lastLog > 15000) {
      // read the status without auto-waiting: the line disappears the moment OCR completes
      const s = await card.evaluate((el, sel) => { const n = el.querySelector(sel); return n ? n.innerText.trim() : ''; }, SELECTORS.ocrStatus).catch(() => '');
      if (s) log(`OCR #${t.number}: ${s}`);
      lastLog = Date.now();
    }
    await sleep(1000);
  }
  t.ocrDone = true; t.ocrLang = lang; t.ocrSeconds = Math.round((Date.now() - t0) / 1000);
  log(`OCR #${t.number} finished in ${t.ocrSeconds}s`);
}

async function exportTrack(page, t, input, opts, single) {
  if (t.kind === 'image') await ocrTrack(page, t, opts);
  const btn = page.locator(SELECTORS.trackCard(t.number)).locator(SELECTORS.srtButton);
  const dest = await clickAndSave(page, btn, name => outTarget(opts, input, name, single), opts);
  const cues = parseSubtitleFile(dest);
  return { path: dest, kind: t.kind === 'image' ? 'ocr' : 'track', track: t.number, lang: t.lang, name: t.name, codec: t.codec, cues: cues.length, ...(t.ocrLang ? { ocrLang: t.ocrLang, ocrSeconds: t.ocrSeconds } : {}) };
}

// ---------------------------------------------------------------- commands
async function cmdDoctor(opts) {
  const result = { ok: false, command: 'doctor', version: VERSION, node: process.version, platform: `${os.platform()} ${os.arch()}`, root: isRoot(), playwright: playwrightVersion() };
  const major = +process.versions.node.split('.')[0];
  if (major < 20) throw new S2LError(`Node ${process.version} is too old; Node 20+ is required (Playwright 1.63).`);
  const session = await openSession(opts);
  try {
    result.browser = { how: session.how, version: session.version };
    const page = await session.newPage();
    const url = await gotoSite(page, opts);
    const has = async s => (await page.locator(s).count()) > 0;
    result.site = {
      url, title: await page.title(),
      mkvExtractor: await has(SELECTORS.mkvInput),
      subtitleForm: await has(SELECTORS.srtInput) && await has(SELECTORS.level),
    };
    if (!result.site.mkvExtractor || !result.site.subtitleForm) {
      throw new S2LError('The site loaded but its tool elements were not found (page layout changed?).', 'Update the skill: git pull, or check https://github.com/jwsky/sub2learn-skill');
    }
    result.ok = true;
    return result;
  } finally { await session.close(); }
}

async function cmdTracks(opts) {
  const [video] = opts._;
  if (!video) throw new UsageError('usage: tracks <video.mkv|webm>');
  const session = await openSession(opts);
  try {
    const v = await loadVideo(session, video, opts);
    const notes = v.subs.length ? [] : ['This file has no embedded subtitle tracks.'];
    if (v.subs.some(t => t.kind === 'image')) notes.push('Image (PGS) tracks need OCR: use extract --track N or merge with that track; OCR runs locally.');
    return { ok: true, command: 'tracks', input: v.file, tracks: v.tracks, subtitles: v.subs.length, notes };
  } finally { await session.close(); }
}

function selectForExtract(v, opts) {
  const notes = [];
  let chosen;
  if (opts.track) {
    chosen = opts.track.map(n => {
      const t = resolveTrack(n, v.subs).track;
      if (!t) throw new S2LError(`No subtitle track matches --track ${n}.`, `Subtitle tracks: ${v.subs.map(describeTrack).join(', ')}`);
      return t;
    });
  } else if (opts.lang) {
    chosen = v.subs.filter(t => opts.lang.some(l => t.lang.toLowerCase() === l.toLowerCase() || (groupOf(l) && groupOf(l) === groupOf(t.lang))));
    if (!chosen.length) throw new S2LError(`No subtitle track in ${opts.lang.join('/')}.`, `Subtitle tracks: ${v.subs.map(describeTrack).join(', ')}`);
  } else chosen = v.subs.slice();
  if (!opts.track && !opts.all && !opts.ocr) {
    const images = chosen.filter(t => t.kind === 'image');
    if (images.length) notes.push(`Skipped image (PGS) track(s) ${images.map(t => '#' + t.number).join(', ')}: add --ocr (or --track N) to OCR them locally.`);
    chosen = chosen.filter(t => t.kind === 'text');
  }
  return { chosen: [...new Set(chosen)], notes };
}

async function cmdExtract(opts) {
  const [video] = opts._;
  if (!video) throw new UsageError('usage: extract <video> [--track N] [--lang eng,chi] [--all] [--ocr] [--out DIR]');
  const session = await openSession(opts);
  try {
    const v = await loadVideo(session, video, opts);
    if (!v.subs.length) throw new S2LError('This video has no embedded subtitle tracks.', 'Ask the user for a separate .srt file.');
    const { chosen, notes } = selectForExtract(v, opts);
    if (!chosen.length) throw new S2LError('Nothing to extract with these options.', notes.join(' ') || undefined);
    const outputs = [];
    for (const t of chosen) {
      const o = await exportTrack(v.page, t, v.file, opts, chosen.length === 1);
      log(`saved ${o.path} (${o.cues} cues)`);
      outputs.push(o);
    }
    return { ok: true, command: 'extract', input: v.file, outputs, tracks: v.subs.map(publicTrack), notes };
  } finally { await session.close(); }
}

// Top/bottom from --top/--bottom (track number or language); an omitted side defaults to the
// "other" language of the pair English ⇄ Chinese, else the first remaining track (text first).
function pickMergePair(v, opts) {
  const notes = [];
  const listing = `Subtitle tracks: ${v.subs.map(describeTrack).join(', ')}`;
  const textFirst = list => list.slice().sort((a, b) => (a.kind === 'text' ? 0 : 1) - (b.kind === 'text' ? 0 : 1) || a.number - b.number);
  const fromSpec = (spec, role, exclude) => {
    const r = resolveTrack(spec, v.subs, exclude);
    if (!r.track) {
      const same = exclude && resolveTrack(spec, v.subs).track === exclude;
      throw new S2LError(same ? `--top and --bottom both resolve to track #${exclude.number}.` : `No "${spec}" subtitle track for the ${role} line.`, listing);
    }
    if (r.note) notes.push(`${role}: ${r.note}`);
    return r.track;
  };
  const fallback = (role, prefer, exclude) => {
    const r = resolveTrack(prefer, v.subs, exclude);
    const t = r.track || textFirst(v.subs.filter(x => x !== exclude))[0];
    notes.push(`${role} defaulted to ${describeTrack(t)}`); if (r.track && r.note) notes.push(`${role}: ${r.note}`);
    return t;
  };
  const other = t => (t && groupOf(t.lang) === 'zh' ? 'en' : t && groupOf(t.lang) === 'en' ? 'zh' : null);
  let top = opts.top ? fromSpec(opts.top, 'top') : null;
  let bottom = opts.bottom ? fromSpec(opts.bottom, 'bottom', top) : null;
  if (!top) top = fallback('top', other(bottom) || 'en', bottom);
  if (!bottom) bottom = fallback('bottom', other(top) || 'zh', top);
  if (top === bottom) throw new S2LError(`Top and bottom are the same track (#${top.number}); pick two different tracks.`, listing);
  return { top, bottom, notes };
}

async function cmdMerge(opts) {
  const [video] = opts._;
  if (!video) throw new UsageError('usage: merge <video> [--top N|lang] [--bottom N|lang] [--out FILE]');
  const session = await openSession(opts);
  try {
    const v = await loadVideo(session, video, opts);
    if (v.subs.length < 2) {
      throw new S2LError(`Merging needs two subtitle tracks; this video has ${v.subs.length}.`,
        'Get the second language as a separate .srt and use: merge-srt <top.srt> <bottom.srt>' + (v.subs.length ? ' (extract this one first with: extract <video>)' : ''));
    }
    const { top, bottom, notes } = pickMergePair(v, opts);
    for (const t of [top, bottom]) if (t.kind === 'image') await ocrTrack(v.page, t, opts);
    const card = v.page.locator(SELECTORS.merge);
    await card.locator(SELECTORS.mergeTop).selectOption(String(top.number));
    await card.locator(SELECTORS.mergeBottom).selectOption(String(bottom.number));
    const [tv, bv] = [await card.locator(SELECTORS.mergeTop).inputValue(), await card.locator(SELECTORS.mergeBottom).inputValue()];
    if (tv !== String(top.number) || bv !== String(bottom.number)) throw new S2LError(`The merge card kept #${tv}/#${bv} instead of #${top.number}/#${bottom.number}.`);
    await v.page.waitForSelector(`${SELECTORS.merge} ${SELECTORS.mergeOk}`, { timeout: 30000 });
    const status = (await card.locator(SELECTORS.mergeStatus).innerText()).trim();
    const dest = await clickAndSave(v.page, card.locator(SELECTORS.mergeDownload), name => outTarget(opts, v.file, name, true), opts);
    const cues = parseSubtitleFile(dest);
    log(`saved ${dest} (${status})`);
    const brief = t => ({ number: t.number, lang: t.lang, name: t.name, kind: t.kind, ...(t.ocrLang ? { ocrLang: t.ocrLang } : {}) });
    return { ok: true, command: 'merge', input: v.file, outputs: [{ path: dest, kind: 'merged', cues: cues.length, top: brief(top), bottom: brief(bottom) }], tracks: v.subs.map(publicTrack), notes };
  } finally { await session.close(); }
}

// --from/--to → the site's language values
const SITE_LANG = { auto: 'auto-detect', zh: 'zh-Hans', 'zh-cn': 'zh-Hans', 'zh-hans': 'zh-Hans', chs: 'zh-Hans', 'zh-tw': 'zh-Hant', 'zh-hk': 'zh-Hant', 'zh-hant': 'zh-Hant', cht: 'zh-Hant' };
const siteLang = v => SITE_LANG[String(v).toLowerCase()] || v;

function translateSettings(opts) {
  const notes = [];
  let levelKey = String(opts.level || 'cet4').toLowerCase();
  if (!LEVELS[levelKey] && !Object.values(LEVELS).includes(levelKey)) {
    throw new UsageError(`--level must be one of: ${Object.keys(LEVELS).filter(k => k !== 'none' && k !== '0').join(', ')}`);
  }
  const from = siteLang(opts.from || 'en'), to = siteLang(opts.to || 'zh-Hans');
  // grading checks English words only; for other source languages it would skip every line
  if (!['en', 'auto-detect'].includes(from) && LEVELS[levelKey] !== '0english') {
    notes.push(`Level grading only applies to English subtitles; translating every line (--level all) for source "${from}".`);
    levelKey = 'all';
  }
  const mode = opts.mode || 'both';
  if (!['both', 'only'].includes(mode)) throw new UsageError('--mode must be "both" (original + translation) or "only" (translation only)');
  return { levelKey, level: LEVELS[levelKey] || levelKey, from, to, mode, notes };
}

async function translateOnSite(session, srtText, uploadName, cfg, opts, destFor) {
  const bytes = Buffer.byteLength(srtText);
  if (bytes > MAX_UPLOAD_BYTES) throw new S2LError(`Subtitle is ${(bytes / 1048576).toFixed(1)} MB; the site accepts up to 5 MB.`, 'Split the file, or translate fewer lines.');

  const page = await session.newPage();
  await gotoSite(page, opts);
  const pick = async (sel, value, what) => {
    const values = await page.$$eval(`${sel} option`, os => os.map(o => o.value));
    if (!values.includes(value)) throw new UsageError(`${what} "${value}" is not offered by the site. Choose one of: ${values.filter(Boolean).join(', ')}`);
    await page.selectOption(sel, value);
  };
  await pick(SELECTORS.level, cfg.level, '--level');
  await pick(SELECTORS.from, cfg.from, '--from');
  await pick(SELECTORS.to, cfg.to, '--to');
  const dialogsBefore = session.dialogs.length;

  const stats = { graded: null, gradeRequested: false, batches: 0, lines: 0, engines: new Set(), fellBack: false, quota: false, errors: [] };
  page.on('request', r => { if (r.url().includes('sub_gen.php')) stats.gradeRequested = true; });
  page.on('response', async r => {
    const u = r.url();
    if (!u.includes('sub_gen.php') && !u.includes('trans_proxy.php')) return;
    let j = null; try { j = await r.json(); } catch { return; }
    if (u.includes('sub_gen.php')) { stats.graded = Array.isArray(j) ? j.length : null; log(`level check: ${stats.graded} line(s) are above the chosen level`); return; }
    if (j && j.ok) {
      stats.batches++; stats.lines += (j.translations || []).length; stats.engines.add(j.engine);
      if (j.fellBack) stats.fellBack = true; if (j.quota) stats.quota = true;
      log(`translated batch ${stats.batches} (${(j.translations || []).length} lines, engine ${j.engine}${j.fellBack ? ', fell back' : ''})`);
    } else stats.errors.push((j && j.error) || `HTTP ${r.status()}`);
  });

  await page.setInputFiles(SELECTORS.srtInput, { name: uploadName, mimeType: 'application/x-subrip', buffer: Buffer.from(srtText, 'utf8') });
  log(`uploading ${uploadName} (${bytes} bytes) · level ${cfg.levelKey} · ${cfg.from} → ${cfg.to}`);
  await page.locator(SELECTORS.srtSubmit).click();
  await page.waitForSelector(SELECTORS.uploadedName, { state: 'attached', timeout: 120000 });
  await page.waitForLoadState('domcontentloaded');
  if (await page.locator(SELECTORS.rowError).count()) throw new S2LError(`The site rejected the file: ${(await page.locator(SELECTORS.rowError).first().innerText()).trim()}`);
  const rows = await page.locator(SELECTORS.rows).count();
  if (!rows) throw new S2LError('The site found no subtitle blocks in this file.', 'Make sure it is a valid SRT (index line, "hh:mm:ss,mmm --> hh:mm:ss,mmm", text).');

  // the page auto-starts translating after the upload reload; nudge it only if that never happened
  for (let i = 0; i < 40 && !stats.gradeRequested; i++) await sleep(250);
  if (!stats.gradeRequested) {
    debug('auto-translate did not start; triggering it');
    await page.evaluate(sel => window.jQuery && window.jQuery(sel).trigger('click'), SELECTORS.startTranslate);
  }
  const limit = timeoutMs(opts, 20), t0 = Date.now();
  for (;;) {
    if (await page.locator(SELECTORS.downloadModal).count()) break;
    if (session.dialogs.length > dialogsBefore) throw new S2LError(`Translation failed on the site: ${session.dialogs[session.dialogs.length - 1]}`, stats.errors.length ? `Proxy said: ${stats.errors.join('; ')}` : 'Try again in a minute; the free engines occasionally refuse.');
    if (Date.now() - t0 > limit) throw new S2LError(`Translation timed out after ${Math.round(limit / 60000)} min.`, 'Raise --timeout (minutes) for very long subtitles.');
    await sleep(500);
  }
  const link = page.locator(cfg.mode === 'only' ? SELECTORS.downloadOnly : SELECTORS.downloadBoth);
  await link.waitFor({ state: 'visible', timeout: 15000 });
  const dest = await clickAndSave(page, link, destFor, opts, 120000);
  return { dest, rows, stats };
}

function countTranslated(file, mode) {
  const cues = parseSubtitleFile(file);
  const translated = mode === 'only' ? cues.filter(c => c.t).length : cues.filter(c => c.t.includes('\n')).length;
  return { cues: cues.length, translatedCues: translated, keptCues: cues.length - translated };
}

async function cmdTranslate(opts) {
  const [input] = opts._;
  if (!input) throw new UsageError('usage: translate <file.srt|.vtt|.ass|video.mkv> [--level cet4] [--from en] [--to zh-Hans] [--mode both|only] [--out FILE]');
  const file = path.resolve(input);
  if (!fs.existsSync(file)) throw new UsageError(`File not found: ${input}`);
  const ext = path.extname(file).toLowerCase();
  const cfg = translateSettings(opts);
  const notes = [...cfg.notes];
  const session = await openSession(opts);
  try {
    let srtText, uploadName, source = { input: file };
    if (VIDEO_EXT.has(ext)) {
      const v = await loadVideo(session, file, opts);
      if (!v.subs.length) throw new S2LError('This video has no embedded subtitle tracks.', 'Ask the user for a separate .srt file.');
      const spec = (opts.track && opts.track[0]) || (opts.lang && opts.lang[0]) || (cfg.from !== 'auto-detect' ? cfg.from : 'en');
      const r = resolveTrack(spec, v.subs);
      if (!r.track) throw new S2LError(`No "${spec}" subtitle track to translate.`, `Pick one with --track N. Subtitle tracks: ${v.subs.map(describeTrack).join(', ')}`);
      const t = r.track; if (r.note) notes.push(r.note);
      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 's2l-'));
      const extracted = await exportTrack(v.page, t, v.file, { ...opts, out: tmpDir, force: true }, true);
      srtText = toSrt(parseSubtitleFile(extracted.path));
      uploadName = path.basename(extracted.path).replace(/\.srt$/i, '') + '.srt';
      source = { input: file, track: t.number, lang: t.lang, name: t.name, kind: t.kind };
      await fsp.rm(tmpDir, { recursive: true, force: true });
      await v.page.close();
    } else if (SUB_EXT.has(ext)) {
      const cues = parseSubtitleFile(file);
      if (!cues.length) throw new S2LError(`No subtitle cues found in ${path.basename(file)}.`, 'Supported: SRT, WebVTT, ASS/SSA, SBV (UTF-8, UTF-16 or GB18030).');
      srtText = toSrt(cues);
      uploadName = path.basename(file, path.extname(file)) + '.srt';
      if (ext !== '.srt') notes.push(`${ext.slice(1).toUpperCase()} converted to SRT locally before upload (the site reads SRT).`);
    } else throw new UsageError(`Unsupported input ${path.basename(file)}: give a subtitle file (.srt .vtt .ass .ssa .sbv) or an .mkv/.webm video.`);

    const r = await translateOnSite(session, srtText, uploadName, cfg, opts, name => outTarget(opts, file, name, true));
    const counts = countTranslated(r.dest, cfg.mode);
    log(`saved ${r.dest} · ${counts.translatedCues}/${counts.cues} cues translated, ${counts.keptCues} left in the original`);
    if (r.stats.fellBack) notes.push('Bing was unavailable for part of the job; the site fell back to Google automatically.');
    if (r.stats.quota) notes.push('The shared daily Bing budget is used up; Google served this job.');
    return {
      ok: true, command: 'translate', source,
      outputs: [{ path: r.dest, kind: 'translated', mode: cfg.mode, level: cfg.levelKey, from: cfg.from, to: cfg.to, ...counts }],
      engines: [...r.stats.engines], notes,
    };
  } finally { await session.close(); }
}

async function cmdMergeSrt(opts) {
  const [topFile, bottomFile] = opts._;
  if (!topFile || !bottomFile) throw new UsageError('usage: merge-srt <top.srt> <bottom.srt> [--out FILE]');
  for (const f of [topFile, bottomFile]) if (!fs.existsSync(f)) throw new UsageError(`File not found: ${f}`);
  const top = parseSubtitleFile(topFile), bottom = parseSubtitleFile(bottomFile);
  if (!top.length || !bottom.length) throw new S2LError(`No cues found in ${!top.length ? topFile : bottomFile}.`);
  const merged = mergeCues(top, bottom);
  const base = path.basename(topFile, path.extname(topFile));
  const dest = uniquePath(outTarget(opts, topFile, `${base}.merged-bilingual.srt`, true), opts);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, mergedSrt(merged));
  const unmatched = merged.filter(c => !c.bottom).length;
  log(`saved ${dest} (${merged.length} cues${unmatched ? `, ${unmatched} without a bottom line` : ''})`);
  return {
    ok: true, command: 'merge-srt', outputs: [{ path: dest, kind: 'merged', cues: merged.length, unmatchedTop: unmatched }],
    notes: ['Merged locally (no browser, no network) with the same timeline rule as the site: the top file sets the timing.'],
  };
}

async function cmdSelftest(opts) {
  const checks = [];
  const check = (name, cond, detail) => { checks.push({ name, ok: !!cond, ...(!cond && detail ? { detail } : {}) }); log(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && detail ? ' — ' + detail : ''}`); };
  const sample = path.join(ASSETS, 'sample-2tracks.mkv');
  const en = parseSubtitleFile(path.join(ASSETS, 'sample.en.srt'));
  const zh = parseSubtitleFile(path.join(ASSETS, 'sample.zh.srt'));
  const dir = opts.out ? path.resolve(opts.out) : await fsp.mkdtemp(path.join(os.tmpdir(), 's2l-selftest-'));
  await fsp.mkdir(dir, { recursive: true });
  const o = { ...opts, out: dir, force: true };
  const same = (a, b) => a.length === b.length && a.every((c, i) => c.s === b[i].s && c.e === b[i].e && c.t === b[i].t);
  const t0 = Date.now();
  try {
    const tr = await cmdTracks({ ...o, _: [sample] });
    const subs = tr.tracks.filter(t => t.type === 'subtitle');
    check('tracks: 2 text subtitle tracks (eng + chi) with 6 cues each', subs.length === 2 && subs.every(t => t.kind === 'text' && t.cues === 6) && groupOf(subs[0].lang) === 'en' && groupOf(subs[1].lang) === 'zh', JSON.stringify(subs));

    const ex = await cmdExtract({ ...o, _: [sample] });
    const exEn = ex.outputs.find(x => groupOf(x.lang) === 'en'), exZh = ex.outputs.find(x => groupOf(x.lang) === 'zh');
    check('extract: both tracks match the source SRT files exactly (times + text)', exEn && exZh && same(parseSubtitleFile(exEn.path), en) && same(parseSubtitleFile(exZh.path), zh));

    const mg = await cmdMerge({ ...o, _: [sample], top: 'eng', bottom: 'zh', out: path.join(dir, 'merged.en-zh.srt') });
    const m1 = parseSubtitleFile(mg.outputs[0].path);
    check('merge: 6 cues on the English timeline, English line above Chinese', m1.length === 6 && m1.every((c, i) => c.s === en[i].s && c.e === en[i].e && c.t === `${en[i].t}\n${zh[i].t}`), JSON.stringify(m1[0]));

    const sw = await cmdMerge({ ...o, _: [sample], top: 'chi', bottom: 'en', out: path.join(dir, 'merged.zh-en.srt') });
    const m2 = parseSubtitleFile(sw.outputs[0].path);
    check('merge (swapped): Chinese timeline and Chinese line on top', m2.length === 6 && m2.every((c, i) => c.s === zh[i].s && c.t === `${zh[i].t}\n${en[i].t}`), JSON.stringify(m2[0]));

    const ms = await cmdMergeSrt({ ...o, _: [path.join(ASSETS, 'sample.en.srt'), path.join(ASSETS, 'sample.zh.srt')], out: path.join(dir, 'local.merged.srt') });
    // the site keeps the CRLF that Matroska text cues carry inside multi-line cues; compare with LF
    const lf = f => fs.readFileSync(f, 'utf8').replace(/\r\n?/g, '\n');
    check('merge-srt: local merge equals the site\'s merge (byte-identical after LF normalisation)', lf(ms.outputs[0].path) === lf(mg.outputs[0].path));

    if (opts['with-ocr']) {
      const pgs = path.join(ASSETS, 'sample-pgs.mkv');
      const want = [[1000, 3200, 'Good morning! Did you sleep well?'], [9600, 12400, 'The quarterly forecast looks surprisingly optimistic.'], [15300, 17500, 'Fair enough. See you at the elevator.']];
      const words = s => s.toLowerCase().match(/[a-z']+/g) || [];
      const close = (got, exp) => { const g = new Set(words(got)), e = words(exp); return e.filter(w => g.has(w)).length / e.length >= 0.8; };
      const ox = await cmdExtract({ ...o, _: [pgs], track: ['2'] });
      const ocr = parseSubtitleFile(ox.outputs[0].path);
      check('OCR: the PGS image track becomes 3 English cues with the right times and text', ocr.length === 3 && ocr.every((c, i) => c.s === want[i][0] && c.e === want[i][1] && close(c.t, want[i][2])), JSON.stringify(ocr));
      const om = await cmdMerge({ ...o, _: [pgs], out: path.join(dir, 'merged.pgs-zh.srt') });
      const pm = parseSubtitleFile(om.outputs[0].path);
      check('merge with an image track: OCR first, then English (PGS) above Chinese', pm.length === 3 && om.outputs[0].top.kind === 'image' && pm.every(c => /[a-z]/i.test(c.t.split('\n')[0]) && /[\u4e00-\u9fff]/.test(c.t.split('\n')[1] || '')), JSON.stringify(pm));
    }
    if (opts['with-translate']) {
      const three = path.join(dir, 'three-lines.srt');
      await fsp.writeFile(three, toSrt(en.slice(2, 5)));
      const tt = await cmdTranslate({ ...o, _: [three], level: 'cet4', out: path.join(dir, 'three-lines.translated.srt') });
      const out = parseSubtitleFile(tt.outputs[0].path);
      check('translate: 3 cues, timestamps kept, at least one line translated into Chinese', out.length === 3 && out.every((c, i) => c.s === en[i + 2].s && c.e === en[i + 2].e) && out.some(c => /[一-鿿]/.test(c.t)), JSON.stringify(out));
    }
  } finally {
    if (!opts.out && !opts.keep) await fsp.rm(dir, { recursive: true, force: true });
  }
  const ok = checks.every(c => c.ok);
  return { ok, command: 'selftest', checks, seconds: Math.round((Date.now() - t0) / 1000), ...(opts.out || opts.keep ? { dir } : {}) };
}

const HELP = `sub2learn skill CLI v${VERSION} — drives https://sub2learn.com in a headless browser.

Usage: node scripts/s2l.mjs <command> [options]

Commands
  doctor                         check Node, Playwright, the browser and the site
  tracks   <video>               list the tracks of an .mkv/.webm
  extract  <video>               save subtitle tracks as SRT
           [--track N[,M]] [--lang eng,chi] [--all] [--ocr] [--ocr-lang eng|chi_sim|chi_tra|eng+chi_sim]
  merge    <video>               two tracks → one bilingual SRT (top line / bottom line)
           [--top N|lang] [--bottom N|lang]          defaults: top English, bottom Chinese
  translate <file|video>         translate only the lines above an English level
           [--level all|kindergarten|primary|middle|high|cet4|cet6] (default cet4)
           [--from en] [--to zh-Hans] [--mode both|only] [--track N|--lang eng]
  merge-srt <top.srt> <bottom.srt>   merge two subtitle files locally (no browser)
  selftest [--with-ocr] [--with-translate]   run the bundled samples end-to-end

Common options
  --out FILE.srt|DIR    where to write (default: next to the input; never overwrites without --force)
  --browser chromium|chrome|msedge   --executable-path PATH   --cdp http://127.0.0.1:9222
  --site URL            default ${DEFAULT_SITE}        --ui en|cn
  --proxy http://host:port   route the browser through a proxy
  --timeout MINUTES     per long step (read 30, OCR 120, translate 20)
  --headed  --verbose  --force

stdout: one JSON object {ok, command, outputs[], notes[] ...}; progress on stderr.
Docs: SKILL.md and references/ next to this script.`;

// ---------------------------------------------------------------- main
const COMMANDS = { doctor: cmdDoctor, tracks: cmdTracks, extract: cmdExtract, merge: cmdMerge, translate: cmdTranslate, 'merge-srt': cmdMergeSrt, selftest: cmdSelftest };

async function main() {
  let opts, command;
  try {
    opts = parseArgs(process.argv.slice(2));
    verbose = !!opts.verbose;
    if (opts.version) { process.stdout.write(VERSION + '\n'); return 0; }
    command = opts._.shift();
    if (!command || command === 'help' || opts.help) { process.stdout.write(HELP + '\n'); return command || opts.help ? 0 : 2; }
    if (!COMMANDS[command]) throw new UsageError(`Unknown command "${command}". Run "node scripts/s2l.mjs help".`);
    if (opts.ui && !['en', 'cn'].includes(opts.ui)) throw new UsageError('--ui must be en or cn');
    const result = await COMMANDS[command](opts);
    emit(result);
    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError) { emit({ ok: false, command, error: err.message }); return 2; }
    const known = err instanceof S2LError;
    emit({ ok: false, command, error: known ? err.message : String(err && err.message || err).split('\n')[0], ...(known && err.hint ? { hint: err.hint } : {}) });
    if (!known && verbose) process.stderr.write(String(err && err.stack || err) + '\n');
    return 1;
  }
}

main().then(code => process.exit(code));
