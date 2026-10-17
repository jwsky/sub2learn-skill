#!/usr/bin/env bash
# Prepare the sub2learn skill: npm dependency (Playwright) + a browser it can drive.
#
#   bash scripts/setup.sh                    # Playwright's Chromium (+ system libraries on Debian/Ubuntu as root/sudo)
#   bash scripts/setup.sh --browser chrome   # use Google Chrome (installs it on Debian/Ubuntu x86_64)
#   bash scripts/setup.sh --browser none     # npm dependency only (you bring the browser)
#   bash scripts/setup.sh --shell-only       # headless shell only (~270 MB instead of ~650 MB; no --headed)
#   bash scripts/setup.sh --no-deps          # never touch system packages (no apt), browser files only
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BROWSER=chromium
SHELL_ONLY=()
SYSTEM_DEPS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --shell-only) SHELL_ONLY=(--only-shell); shift ;;
    --no-deps) SYSTEM_DEPS=0; shift ;;
    --browser) BROWSER="${2:-}"; shift 2 ;;
    --browser=*) BROWSER="${1#*=}"; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "setup.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
case "$BROWSER" in chromium|chrome|none) ;; *) echo "setup.sh: --browser must be chromium, chrome or none" >&2; exit 2 ;; esac

say() { printf '\033[1;35m[sub2learn]\033[0m %s\n' "$*"; }
can_sudo() { [ "$(id -u)" -eq 0 ] || sudo -n true 2>/dev/null; }

# 1. Node.js 20+ (Playwright 1.63 requires it)
if ! command -v node >/dev/null 2>&1; then
  say "Node.js 20+ is required but not installed."
  say "  Debian/Ubuntu: https://github.com/nodesource/distributions  ·  any OS: https://github.com/nvm-sh/nvm"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Node.js $(node -v) is too old; install Node.js 20 or newer."; exit 1
fi
say "Node.js $(node -v) · $(uname -sm)"

# 2. npm dependency (pinned in package-lock.json)
cd "$SKILL_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
else
  npm install --omit=dev --no-audit --no-fund --loglevel=error
fi
say "Playwright $(node -p 'require("./node_modules/playwright/package.json").version') installed"

# 3. Browser
DOCTOR_ARGS=()
case "$BROWSER" in
  chromium)
    if [ "$SYSTEM_DEPS" -eq 1 ] && [ -f /etc/debian_version ] && can_sudo; then
      say "Installing Chromium + system libraries (apt)…"
      npx --no-install playwright install --with-deps "${SHELL_ONLY[@]+"${SHELL_ONLY[@]}"}" chromium
    else
      say "Installing Chromium…"
      npx --no-install playwright install "${SHELL_ONLY[@]+"${SHELL_ONLY[@]}"}" chromium
      if [ -f /etc/debian_version ]; then
        say "If the browser fails to start, install its libraries as root:  sudo npx playwright install-deps chromium"
      elif [ -f /etc/redhat-release ]; then
        say "RHEL-family system: if Chromium misses libraries, the easiest fix is Google Chrome's RPM:"
        say "  sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm && bash scripts/setup.sh --browser none"
      fi
    fi
    ;;
  chrome)
    if command -v google-chrome >/dev/null 2>&1 || command -v google-chrome-stable >/dev/null 2>&1 || [ -x /opt/google/chrome/chrome ]; then
      say "Google Chrome found: $( (google-chrome --version || google-chrome-stable --version || /opt/google/chrome/chrome --version) 2>/dev/null | head -1)"
    elif [ "$SYSTEM_DEPS" -eq 0 ]; then
      say "Google Chrome is not installed and --no-deps forbids installing packages; install Chrome yourself or use --browser chromium."; exit 1
    elif [ "$(uname -m)" != "x86_64" ]; then
      say "Google Chrome cannot be installed automatically on $(uname -m); use the default: bash scripts/setup.sh"; exit 1
    elif [ -f /etc/redhat-release ]; then
      say "RHEL-family system: install Chrome's RPM, then re-run with --browser none:"
      say "  sudo dnf install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm"; exit 1
    elif can_sudo; then
      say "Installing Google Chrome (stable, Debian/Ubuntu)…"
      npx --no-install playwright install --with-deps chrome
    else
      say "Google Chrome is not installed and this user cannot install packages; run as root or use --browser chromium."; exit 1
    fi
    DOCTOR_ARGS=(--browser chrome)
    ;;
  none)
    say "Skipping browser installation (--browser none)."
    say "Use --browser chrome, --executable-path PATH or --cdp URL when running commands."
    exit 0
    ;;
esac

# 4. End-to-end check
say "Running doctor…"
node scripts/s2l.mjs doctor "${DOCTOR_ARGS[@]+"${DOCTOR_ARGS[@]}"}"
say "Ready. Try: node scripts/s2l.mjs selftest"
