#!/bin/bash
# Builds DragShelf.app (and optionally a DMG) with the Swift command-line tools.
#
#   scripts/build-app.sh            # build/DragShelf.app
#   scripts/build-app.sh --dmg      # + build/DragShelf.dmg
#   scripts/build-app.sh --test     # run unit tests + the AppKit self-test as well
#   scripts/build-app.sh --install  # copy to /Applications (or ~/Applications) and launch
#
# Needs only Apple's free Command Line Tools (xcode-select --install); full Xcode is optional.
set -euo pipefail
cd "$(dirname "$0")/.."

DMG=0; TEST=0; INSTALL=0; SELFTEST_FAILED=0
for arg in "$@"; do
  case "$arg" in
    --dmg) DMG=1 ;;
    --test) TEST=1 ;;
    --install) INSTALL=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname)" != "Darwin" ]]; then
  echo "DragShelf.app can only be built on macOS." >&2
  exit 1
fi

echo "==> Swift: $(swift --version 2>&1 | head -1)"

if [[ $TEST == 1 ]]; then
  echo "==> Unit tests (DragShelfCore)"
  if ! swift test 2>&1 | tee build-tests.log; then
    if grep -q "no such module 'XCTest'" build-tests.log; then
      echo "    (XCTest is not part of the Command Line Tools on this Mac — skipped; CI runs them on Linux.)"
    else
      echo "Unit tests failed." >&2; exit 1
    fi
  fi
  rm -f build-tests.log
fi

echo "==> Building release binary"
swift build -c release --product DragShelf
BIN_DIR="$(swift build -c release --show-bin-path)"

APP="build/DragShelf.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/DragShelf" "$APP/Contents/MacOS/DragShelf"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "==> Signing (ad-hoc — no Apple developer account needed)"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --verbose=1 "$APP"

echo "==> Built $APP ($(du -sh "$APP" | cut -f1))"

if [[ $TEST == 1 ]]; then
  echo "==> AppKit self-test"
  if ! "$APP/Contents/MacOS/DragShelf" --selftest --out build/selftest.json; then
    echo "WARNING: the self-test reported failures (details above and in build/selftest.json)." >&2
    SELFTEST_FAILED=3
  fi
fi

if [[ $DMG == 1 ]]; then
  echo "==> Creating DMG"
  STAGE="$(mktemp -d)"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"
  rm -f build/DragShelf.dmg
  hdiutil create -volname "DragShelf" -srcfolder "$STAGE" -ov -format UDZO build/DragShelf.dmg >/dev/null
  rm -rf "$STAGE"
  echo "==> Built build/DragShelf.dmg"
fi

if [[ $INSTALL == 1 ]]; then
  DEST="/Applications"
  [[ -w "$DEST" ]] || DEST="$HOME/Applications"
  mkdir -p "$DEST"
  osascript -e 'tell application id "app.dragshelf.DragShelf" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf "$DEST/DragShelf.app"
  cp -R "$APP" "$DEST/"
  # Built locally, so not quarantined; clear the flag anyway in case the folder was downloaded.
  xattr -dr com.apple.quarantine "$DEST/DragShelf.app" 2>/dev/null || true
  echo "==> Installed $DEST/DragShelf.app"
  open "$DEST/DragShelf.app"
fi

exit $SELFTEST_FAILED
