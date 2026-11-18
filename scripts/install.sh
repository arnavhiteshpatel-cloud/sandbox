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
start_ollama() {
  # Ollama's server must be running for model downloads and for JARVIS itself.
  curl -s --max-time 2 localhost:11434/api/version >/dev/null && return 0
  echo "==> Starting Ollama"
  open -g /Applications/Ollama.app 2>/dev/null || open -g -a Ollama 2>/dev/null || true
  for i in $(seq 1 45); do curl -s --max-time 2 localhost:11434/api/version >/dev/null && return 0; sleep 1; done
  # The app can take a while on first launch; fall back to the command-line server.
  if command -v ollama >/dev/null; then
    nohup ollama serve > "$HOME/Library/Logs/ollama-serve.log" 2>&1 &
    for i in $(seq 1 30); do curl -s --max-time 2 localhost:11434/api/version >/dev/null && return 0; sleep 1; done
  fi
  echo "Ollama did not start. Open the Ollama app from Applications once, then re-run ./scripts/install.sh"
  exit 1
}

bash scripts/build_app.sh

echo "==> Installing to /Applications"
if [[ -d /Applications/JARVIS.app ]]; then
  osascript -e 'if application "JARVIS" is running then tell application "JARVIS" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf /Applications/JARVIS.app
fi
ditto build/JARVIS.app /Applications/JARVIS.app

echo "==> Downloading models (one time; ~10 GB in total; already-downloaded models are skipped)"
start_ollama
PY=/Applications/JARVIS.app/Contents/Resources/python/bin/python3
(cd / && "$PY" -m jarvis setup-models)

echo "==> Verifying"
(cd / && "$PY" -m jarvis doctor) | tee build/doctor.json

open /Applications/JARVIS.app
cat <<'MSG'

JARVIS is running in your menu bar.
  • Grant Microphone, Accessibility and Screen Recording when asked (Settings > Permissions in JARVIS).
  • Right-click the menu-bar icon > Launch at Login.
  • Hold ⌥⇧C and speak, or (when plugged in) say “Hey JARVIS”.
  • ⌃⌥⌘. stops everything.
MSG
