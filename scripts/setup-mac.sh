#!/bin/bash
# One-step setup for Parity on an Apple Silicon Mac.
# Installs the free build tools (only what's missing), builds Parity, installs it to
# /Applications and clears the "unidentified developer" flag. Safe to run again (it updates).
#
# Usage, from inside the Parity folder:   bash scripts/setup-mac.sh
set -euo pipefail

cd "$(dirname "$0")/.."
say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

if [[ "$(uname -s)" != "Darwin" ]]; then echo "This script is for macOS."; exit 1; fi

# 1. Xcode command-line tools (compiler, linker). macOS shows its own install dialog.
if ! xcode-select -p >/dev/null 2>&1; then
  say "Installing Apple's command-line tools — click 'Install' in the dialog that appears"
  xcode-select --install || true
  until xcode-select -p >/dev/null 2>&1; do sleep 10; done
fi

# 2. Rust (user-local, no admin password needed)
if ! command -v cargo >/dev/null 2>&1 && [[ ! -x "$HOME/.cargo/bin/cargo" ]]; then
  say "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add aarch64-apple-darwin >/dev/null 2>&1 || true

# 3. Node.js 22 LTS (user-local copy in ~/.parity-tools, no admin password needed)
NODE_VER="v22.12.0"
NODE_DIR="$HOME/.parity-tools/node-$NODE_VER-darwin-arm64"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1)" < "v20" ]]; then
  if [[ ! -x "$NODE_DIR/bin/node" ]]; then
    say "Installing Node.js $NODE_VER"
    mkdir -p "$HOME/.parity-tools"
    curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-darwin-arm64.tar.gz" | tar -xz -C "$HOME/.parity-tools"
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi

# 4. Build
say "Installing project dependencies"
npm ci --no-audit --no-fund
say "Building Parity (first build takes ~5–10 minutes)"
npx tauri build --target aarch64-apple-darwin

APP="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Parity.app"
[[ -d "$APP" ]] || { echo "Build did not produce $APP"; exit 1; }

# 5. Self-test the built app on an isolated temporary database (your real data is untouched)
say "Running the built-in self-test"
TMP="$(mktemp -d)"
for phase in write verify; do
  PARITY_DATA_DIR="$TMP/data" PARITY_SELFTEST=$phase PARITY_SELFTEST_OUT="$TMP/$phase.json" "$APP/Contents/MacOS/parity" &
  pid=$!
  for _ in $(seq 1 120); do kill -0 $pid 2>/dev/null || break; sleep 1; done
  kill $pid 2>/dev/null || true
  if grep -q '"ok": true' "$TMP/$phase.json" 2>/dev/null; then echo "  $phase: passed"; else echo "  $phase: FAILED — see $TMP/$phase.json"; exit 1; fi
done
rm -rf "$TMP"

# 6. Install
say "Installing to /Applications"
rm -rf /Applications/Parity.app
cp -R "$APP" /Applications/
xattr -dr com.apple.quarantine /Applications/Parity.app 2>/dev/null || true
cp src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg "$HOME/Desktop/" 2>/dev/null || true

say "Done. Parity is in Applications (a .dmg copy is on your Desktop)."
open /Applications/Parity.app
