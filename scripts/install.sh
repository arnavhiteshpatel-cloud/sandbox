#!/bin/bash
# One-time JARVIS installation on the Mac. Afterwards JARVIS needs no terminal, no Claude,
# no subscriptions and (after model downloads) no internet for its core functions.
#   ./scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "JARVIS installer"
echo "================"
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo "This installer targets Apple Silicon Macs."; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "Installing Command Line Tools (a dialog will appear)…"; xcode-select --install; echo "Re-run this script when that finishes."; exit 1; }

if ! command -v uv >/dev/null; then
  if command -v brew >/dev/null; then brew install uv; else python3 -m pip install --user uv && export PATH="$HOME/Library/Python/3.9/bin:$PATH"; fi
fi

if [[ ! -d /Applications/Ollama.app ]] && ! command -v ollama >/dev/null; then
  if command -v brew >/dev/null; then
    brew install --cask ollama
  else
    echo "Please install Ollama (free, open source) from https://ollama.com/download, then re-run."; exit 1
  fi
fi
open -g -a Ollama || true

./scripts/build_app.sh

echo "==> Installing to /Applications"
if [[ -d /Applications/JARVIS.app ]]; then
  osascript -e 'tell application "JARVIS" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf /Applications/JARVIS.app
fi
cp -R build/JARVIS.app /Applications/

echo "==> Downloading models (one time; ~10 GB in total)"
for i in $(seq 1 30); do curl -s localhost:11434/api/version >/dev/null && break; sleep 1; done
/Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis setup-models

echo "==> Verifying"
/Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis doctor | tee build/doctor.json

open /Applications/JARVIS.app
cat <<'MSG'

JARVIS is running in your menu bar.
  • Grant Microphone, Accessibility and Screen Recording when asked (Settings > Permissions in JARVIS).
  • Right-click the menu-bar icon > Launch at Login.
  • Hold ⌥⇧C and speak, or (when plugged in) say “Hey JARVIS”.
  • ⌃⌥⌘. stops everything.
MSG
