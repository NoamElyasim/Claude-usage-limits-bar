#!/bin/bash
# Builds the macOS app for this Mac's architecture and installs it into
# /Applications. The build is ad-hoc signed: Electron's own Apple signature on
# older releases has been revoked, and macOS kills (and XProtect removes) a
# binary carrying it, so an unsigned-but-untouched copy will not launch.
set -euo pipefail
cd "$(dirname "$0")/.."

arch=$(uname -m)                       # arm64 or x86_64
[ "$arch" = x86_64 ] && arch=x64
name="Claude Usage Limits Bar"
out="dist/mac$([ "$arch" = arm64 ] && echo -arm64)/$name.app"

npx electron-builder --mac dir "--$arch"
codesign --force --deep -s - "$out"

pkill -x "$name" 2>/dev/null || true
rm -rf "/Applications/$name.app"
ditto "$out" "/Applications/$name.app"
open "/Applications/$name.app"
echo "installed /Applications/$name.app"
