# Command reference

All commands: `node scripts/s2l.mjs <command> [arguments] [options]`, run from the skill folder.
stdout = one JSON object; stderr = progress lines prefixed `[s2l]`. Exit code `0` ok, `1` failed, `2` usage error.

## Global options

| Option | Default | Meaning |
|---|---|---|
| `--out FILE.srt` / `--out DIR` | next to the input file | Where to write. A `.srt` path is only allowed when the command writes one file. |
| `--force` | off | Overwrite an existing output. Without it, `name (1).srt`, `name (2).srt`… are used. |
| `--browser chromium\|chrome\|msedge` | Playwright's Chromium | `chrome` / `msedge` use the system-installed browser through Playwright channels. |
| `--executable-path PATH` | — | Any Chromium-based browser binary (also `S2L_CHROME=PATH`). |
| `--cdp URL` | — | Connect to a running Chrome started with `--remote-debugging-port` (also `S2L_CDP_URL`). The browser must be on the same machine because the video is handed over by file path. Only a private context is opened and closed; the browser keeps running. |
| `--proxy URL` | — | Send the browser's traffic through an HTTP/SOCKS proxy (also `S2L_PROXY`). Not used with `--cdp`. |
| `--site URL` | `https://sub2learn.com/` | Another deployment, e.g. a staging copy (also `S2L_SITE`). |
| `--ui en\|cn` | `en` | Interface language of the page. Output file names follow it (`.merged-bilingual.srt` vs `.双语合并.srt`). |
| `--timeout MINUTES` | read 30 · OCR 120 · translate 20 | Upper bound for each long step. |
| `--headed` | off | Show the browser window (needs a display). |
| `--verbose` | off | Page errors and stack traces on stderr. |

When no browser option is given the CLI tries, in order: Playwright's Chromium → Google Chrome (`channel chrome`) → `/usr/bin/google-chrome(-stable)`, `/opt/google/chrome/chrome`, `/usr/bin/chromium(-browser)`, `/snap/bin/chromium`, the macOS Chrome app.

## `doctor`

Checks Node ≥ 20, the Playwright package, launches the browser and opens the site, verifying that the MKV extractor and the subtitle form exist.

```json
{"ok":true,"command":"doctor","node":"v22.11.0","platform":"linux x64","root":true,"playwright":"1.63.0",
 "browser":{"how":"playwright chromium","version":"…"},
 "site":{"url":"https://sub2learn.com/?force=global","title":"…","mkvExtractor":true,"subtitleForm":true}}
```

## `tracks <video>`

```json
{"ok":true,"command":"tracks","input":"/videos/movie.mkv","subtitles":3,"tracks":[
  {"number":1,"type":"video","kind":null,"codec":"V_MPEGH/ISO/HEVC","lang":"und","name":"","cues":null,"frames":null},
  {"number":3,"type":"subtitle","kind":"text","codec":"S_TEXT/UTF8","lang":"eng","name":"English","cues":1342,"frames":null},
  {"number":4,"type":"subtitle","kind":"image","codec":"S_HDMV/PGS","lang":"chi","name":"","cues":null,"frames":2710}]}
```

`frames` counts PGS packets (roughly two per subtitle: show + clear).

## `extract <video>`

| Option | Meaning |
|---|---|
| *(none)* | every text subtitle track |
| `--lang eng,chi` | tracks in these languages (aliases understood: `en`/`eng`/`english`, `zh`/`chi`/`zho`/`chs`/`cht`/`zh-Hans`/`zh-Hant`, `ja`/`jpn`, `ko`/`kor`, `es`, `fr`, `de`, `ru`, `pt`, `it`, `vi`, `th`, `ar`) |
| `--track 3,5` | exact track numbers; image tracks among them are OCR'd |
| `--ocr` | also OCR image tracks that match the selection |
| `--all` | every subtitle track, OCR'ing image tracks |
| `--ocr-lang eng\|chi_sim\|chi_tra\|eng+chi_sim` | OCR language (default: from the track language, 繁 names → `chi_tra`) |

Output entries: `{"path":"…/movie.track3.eng.srt","kind":"track","track":3,"lang":"eng","codec":"S_TEXT/UTF8","cues":1342}`; OCR results have `"kind":"ocr"` and `…OCR.srt` names.

## `merge <video>`

| Option | Meaning |
|---|---|
| `--top N\|lang` | track shown on the first line; its timing is used |
| `--bottom N\|lang` | track shown on the second line |

Omitted sides default to English (top) and Chinese (bottom); if only one side is given, the other side becomes "the other language" of the English/Chinese pair, else the first remaining track (text tracks first).

Track choice for a language: tracks named *Forced* lose, text beats image, non-SDH beats SDH, `zh-Hans`/`chs`/`sc` prefers names with 简/Simplified, `zh-Hant`/`cht`/`tc` prefers 繁/Traditional, plain `zh` prefers Simplified, then the most cues, then the lowest track number.

Alignment (identical to the site): for each top cue, collect every bottom cue whose interval overlaps it, drop duplicates, join with a newline. Top cues without a partner stay single-line.

## `translate <input>`

| Option | Default | Meaning |
|---|---|---|
| `--level` | `cet4` | `all`, `kindergarten`, `primary`, `middle`, `high`, `cet4`, `cet6` (see below) |
| `--from` | `en` | `en`, `auto` (= auto-detect), `zh-Hans`, `zh-Hant`, `ja`, `ko`, `es`, `fr`, `de`, `ru`, `pt`, `it`, `vi`, `th`, `ar` |
| `--to` | `zh-Hans` | same list without `auto`, plus `en`; `zh`, `zh-cn`, `chs` → `zh-Hans`; `zh-tw`, `zh-hk`, `cht` → `zh-Hant` |
| `--mode` | `both` | `both`: original + translation; `only`: translation only |
| `--track N` / `--lang L` | English | which track to use when the input is a video |

Levels map to the site's word-frequency lists: `kindergarten` → top 1000 words; `primary`, `middle`, `cet4` → top 3000; `high`, `cet6` → top 6000; `all` → translate every line. A line is translated when it contains at least one word outside the list (names and rare words therefore trigger a full-line translation, which is intended).

Result entry: `{"path":"…_both_languages.srt","kind":"translated","mode":"both","level":"cet4","from":"en","to":"zh-Hans","cues":1342,"translatedCues":611,"keptCues":731}` and `"engines":["bing"]`.

## `merge-srt <top> <bottom>`

Local merge of two subtitle files (SRT, WebVTT, ASS/SSA, SBV; UTF-8/UTF-16/GB18030). Output `top-name.merged-bilingual.srt`; `unmatchedTop` counts top cues with no overlapping bottom cue.

## `selftest [--with-ocr] [--with-translate] [--out DIR] [--keep]`

Runs the bundled samples (`--with-ocr`: the PGS sample through OCR and merge; `--with-translate`: one 3-line translation) and returns `{"ok":true,"checks":[{"name":"…","ok":true},…]}`. With `--out`/`--keep` the produced files are kept.
