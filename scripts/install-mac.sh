#!/bin/bash
# Builds the macOS app for this Mac's architecture and installs it into
# /Applications. The build is re-signed locally: Electron's own Apple signature
# on older releases has been revoked, and macOS kills (and XProtect removes) a
# binary carrying it, so an unsigned-but-untouched copy will not launch.
#
# Signing identity: $MAC_SIGN_IDENTITY, else a keychain certificate named
# "Claude Usage Bar Local Signing" if one exists, else ad-hoc. Prefer a
# certificate — Screen Recording permission is tied to the signature, and an
# ad-hoc one changes on every build, so each rebuild has to be granted again.
set -euo pipefail
cd "$(dirname "$0")/.."

arch=$(uname -m)                       # arm64 or x86_64
[ "$arch" = x86_64 ] && arch=x64
name="Claude Usage Limits Bar"
out="dist/mac$([ "$arch" = arm64 ] && echo -arm64)/$name.app"

SIGN_ID=${MAC_SIGN_IDENTITY:-}
if [ -z "$SIGN_ID" ] && security find-identity -p codesigning | grep -q "Claude Usage Bar Local Signing"; then
  SIGN_ID="Claude Usage Bar Local Signing"
fi
SIGN_ID=${SIGN_ID:--}
export MAC_SIGN_IDENTITY=$SIGN_ID

bash scripts/build-glass-capture.sh
npx electron-builder --mac dir "--$arch"
codesign --force --deep -s "$SIGN_ID" "$out"

pkill -x "$name" 2>/dev/null || true
rm -rf "/Applications/$name.app"
ditto "$out" "/Applications/$name.app"
open "/Applications/$name.app"
echo "installed /Applications/$name.app"
