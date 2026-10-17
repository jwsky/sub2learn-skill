# Running on a Linux server / VPS

The skill only needs **Node.js 20+** and **one Chromium-based browser** that Playwright can start in headless mode. No desktop, X server or GPU is required, and nothing listens on a port.

## Quick path

```bash
cd <skill folder>                 # e.g. ~/.claude/skills/sub2learn
bash scripts/setup.sh             # npm ci + Playwright Chromium (+ system libraries on Debian/Ubuntu as root/sudo)
node scripts/s2l.mjs doctor       # "ok": true
node scripts/s2l.mjs selftest     # end-to-end check with the bundled sample
```

## Choosing the browser

| Option | Install | Use |
|---|---|---|
| Playwright Chromium (default) | `bash scripts/setup.sh` | nothing extra |
| Google Chrome already on the box | `bash scripts/setup.sh --browser none` | add `--browser chrome` |
| Google Chrome, not installed yet (Debian/Ubuntu x86_64, root or sudo) | `bash scripts/setup.sh --browser chrome` | add `--browser chrome` |
| Distro Chromium (`apt install chromium`, snap…) | `bash scripts/setup.sh --browser none` | found automatically, or `--executable-path /usr/bin/chromium` |
| A Chrome you started yourself with `--remote-debugging-port=9222` | — | `--cdp http://127.0.0.1:9222` |

Playwright's Chrome installer only supports Debian/Ubuntu on x86_64. On ARM64 servers (Ampere, Graviton…) use Playwright's Chromium, which ships ARM64 builds — this skill is developed and tested on an ARM64 Ubuntu VPS that way.

## Distribution notes

**Debian / Ubuntu** — `setup.sh` runs `npx playwright install --with-deps chromium` when it is root or has password-less sudo; that apt-installs the libraries Chromium needs (`libnss3`, `libatk-bridge2.0-0`, `libgbm1`, `libasound2`…). Without root it installs the browser only and prints the command to run later: `sudo npx playwright install-deps chromium`.

**RHEL / Alma / Rocky / CentOS Stream / Fedora** — Playwright's `--with-deps` does not support these. The simplest route is Google Chrome's RPM, which pulls in every dependency:

```bash
sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm
bash scripts/setup.sh --browser none
node scripts/s2l.mjs doctor --browser chrome
```

Alternatively install Playwright's Chromium and add the libraries yourself (`nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib`).

**Alpine (musl)** — Playwright's browsers are built for glibc. Use the distro browser (`apk add chromium`, then `--executable-path "$(command -v chromium || command -v chromium-browser)"`) or a Debian-based container.

**Node.js** — 20 or newer (required by Playwright 1.63). Ubuntu's archive version may be old; NodeSource or `nvm` give a current LTS.

## Running as root

Chromium refuses to start as root unless its sandbox is disabled. The CLI adds `--no-sandbox` automatically when it runs as root, which is the usual situation on a VPS. If you prefer a non-root user, nothing needs to change.

## Resources

Measured on a 4-core ARM64 Ubuntu VPS with the bundled samples (Node + headless browser, proportional set size):

| Task | Peak memory | Time |
|---|---|---|
| `doctor`, `tracks`, `extract`, `merge` of text tracks | ~400 MB | a few seconds + about one sequential read of the video |
| PGS OCR (two Tesseract workers in the page) | ~550 MB for the sample; more for a feature film's worth of images | grows with the number of subtitle images |
| `translate` | about the same as extract (one page) | seconds to minutes (network) |

Plan on 1 GB of free RAM for extract/merge/translate and 2 GB when OCR is involved. Reading a large MKV keeps memory flat: the page streams the file and keeps only subtitle packets.

Disk: `bash scripts/setup.sh` installs Playwright's Chromium and its headless shell (~650 MB in `~/.cache/ms-playwright`). Servers that never need a visible window can use `bash scripts/setup.sh --shell-only` (~270 MB).

## Network

The machine must reach `https://sub2learn.com` (the page, and `/tess/` for OCR files). Translation requests go from the browser to sub2learn.com, which talks to Bing/Google itself — so the VPS does not need direct access to Google.

## Headless or not

Default is headless. `--headed` shows the browser and needs a display (`DISPLAY`, or `xvfb-run node scripts/s2l.mjs … --headed`). There is no benefit on a server.
