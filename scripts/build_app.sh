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
# Signing: a stable identity keeps macOS permissions across rebuilds. Uses "JARVIS Local Signing"
# (created by scripts/create_signing_identity.sh) when present; otherwise ad-hoc ("-").
if [[ -n "${JARVIS_SIGN_IDENTITY:-}" ]]; then
  SIGN_ID="$JARVIS_SIGN_IDENTITY"
elif security find-identity -p codesigning 2>/dev/null | grep -q '"JARVIS Local Signing"'; then
  SIGN_ID="JARVIS Local Signing"
else
  SIGN_ID="-"
fi

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
# --system: never pick up a project .venv (a venv is not relocatable and would ship dev packages)
PYBIN="$(cd / && uv python find --system --python-preference only-managed "$PYVER")"
# uv reports the interpreter through a symlinked "cpython-3.12-…" folder; `cp -R` would copy only that
# link. Ask the interpreter for its real install folder and copy the actual files.
PYHOME="$("$PYBIN" -c 'import sys; print(sys.base_prefix)')"
[[ -d "$PYHOME" && ! -L "$PYHOME" ]] || { echo "error: could not resolve the Python install folder ($PYHOME)"; exit 1; }
[[ ! -f "$PYHOME/pyvenv.cfg" ]] || { echo "error: $PYHOME is a virtualenv, not a standalone Python"; exit 1; }
ditto "$PYHOME" "$APP/Contents/Resources/python"
BUNDLED="$APP/Contents/Resources/python/bin/python3"
BUNDLED_PREFIX="$("$BUNDLED" -c 'import sys; print(sys.prefix)')"
case "$BUNDLED_PREFIX" in
  "$APP/Contents/Resources/python"*) echo "    Python embedded at $BUNDLED_PREFIX" ;;
  *) echo "error: bundled Python resolves to $BUNDLED_PREFIX instead of the app; refusing to continue"; exit 1 ;;
esac
# PEP 668 marker from uv-managed Pythons would block pip inside the bundle; it is our private copy.
find "$APP/Contents/Resources/python/lib" -maxdepth 2 -name EXTERNALLY-MANAGED -delete || true
"$BUNDLED" -m ensurepip --upgrade >/dev/null

echo "==> Installing JARVIS and its dependencies into the bundle"
"$BUNDLED" -m pip install --upgrade pip wheel >/dev/null
"$BUNDLED" -m pip install "$ROOT[voice,stt-mlx,files,macos]"
# Prove the packages landed inside the app, not in some other Python.
(cd / && "$BUNDLED" -c 'import jarvis, sys; assert jarvis.__file__.startswith(sys.prefix), jarvis.__file__; print("    jarvis package:", jarvis.__file__)')

echo "==> Precompiling bytecode (the signed bundle is never written to at runtime)"
"$BUNDLED" -m compileall -q "$APP/Contents/Resources/python/lib" >/dev/null || true

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
if ! codesign --force --sign "$SIGN_ID" "$APP"; then
  echo "    warning: signing with \"$SIGN_ID\" failed; falling back to ad-hoc (permissions will reset on rebuilds)"
  SIGN_ID="-"
  find "$APP/Contents/Resources/python" -type f \( -name "*.so" -o -name "*.dylib" \) -exec codesign --force --sign - {} + 2>/dev/null || true
  codesign --force --sign - "$APP/Contents/Resources/python/bin/python3" 2>/dev/null || true
  codesign --force --sign - "$APP"
fi
codesign --verify --verbose=1 "$APP" && echo "    signature OK"
codesign -d -r- "$APP" 2>&1 | grep -o 'designated => .*' | sed 's/^/    /' || true

SIZE_MB=$(du -sm "$APP" | awk '{print $1}')
echo "==> Built $APP (${SIZE_MB} MB)"
[[ "$SIZE_MB" -gt 200 ]] || { echo "error: the app is only ${SIZE_MB} MB; the embedded Python is missing"; exit 1; }
