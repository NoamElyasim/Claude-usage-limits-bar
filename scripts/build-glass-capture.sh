#!/bin/bash
# Compiles the macOS glass capture helper (native/glass-capture.swift) into
# bin/glass-capture as a universal binary, so either .dmg can carry it.
# Needs the Xcode command line tools: xcode-select --install
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macos13" \
    native/glass-capture.swift -o "$tmp/glass-capture-$arch"
done
lipo -create "$tmp"/glass-capture-* -output bin/glass-capture
codesign --force -s "${MAC_SIGN_IDENTITY:--}" bin/glass-capture
echo "built bin/glass-capture ($(lipo -archs bin/glass-capture))"
