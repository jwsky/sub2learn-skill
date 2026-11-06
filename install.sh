#!/usr/bin/env bash
# Install (or update) the sub2learn skill for Claude Code and/or Codex.
#
#   curl -fsSL https://raw.githubusercontent.com/jwsky/sub2learn-skill/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/jwsky/sub2learn-skill/main/install.sh | bash -s -- --codex
#   bash install.sh [--claude] [--codex] [--dest DIR]... [--browser chromium|chrome|none] [--shell-only] [--no-setup]
#
# Without --claude/--codex/--dest it installs into every agent folder that exists
# (~/.claude/skills and ${CODEX_HOME:-~/.codex}/skills), or ~/.claude/skills if neither does.
# Updating keeps the skill's node_modules; everything else is replaced by the new version.
set -euo pipefail

REPO="${S2L_REPO:-jwsky/sub2learn-skill}"
REF="${S2L_REF:-main}"
TARBALL="${S2L_TARBALL:-https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF}"

say() { printf '\033[1;35m[sub2learn]\033[0m %s\n' "$*"; }
DESTS=(); SETUP_ARGS=(); DO_SETUP=1
while [ $# -gt 0 ]; do
  case "$1" in
    --claude) DESTS+=("$HOME/.claude/skills"); shift ;;
    --codex) DESTS+=("${CODEX_HOME:-$HOME/.codex}/skills"); shift ;;
    --dest) DESTS+=("${2:?--dest needs a directory}"); shift 2 ;;
    --dest=*) DESTS+=("${1#*=}"); shift ;;
    --browser) SETUP_ARGS+=(--browser "${2:?--browser needs a value}"); shift 2 ;;
    --browser=*) SETUP_ARGS+=("$1"); shift ;;
    --shell-only) SETUP_ARGS+=(--shell-only); shift ;;
    --no-setup) DO_SETUP=0; shift ;;
    -h|--help) cat <<'EOF'
Usage: install.sh [--claude] [--codex] [--dest DIR]... [--browser chromium|chrome|none] [--shell-only] [--no-setup]
  --claude      install into ~/.claude/skills/sub2learn
  --codex       install into ${CODEX_HOME:-~/.codex}/skills/sub2learn
  --dest DIR    install into DIR/sub2learn (repeatable)
  --browser     passed to scripts/setup.sh (default chromium)
  --shell-only  install only Chromium's headless shell (smaller)
  --no-setup    copy files only; run scripts/setup.sh later
EOF
      exit 0 ;;
    *) echo "install.sh: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

if [ ${#DESTS[@]} -eq 0 ]; then
  [ -d "$HOME/.claude" ] && DESTS+=("$HOME/.claude/skills")
  [ -d "${CODEX_HOME:-$HOME/.codex}" ] && DESTS+=("${CODEX_HOME:-$HOME/.codex}/skills")
  [ ${#DESTS[@]} -eq 0 ] && DESTS+=("$HOME/.claude/skills")
fi

# Source: this checkout if install.sh runs from one, otherwise a fresh download of $REPO@$REF.
SRC=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$HERE/skills/sub2learn/SKILL.md" ] && SRC="$HERE/skills/sub2learn"
fi
if [ -z "$SRC" ]; then
  command -v curl >/dev/null 2>&1 || { echo "install.sh needs curl (or run it from a git clone)" >&2; exit 1; }
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  say "Downloading $REPO ($REF)…"
  curl -fsSL "$TARBALL" | tar -xz -C "$TMP"
  SRC="$(find "$TMP" -mindepth 3 -maxdepth 3 -type d -path '*/skills/sub2learn' | head -n 1)"
  [ -n "$SRC" ] && [ -f "$SRC/SKILL.md" ] || { echo "install.sh: skills/sub2learn not found in the download" >&2; exit 1; }
fi

for base in "${DESTS[@]}"; do
  target="${base%/}/sub2learn"
  if [ -n "$(ls -A "$target" 2>/dev/null)" ] && ! grep -qs '^name: sub2learn$' "$target/SKILL.md"; then
    echo "install.sh: $target exists but is not the sub2learn skill — leaving it untouched." >&2; exit 1
  fi
  mkdir -p "$target"
  source_real="$(cd "$SRC" && pwd -P)"
  target_real="$(cd "$target" && pwd -P)"
  if [ "$source_real" = "$target_real" ]; then
    say "Already using this checkout → $target (source files kept)"
    if [ "$DO_SETUP" -eq 1 ]; then
      bash "$target/scripts/setup.sh" "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}"
    fi
    continue
  fi
  case "$target_real/" in
    "$source_real/"*) echo "install.sh: destination is inside the skill source — leaving it untouched." >&2; exit 1 ;;
  esac
  # replace our own files, keep node_modules so an update does not re-download anything
  for item in "$target"/* "$target"/.[!.]*; do
    [ -e "$item" ] || continue
    [ "$(basename "$item")" = node_modules ] && continue
    rm -rf -- "$item"
  done
  (cd "$SRC" && tar --exclude=./node_modules -cf - .) | (cd "$target" && tar -xf -)
  say "Installed → $target"
  if [ "$DO_SETUP" -eq 1 ]; then
    bash "$target/scripts/setup.sh" "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}"
  fi
done

say "Done. Start a new agent session and ask, for example:"
say "  \"Merge the English and Chinese subtitles of ~/videos/movie.mkv into one bilingual SRT\""
