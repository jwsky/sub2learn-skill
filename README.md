# Sub2Learn Skill — let your AI agent handle movie subtitles

[![test](https://github.com/jwsky/sub2learn-skill/actions/workflows/test.yml/badge.svg)](https://github.com/jwsky/sub2learn-skill/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** · [中文](README.zh-CN.md)

An agent skill for **Claude Code, Codex and other AI agents**: they open [sub2learn.com](https://sub2learn.com) in a headless browser and use it to **extract**, **merge** and **translate** subtitles for you — including Blu-ray image subtitles (OCR) and translations that only cover the lines above your English level. It runs fine on a **Linux VPS** with no display. The video itself never leaves your machine.

## What you can ask for

| Say to your agent | What happens |
|---|---|
| "Merge the English and Chinese subtitles of `movie.mkv` into one file" | `merge` → one bilingual SRT, English on top, Chinese below, aligned on the English timing |
| "Put the Chinese line on top" | `merge --top chi --bottom eng` |
| "Get the subtitles out of `movie.mkv`" | `extract` → every text subtitle track as `.srt` |
| "The Chinese track is image subtitles, turn it into text" | `extract --track N` → local OCR of Blu-ray PGS |
| "Make a CET-4 study subtitle from `movie.en.srt`" | `translate --level cet4` → only lines above CET-4 get a Chinese line, the rest stays English for practice |
| "Translate every line into Traditional Chinese" | `translate --level all --to zh-Hant` |
| "Merge these two SRT files" | `merge-srt` (local, no browser) |

Example prompts:

- *"Use the sub2learn skill to merge the English and Simplified Chinese tracks of ~/videos/Arrival.mkv."*
- *"I'm at CET-6 level. Make me a bilingual subtitle from ~/subs/show.s01e01.en.srt that only translates what I probably don't know."*
- *"List the subtitle tracks of movie.mkv, OCR the PGS English track and merge it with the Chinese one."*

## Install

### Claude Code

Plugin marketplace (inside Claude Code):

```text
/plugin marketplace add jwsky/sub2learn-skill
/plugin install sub2learn@sub2learn-skill
```

Or with the installer (also runs the setup below):

```bash
curl -fsSL https://raw.githubusercontent.com/jwsky/sub2learn-skill/main/install.sh | bash -s -- --claude
```

### Codex

Ask Codex — its built-in skill installer handles it:

```text
Install the skill from https://github.com/jwsky/sub2learn-skill/tree/main/skills/sub2learn
```

Or: `curl -fsSL https://raw.githubusercontent.com/jwsky/sub2learn-skill/main/install.sh | bash -s -- --codex`

### Any other agent

```bash
git clone --depth 1 https://github.com/jwsky/sub2learn-skill.git
cd sub2learn-skill/skills/sub2learn && bash scripts/setup.sh
```

Then tell the agent: *"Read sub2learn-skill/skills/sub2learn/SKILL.md and follow it."*

The skill checks itself on first use (`doctor`) and runs `scripts/setup.sh` when the browser or the npm package is missing, so a plugin or skill-installer install needs no extra step.

## Requirements

| | |
|---|---|
| Node.js | 20 or newer (Playwright 1.63 requires it) |
| Browser | Playwright's Chromium (default; x86_64 and ARM64) **or** Google Chrome / Edge / distro Chromium |
| OS | Linux, servers included (tested: Ubuntu 24.04 ARM64, Ubuntu x86_64 in CI). Headless — no display needed; running as root is fine. macOS should work the same way but is not tested. |
| Memory | ~400 MB for extract/merge/translate, ~550 MB+ with OCR (measured on the bundled samples); plan 1 GB, 2 GB for OCR |
| Disk | ~650 MB for Playwright's Chromium (~270 MB with `--shell-only`) |
| Network | access to `https://sub2learn.com` |

Linux VPS notes:

- **Debian / Ubuntu** — `bash scripts/setup.sh` as root (or with sudo) installs Chromium *and* its system libraries.
- **RHEL / Alma / Rocky / CentOS Stream** — easiest is Google Chrome's RPM (it pulls every dependency), then use `--browser chrome`:
  `sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm && bash scripts/setup.sh --browser none`
- **ARM64** (Ampere, Graviton…) — use the default Playwright Chromium; the skill is developed on an ARM64 Ubuntu VPS.
- Already have Chrome running with `--remote-debugging-port`? Use `--cdp http://127.0.0.1:9222`.

More: [skills/sub2learn/references/vps-setup.md](skills/sub2learn/references/vps-setup.md)

## How it works

```
 your agent ──► node scripts/s2l.mjs merge movie.mkv
                     │  Playwright starts headless Chromium / Chrome
                     ▼
              https://sub2learn.com  (the ordinary public page)
                     │
   MKV/WebM ─────────┤ the page's Web Worker streams the file from your disk
   (stays local)     │ (File API), keeps only subtitle packets, OCRs PGS images
                     │ with Tesseract (WASM) → track list · SRT · bilingual merge
                     │
   subtitle text ────┤ "translate" uploads the SRT text; the site marks lines above
   (translate only)  │ your level and translates just those (Bing, Google fallback)
                     ▼
              downloads saved next to your file (or --out)
```

Because the agent uses the same page a person would, results match the website exactly, and no ffmpeg/Tesseract installation is needed.

## Commands

Run from the skill folder (`skills/sub2learn`). Every command prints one JSON object (progress goes to stderr).

| Command | Purpose |
|---|---|
| `node scripts/s2l.mjs doctor` | check Node, Playwright, the browser and the site |
| `node scripts/s2l.mjs tracks movie.mkv` | list tracks (text / image subtitle, language, cue count) |
| `node scripts/s2l.mjs extract movie.mkv [--lang eng] [--track N] [--ocr]` | save subtitle tracks as SRT; image tracks are OCR'd |
| `node scripts/s2l.mjs merge movie.mkv [--top eng] [--bottom chi]` | two tracks → one bilingual SRT |
| `node scripts/s2l.mjs translate movie.en.srt [--level cet4] [--to zh-Hans] [--mode both\|only]` | level-graded translation (SRT, VTT, ASS/SSA, SBV or a video track) |
| `node scripts/s2l.mjs merge-srt top.srt bottom.srt` | merge two subtitle files locally |
| `node scripts/s2l.mjs selftest [--with-ocr] [--with-translate]` | end-to-end test with the bundled samples |

Levels: `all` · `kindergarten` (~1000 words) · `primary` / `middle` / `cet4` (~3000) · `high` / `cet6` (~6000).
Full reference: [skills/sub2learn/references/commands.md](skills/sub2learn/references/commands.md) · agent instructions: [skills/sub2learn/SKILL.md](skills/sub2learn/SKILL.md)

## Privacy

| Command | Leaves your machine |
|---|---|
| `tracks`, `extract`, `merge` | nothing from the video — it is read inside the local browser; OCR runs locally |
| `translate` | the subtitle text: uploaded to sub2learn.com (which keeps uploaded subtitle files); the lines to translate are sent to Bing/Google by the site |
| `merge-srt` | nothing |

## FAQ

**Is it free?** Yes. Translation uses the site's shared free Bing quota (Google takes over automatically when it runs out), so please translate one file at a time and avoid bulk loops.

**MP4 / AVI?** The site reads Matroska (`.mkv`, `.webm`) only. For other containers get the `.srt` first (for example `ffmpeg -i in.mp4 -map 0:s:0 out.srt`), then use `translate` or `merge-srt`.

**DVD (VobSub) image subtitles?** Not supported by the site yet; Blu-ray PGS is.

**How are two tracks aligned?** The top track keeps its timing; every bottom cue that overlaps a top cue is placed under it (duplicates removed). Small timing offsets between tracks are handled.

**Why a browser and not ffmpeg?** Same results as the website, no native toolchain, image-subtitle OCR included, and site improvements reach agents without updating the skill.

## Development

```bash
cd skills/sub2learn && npm ci && npx playwright install chromium
node scripts/s2l.mjs selftest --with-ocr --with-translate
python3 tools/make-samples.py      # rebuild the sample videos (needs Pillow + ffmpeg)
```

CI runs the self-test on `ubuntu-latest` with Playwright's Chromium and with the runner's Google Chrome.

## Contact

Website: [sub2learn.com](https://sub2learn.com) · Email: websitejava@outlook.com · License: [MIT](LICENSE)
