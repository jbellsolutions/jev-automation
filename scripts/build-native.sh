#!/bin/sh
# Builds the macOS helpers the companion spawns. Binaries are gitignored.
set -e
cd "$(dirname "$0")/.."
echo "building native/jev-speech/jev-speech"
# The embedded Info.plist carries the speech-recognition usage description TCC insists on, even for a CLI.
swiftc -O -framework Speech -framework AVFoundation \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker native/jev-speech/Info.plist \
  -o native/jev-speech/jev-speech native/jev-speech/main.swift 2>&1 | grep "error:" && exit 1
# re-sign so the signature's identifier and Info.plist slot match the embedded plist
codesign -f -s - -i com.jev.speech native/jev-speech/jev-speech 2>/dev/null
echo "ok"
