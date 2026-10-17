# How it works

```
 you / the agent
      │  node scripts/s2l.mjs merge movie.mkv --top eng --bottom chi
      ▼
 s2l.mjs (Node + Playwright)
      │  starts headless Chromium / Chrome (or attaches over CDP)
      ▼
 https://sub2learn.com  ── the normal public page, nothing special for bots
      │
      ├─ MKV/WebM overlay ── <input type=file> receives the local path
      │     │  the page's Web Worker streams the file through the File API,
      │     │  parses Matroska (EBML), keeps only subtitle packets,
      │     │  decodes PGS bitmaps and OCRs them with Tesseract (WASM) when asked
      │     ▼
      │   track table · per-track SRT buttons · bilingual merge card
      │
      └─ subtitle form ── SRT text is uploaded → sub_gen.php marks lines above the level
            → trans_proxy.php translates those lines (Bing, Google fallback) → SRT download
      ▼
 downloads are captured by Playwright and saved next to your file (or --out)
```

## What leaves the machine

| Command | Network traffic |
|---|---|
| `tracks`, `extract`, `merge` | the page itself and, for OCR, the Tesseract files under `/tess/`. **The video is not uploaded** — Chromium reads it from disk inside the sandboxed page. |
| `translate` | the subtitle text (uploaded to the site, which keeps the file) and the lines to translate (sent by the site's server to Bing/Google). |
| `merge-srt` | none |

## Why a browser instead of ffmpeg?

- The same code path the website uses: results are identical to what a person gets by clicking, and improvements on the site reach agents without updating this skill.
- No native toolchain: nothing but Node and a browser — which also works on ARM64 VPSs and locked-down machines.
- Image subtitles (Blu-ray PGS) are OCR'd in the page, so no Tesseract installation is needed.
- Level-graded translation (only the lines above the learner's level) is a site feature.

## Merge rule

The top track defines the timeline. For each top cue the bottom cues whose time ranges overlap it are collected (`bottom.end > top.start` and `bottom.start < top.end`), duplicates removed, and placed under the top text. Bottom cues that overlap no top cue are dropped, top cues with no partner stay one line. This keeps the timing stable when the two tracks were timed separately (offsets of a few hundred milliseconds are common).

## Robustness

- All page hooks are listed once in `SELECTORS` at the top of `scripts/s2l.mjs`; `doctor` fails loudly if the page layout changes.
- Waits are condition-based (result table appears, OCR button replaced by a download button, download modal opens) with generous timeouts and progress lines on stderr.
- Site alerts (`alert()`) are captured and turned into errors instead of hanging.
- Existing files are never overwritten unless `--force`.
