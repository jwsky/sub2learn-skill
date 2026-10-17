# Troubleshooting

Run `node scripts/s2l.mjs doctor --verbose` first; it shows which browser was used and whether the site's tools were found.

| Message / symptom | Cause | Fix |
|---|---|---|
| `Playwright is not installed for this skill` | `node_modules` missing | `bash scripts/setup.sh` |
| `No usable Chromium or Google Chrome was found` | no browser Playwright can launch | `bash scripts/setup.sh`, or install Chrome and pass `--browser chrome`, or `--executable-path` |
| `browserType.launch: … error while loading shared libraries: libnss3.so` (or similar) | system libraries missing | Debian/Ubuntu: `sudo npx playwright install-deps chromium` (run inside the skill folder). RHEL family: install Chrome's RPM and use `--browser chrome`. |
| `Running as root without --no-sandbox is not supported` | custom launch path | the CLI adds `--no-sandbox` for root automatically; when using `--cdp`, start your Chrome with `--no-sandbox` yourself |
| `Cannot open https://sub2learn.com/…` | DNS, firewall, proxy | `curl -I https://sub2learn.com`; behind a proxy add `--proxy http://host:port` (or set `S2L_PROXY`) |
| `The site could not read this video: This doesn't look like an MKV / WebM file` | MP4/AVI/MOV or a damaged file | ask the user for the `.srt`; for MP4 with a `mov_text` track: `ffmpeg -i in.mp4 -map 0:s:0 out.srt` |
| `This video has no embedded subtitle tracks` | subtitles are burned in or separate | look for an `.srt` next to the video |
| `cannot be OCR'd … VobSub` | DVD image subtitles | not supported by the site |
| `OCR timed out` | a long film on a small CPU | `--timeout 240` and let it run; the page uses up to two OCR workers |
| `Reading the video timed out` | very large file on slow storage (network mounts, USB disks) | `--timeout 90`, or copy the file to local disk first |
| `Translation failed on the site: …` | free engine refused or rate-limited | wait a minute and retry once; do not loop |
| `Subtitle is … MB; the site accepts up to 5 MB` | huge subtitle | split the SRT, or translate with a higher level so fewer lines are sent |
| `The site loaded but its tool elements were not found` | the page changed | update the skill (`git pull`) or open an issue |
| Output file has ` (1)` in its name | a file with that name already existed | expected; pass `--force` to overwrite |
| Chinese text shows as boxes in a screenshot | missing CJK fonts | irrelevant for the CLI (no screenshots are taken); install `fonts-noto-cjk` if you take screenshots yourself |
