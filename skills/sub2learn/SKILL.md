---
name: sub2learn
description: "Extract, merge and translate movie subtitles with sub2learn.com by driving a headless browser (Playwright + Chromium or Google Chrome; works on a Linux VPS with no display). Use when the user wants subtitle tracks pulled out of an MKV/WebM, two tracks (e.g. English + Chinese) merged into one bilingual SRT, Blu-ray PGS image subtitles OCR'd to text, two separate subtitle files merged, or an SRT/VTT/ASS translated so that only lines above their English level (CET-4, CET-6, high school…) get a translation. The video never leaves the machine. 中文触发：字幕翻译、双语字幕、中英字幕、中英双语 SRT、提取字幕、MKV 字幕、内封字幕、合并字幕、PGS OCR、图形字幕识别、按英语水平翻译、只翻生词。"
---

# Sub2Learn subtitles (browser-driven)

This skill operates the free web tool **https://sub2learn.com** in a headless browser:

- **extract** subtitle tracks from `.mkv` / `.webm` — the page reads the file with the browser's File API, so even a 40 GB movie is never uploaded;
- **OCR** Blu-ray **PGS** image subtitles locally (Tesseract in the page);
- **merge** any two tracks into one bilingual SRT (top line / bottom line, aligned on the top track's timeline);
- **translate** a subtitle so that only lines above the learner's English level are translated (the rest stays English for practice).

Everything runs through one CLI: `node scripts/s2l.mjs <command> …` — run it **from this skill's folder** (the folder that contains this file). Each run prints **one JSON object on stdout** (progress goes to stderr) and exits `0` ok · `1` failed · `2` bad arguments.

## Step 0 — make sure it can run (once per machine)

```bash
node scripts/s2l.mjs doctor          # expect "ok": true
```

If doctor fails with "Playwright is not installed" or "No usable Chromium", run `bash scripts/setup.sh` (installs the npm dependency and Playwright's Chromium; on Debian/Ubuntu as root it also installs the system libraries). If Google Chrome is already installed you may use `bash scripts/setup.sh --browser chrome` and add `--browser chrome` to commands. Then run doctor again. Needs Node.js 20+. No desktop/display is needed; running as root is handled (`--no-sandbox` is added automatically).

## Step 1 — map the request to a command

| The user wants… | Run |
|---|---|
| to know what is inside a video | `tracks movie.mkv` |
| the subtitles out of a video as SRT | `extract movie.mkv` (all text tracks) · `extract movie.mkv --lang eng` |
| English + Chinese in one file, from one MKV | `merge movie.mkv` (defaults: English on top, Chinese below) |
| Chinese on top instead | `merge movie.mkv --top chi --bottom eng` |
| specific tracks / a particular variant | `merge movie.mkv --top 3 --bottom 5` · `--bottom zh-Hant` (Traditional) |
| image (PGS) subtitles turned into text | `extract movie.mkv --track 4` (OCR runs automatically for image tracks) |
| a learner-friendly bilingual SRT from an SRT/VTT/ASS | `translate movie.en.srt --level cet4` |
| the same, straight from the movie's English track | `translate movie.mkv --level cet4` |
| a full translation of every line | `translate movie.en.srt --level all` |
| translation only, no English lines | `translate movie.en.srt --level all --mode only` |
| two separate subtitle files merged | `merge-srt movie.en.srt movie.zh.srt` (local, no browser) |
| MP4 / AVI / MOV | not supported by the site — ask for the `.srt`, or extract it with ffmpeg first, then use `translate` / `merge-srt` |

If the user did not say which level, use `--level cet4` (the site's own suggestion) and mention that `cet6`/`high` translate less and `all` translates everything. If they did not say which language goes on top for a merge, put English on top.

## Commands

### `tracks <video>`
Lists every track. Subtitle tracks have `kind: "text"` (SRT/ASS/WebVTT, ready to use) or `kind: "image"` (PGS, needs OCR).
```json
{"ok":true,"command":"tracks","tracks":[{"number":2,"type":"subtitle","kind":"text","codec":"S_TEXT/UTF8","lang":"eng","name":"English","cues":1342}, …]}
```

### `extract <video> [--track N[,M]] [--lang eng,chi] [--all] [--ocr] [--ocr-lang …] [--out DIR]`
- default: every **text** subtitle track; image tracks are skipped with a note.
- `--lang` picks by language (`en`, `eng`, `zh`, `chi`, `zho`, `ja`, …); `--track` picks exact numbers (image tracks are OCR'd).
- `--all` = every subtitle track including images; `--ocr` = include image tracks matching the selection.
- `--ocr-lang eng | chi_sim | chi_tra | eng+chi_sim` (default from the track language).
- Files are named by the site: `movie.track3.eng.srt`, OCR results `movie.track4.eng.OCR.srt`.

### `merge <video> [--top N|lang] [--bottom N|lang] [--out FILE]`
Builds the site's bilingual SRT: each top cue keeps its own timing and gets every overlapping bottom cue underneath (duplicates removed), so slightly offset tracks still pair correctly.
- Defaults: top = English, bottom = Chinese (or whichever language is "the other one").
- When a language matches several tracks the CLI skips `Forced` tracks, prefers text over image, prefers non-SDH, honours 简/繁 hints (`zh-Hans`, `chs`, `zh-Hant`, `cht`) and otherwise takes the one with most cues. The choice is explained in `notes` — read them and tell the user if it matters.
- An image track is OCR'd first, then merged. Output: `movie.eng-chi.merged-bilingual.srt`.

### `translate <file.srt|.vtt|.ass|.ssa|.sbv | video.mkv> [--level L] [--from en] [--to zh-Hans] [--mode both|only] [--track N|--lang eng] [--out FILE]`
Runs the site's level-graded flow: upload → the site marks lines above the level → those lines are translated (Bing, automatic Google fallback) → download.
- `--level`: `all` (every line) · `kindergarten` (~1000 words) · `primary` / `middle` / `cet4` (~3000) · `high` / `cet6` (~6000). Default `cet4`.
- `--to`: `zh-Hans` (default), `zh-Hant`, `ja`, `ko`, `es`, `fr`, `de`, `ru`, `pt`, `it`, `vi`, `th`, `ar`, `en`. `--from`: `en` (default), `auto`, or one of those.
- Level grading only understands English; for another source language the CLI switches to `--level all` and says so in `notes`.
- `--mode both` (default) = original line + translation underneath; `--mode only` = translation only (lines within the level are left empty — pair it with `--level all`).
- VTT/ASS/SSA/SBV are converted to SRT locally first. A video input extracts the chosen track first (`--track`, `--lang`, default English).
- Output: `movie.en_both_languages.srt` / `movie.en_translated.srt`, plus `translatedCues` / `keptCues` counts.

### `merge-srt <top-file> <bottom-file> [--out FILE]`
Same alignment rule as `merge`, done locally in Node (no browser, no network). Accepts SRT/VTT/ASS/SSA/SBV in UTF-8, UTF-16 or GB18030.

### `doctor` · `selftest [--with-ocr] [--with-translate]`
`doctor` checks Node, Playwright, the browser and that the site's tools are present. `selftest` runs the bundled sample (`assets/sample-2tracks.mkv`) through tracks → extract → merge → merge-srt and verifies every timestamp; `--with-ocr` adds the PGS sample (OCR + merge), `--with-translate` one 3-line translation.

### Options for every command
`--out FILE.srt|DIR` (default: next to the input file; existing files are never overwritten — a ` (1)` suffix is added unless `--force`) · `--browser chromium|chrome|msedge` · `--executable-path PATH` · `--cdp http://127.0.0.1:9222` (drive an already-running Chrome on this machine) · `--proxy http://host:port` · `--timeout MINUTES` (per long step; defaults: read 30, OCR 120, translate 20) · `--site URL` · `--ui en|cn` · `--headed` · `--verbose`.

## Recipes

| Situation | Steps |
|---|---|
| MKV with English + Chinese text tracks, user wants one bilingual file | `merge movie.mkv` → done |
| MKV with only an English track, user wants a study subtitle | `translate movie.mkv --level cet4` (extracts the English track, then translates the hard lines) |
| MKV whose English track is PGS images | `translate movie.mkv --lang eng --level cet4` — OCR happens automatically; or `extract … --track N` first to review the OCR text |
| English SRT + Chinese SRT as separate files | `merge-srt movie.en.srt movie.zh.srt` |
| Result should be picked up by a media player (Jellyfin, Plex, mpv…) | pass `--out /videos/movie.zh.srt` next to `movie.mkv` (use `--force` only if the user agrees to replace an existing file) |
| Unsure which tracks exist | `tracks movie.mkv` first, then choose `--top`/`--bottom`/`--track` by number |

## Reading the result

```json
{"ok":true,"command":"merge","outputs":[{"path":"/videos/movie.eng-chi.merged-bilingual.srt","kind":"merged","cues":1342,
  "top":{"number":2,"lang":"eng","name":"English","kind":"text"},"bottom":{"number":5,"lang":"chi","name":"简体中文","kind":"text"}}],
 "notes":["top: \"en\" matched 2 tracks; picked #2 eng \"English\" (1342 cues) over #3 eng \"English (Forced)\" (12 cues)"]}
```
On failure: `{"ok":false,"error":"…","hint":"…"}` — the `hint` says what to do next. Report output paths and the `notes` to the user; for `translate`, also say how many lines were translated vs. kept in English.

## Privacy — tell the user when it matters

- `tracks`, `extract`, `merge`: the video is read **inside the local browser**; it is not uploaded anywhere. OCR also runs locally.
- `translate`: the subtitle **text** is uploaded to sub2learn.com (the site stores uploaded subtitle files) and the lines to translate are sent to Bing/Google by the site's server. Never send private material without the user's consent.
- `merge-srt`: purely local.

## Limits and etiquette

- Video: Matroska only (`.mkv`, `.webm`). MP4/AVI/MOV → get the `.srt` another way. DVD **VobSub** image subtitles cannot be OCR'd (Blu-ray PGS can).
- Reading a big file takes about one sequential read of the disk. OCR time grows with the number of subtitle images: the bundled 3-image sample takes ~3 s on a 4-core ARM64 VPS (mostly loading the OCR engine); a feature film has roughly a thousand or more, so expect minutes to tens of minutes. Raise `--timeout` for long jobs and let them run.
- Translation uses the site's **shared free Bing budget** (about 2,000 translation requests per day across all users, then Google takes over automatically); one upload may be up to 5 MB. Translate **one file at a time**, prefer a level over `all` (fewer lines), and never loop or retry in bulk. If a translation fails, wait a minute before one retry.
- Image tracks need OCR before they can be merged or translated — this happens automatically.

## When something goes wrong

| Symptom | Fix |
|---|---|
| `Playwright is not installed` / `No usable Chromium or Google Chrome` | `bash scripts/setup.sh` (or `--browser chrome` if Chrome exists) |
| `error while loading shared libraries` when launching | Debian/Ubuntu: `sudo npx playwright install-deps chromium`; RHEL/Alma/Rocky: install Google Chrome's RPM and use `--browser chrome` (see references/vps-setup.md) |
| `Cannot open https://sub2learn.com/…` | no network/DNS from this machine; check `curl -I https://sub2learn.com` |
| `doesn't look like an MKV / WebM file` | the file is MP4/AVI or damaged — ask for the `.srt` |
| `has no embedded subtitle tracks` | subtitles are burned into the picture or shipped separately — ask for the `.srt` |
| `Merging needs two subtitle tracks` | extract the one track, get the other language as a file, then `merge-srt` |
| `cannot be OCR'd` | VobSub image track — not supported |
| `timed out` | raise `--timeout` (minutes); large files and OCR are slow on small machines |
| `Translation failed on the site` | free engine refused; wait a minute, retry once; otherwise try later |
| `tool elements were not found` | the site changed; update the skill (re-run `install.sh`, `claude plugin update sub2learn@sub2learn-skill`, or `git pull`) |

More detail: [references/commands.md](references/commands.md) · [references/vps-setup.md](references/vps-setup.md) · [references/how-it-works.md](references/how-it-works.md) · [references/troubleshooting.md](references/troubleshooting.md).
