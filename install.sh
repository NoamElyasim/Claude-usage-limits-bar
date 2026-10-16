#!/bin/bash
# One-line install (or update) for macOS:
#
#   curl -fsSL https://raw.githubusercontent.com/NoamElyasim/Claude-usage-limits-bar/master/install.sh | bash
#
# Downloads the latest release's .dmg for this Mac, copies the app into
# /Applications and opens it. The build is not notarized by Apple, so a .dmg
# downloaded in a browser is quarantined and Gatekeeper blocks it until it is
# approved in System Settings. A file fetched with curl carries no quarantine,
# so this route installs with nothing to approve except Screen Recording.
set -euo pipefail

REPO="NoamElyasim/Claude-usage-limits-bar"
NAME="Claude Usage Limits Bar"

[ "$(uname -s)" = Darwin ] || { echo "This installer is for macOS." >&2; exit 1; }

urls=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
  grep -o '"browser_download_url": *"[^"]*\.dmg"' | sed 's/.*"\(https[^"]*\)"$/\1/')
if [ "$(uname -m)" = arm64 ]; then
  url=$(printf '%s\n' "$urls" | grep -- '-arm64\.dmg$' | head -1)
else
  url=$(printf '%s\n' "$urls" | grep -v -- '-arm64\.dmg$' | head -1)
fi
[ -n "$url" ] || { echo "No .dmg found in the latest release of $REPO." >&2; exit 1; }

tmp=$(mktemp -d)
mnt=""
cleanup() { [ -n "$mnt" ] && hdiutil detach -quiet "$mnt" 2>/dev/null; rm -rf "$tmp"; }
trap cleanup EXIT

echo "Downloading ${url##*/}…"
curl -fL --progress-bar "$url" -o "$tmp/app.dmg"

mnt=$(hdiutil attach -nobrowse -readonly "$tmp/app.dmg" | awk -F'\t' '/\/Volumes\//{print $NF; exit}')
[ -d "$mnt/$NAME.app" ] || { echo "The .dmg does not contain $NAME.app." >&2; exit 1; }

# Replace a running copy rather than leaving the old version on screen.
pkill -x "$NAME" 2>/dev/null && sleep 1 || true
rm -rf "/Applications/$NAME.app"
ditto "$mnt/$NAME.app" "/Applications/$NAME.app"
xattr -dr com.apple.quarantine "/Applications/$NAME.app" 2>/dev/null || true

open "/Applications/$NAME.app"
cat <<MSG

Installed /Applications/$NAME.app and started it.
  1. Sign in to Claude in the window that opens (use the email code).
  2. Allow Screen Recording when macOS asks — it is what the glass refracts.
     (System Settings → Privacy & Security → Screen & System Audio Recording)
After an update, macOS may ask for Screen Recording again.
MSG
