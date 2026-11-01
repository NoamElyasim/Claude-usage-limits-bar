#!/bin/bash
# Compiles the macOS blur addon (native/backdrop-mask.mm: shape mask and strength) into
# bin/backdrop-mask.node as a universal binary, so either .dmg can carry it.
# Node-API only, so it loads in Electron whatever Node the headers came from.
# Needs the Xcode command line tools: xcode-select --install
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
inc=$(node -p "require('path').resolve(process.execPath, '../../include/node')")
xcrun clang++ -std=c++17 -ObjC++ -fobjc-arc -O2 -bundle -undefined dynamic_lookup \
  -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 \
  -I"$inc" -framework AppKit -framework QuartzCore \
  native/backdrop-mask.mm -o bin/backdrop-mask.node
codesign --force -s "${MAC_SIGN_IDENTITY:--}" bin/backdrop-mask.node
echo "built bin/backdrop-mask.node ($(lipo -archs bin/backdrop-mask.node))"
