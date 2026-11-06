#!/usr/bin/env bash
# Scan all Git refs and current files. Reports redact secret values completely.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=8.30.1
case "$(uname -sm)" in
  'Linux x86_64') ARCH=x64; SHA=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  'Linux aarch64'|'Linux arm64') ARCH=arm64; SHA=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) echo 'This helper supports Linux x86_64/ARM64. Elsewhere install Gitleaks and run: gitleaks git --log-opts=--all --redact=100' >&2; exit 2 ;;
esac
SCAN_TEMP="$(mktemp -d)"
trap 'rm -rf "$SCAN_TEMP"' EXIT
ARCHIVE="gitleaks_${VERSION}_linux_${ARCH}.tar.gz"
curl -fsSL --retry 2 "https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${ARCHIVE}" -o "$SCAN_TEMP/$ARCHIVE"
printf '%s  %s\n' "$SHA" "$SCAN_TEMP/$ARCHIVE" | sha256sum --check --status
tar -xzf "$SCAN_TEMP/$ARCHIVE" -C "$SCAN_TEMP" gitleaks
"$SCAN_TEMP/gitleaks" git "$ROOT_DIR" --log-opts=--all --redact=100 --no-banner
"$SCAN_TEMP/gitleaks" dir "$ROOT_DIR" --redact=100 --no-banner
