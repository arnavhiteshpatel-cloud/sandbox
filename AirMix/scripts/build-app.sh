#!/usr/bin/env bash
# Builds AirMix.app from the Swift package (no Xcode project needed).
#
#   scripts/build-app.sh             # release build for this Mac's architecture → dist/AirMix.app
#   scripts/build-app.sh --install   # …and copy to /Applications (replacing an older copy)
#   scripts/build-app.sh --run       # …and launch it
#   UNIVERSAL=1 scripts/build-app.sh # arm64 + x86_64 (needs full Xcode)
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL=0; RUN=0
for a in "$@"; do
  case "$a" in
    --install) INSTALL=1 ;;
    --run) RUN=1 ;;
    *) echo "unknown option $a"; exit 2 ;;
  esac
done

ARCH_FLAGS=()
if [[ "${UNIVERSAL:-0}" == "1" ]]; then ARCH_FLAGS=(--arch arm64 --arch x86_64); fi

echo "▸ Building (release)…"
swift build -c release --product AirMix ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"}
BIN_DIR="$(swift build -c release --product AirMix ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --show-bin-path)"

APP="dist/AirMix.app"
echo "▸ Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/AirMix" "$APP/Contents/MacOS/AirMix"
cp Resources/Info.plist "$APP/Contents/Info.plist"
if command -v iconutil >/dev/null; then
  iconutil -c icns Resources/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
fi
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "▸ Signing (ad-hoc)…"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --verbose=1 "$APP"

echo "✓ Built $(pwd)/$APP"

if [[ $INSTALL == 1 ]]; then
  echo "▸ Installing to /Applications"
  if pgrep -x AirMix >/dev/null; then osascript -e 'quit app "AirMix"' || true; sleep 1; fi
  rm -rf /Applications/AirMix.app
  ditto "$APP" /Applications/AirMix.app
  APP="/Applications/AirMix.app"
  echo "✓ Installed $APP"
fi
if [[ $RUN == 1 ]]; then open "$APP"; fi
