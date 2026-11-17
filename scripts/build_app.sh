#!/bin/bash
# Build a self-contained JARVIS.app (Apple Silicon). Run on the Mac from the repository root:
#   ./scripts/build_app.sh            -> build/JARVIS.app
# Requirements: Xcode Command Line Tools (xcode-select --install) and uv (https://docs.astral.sh/uv/).
# The app embeds its own Python, so it keeps working regardless of system Python changes.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="$ROOT/build/JARVIS.app"
PYVER="${JARVIS_PYTHON_VERSION:-3.12}"
SIGN_ID="${JARVIS_SIGN_IDENTITY:--}"   # "-" = ad-hoc. A stable self-signed identity keeps permissions across rebuilds (see docs/SETUP.md)

[[ "$(uname -s)" == "Darwin" ]] || { echo "build_app.sh must run on macOS"; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || echo "warning: not Apple Silicon; MLX speech recognition will be unavailable"
command -v swiftc >/dev/null || { echo "Install the Command Line Tools: xcode-select --install"; exit 1; }
command -v uv >/dev/null || { echo "Install uv first: brew install uv  (or: python3 -m pip install --user uv)"; exit 1; }

echo "==> Preparing bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp macapp/Info.plist "$APP/Contents/Info.plist"

echo "==> Compiling the native shell"
swiftc -O -target arm64-apple-macos14.0 \
  -framework AppKit -framework WebKit -framework Carbon -framework IOKit \
  -framework ServiceManagement -framework AVFoundation -framework ApplicationServices \
  macapp/Sources/*.swift -o "$APP/Contents/MacOS/JARVIS"

echo "==> Embedding Python $PYVER (python-build-standalone via uv)"
uv python install "$PYVER"
PYBIN="$(uv python find "$PYVER")"
PYHOME="$(cd "$(dirname "$PYBIN")/.." && pwd)"
cp -R "$PYHOME" "$APP/Contents/Resources/python"
BUNDLED="$APP/Contents/Resources/python/bin/python3"
"$BUNDLED" -m ensurepip --upgrade >/dev/null 2>&1 || true
# PEP 668 marker from uv-managed Pythons would block pip inside the bundle; it is our private copy.
find "$APP/Contents/Resources/python/lib" -maxdepth 2 -name EXTERNALLY-MANAGED -delete || true

echo "==> Installing JARVIS and its dependencies into the bundle"
"$BUNDLED" -m pip install --no-cache-dir --upgrade pip wheel >/dev/null
"$BUNDLED" -m pip install --no-cache-dir "$ROOT[voice,stt-mlx,files,macos]"

echo "==> App icon"
ICONSET="$ROOT/build/AppIcon.iconset"; rm -rf "$ICONSET"; mkdir -p "$ICONSET"
if qlmanage -t -s 1024 -o "$ROOT/build" macapp/AppIcon.svg >/dev/null 2>&1 && [[ -f "$ROOT/build/AppIcon.svg.png" ]]; then
  for s in 16 32 64 128 256 512; do
    sips -z $s $s "$ROOT/build/AppIcon.svg.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ROOT/build/AppIcon.svg.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" || echo "  (icon skipped)"
else
  echo "  (icon skipped: could not render SVG)"
fi

echo "==> Signing ($([[ "$SIGN_ID" == "-" ]] && echo ad-hoc || echo "$SIGN_ID"))"
find "$APP/Contents/Resources/python" -type f \( -name "*.so" -o -name "*.dylib" \) -exec codesign --force --sign "$SIGN_ID" {} + 2>/dev/null || true
codesign --force --sign "$SIGN_ID" "$APP/Contents/Resources/python/bin/python3" 2>/dev/null || true
codesign --force --sign "$SIGN_ID" "$APP"
codesign --verify --verbose=1 "$APP" && echo "    signature OK"

du -sh "$APP" | awk '{print "==> Built " $2 " (" $1 ")"}'
