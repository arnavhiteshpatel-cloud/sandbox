# Setup

## Requirements

* Apple Silicon Mac (built for: MacBook Pro 14" M4 Pro, 24 GB, macOS Sequoia 15.7). macOS 14+ should work.
* ~12 GB free disk (app ~1 GB, models ~10 GB).
* Xcode Command Line Tools (`xcode-select --install`). Full Xcode is **not** needed.
* Internet **only during installation** (to download models). After that the core works offline.

## Install

```bash
./scripts/install.sh
```

What it does:

1. Installs `uv` (Python manager) and **Ollama** (free, open-source local model runtime) via Homebrew if needed.
2. `scripts/build_app.sh` compiles the native shell (Swift) and embeds a private Python 3.12 with all dependencies
   into `build/JARVIS.app`, then signs it ad-hoc.
3. Copies it to `/Applications/JARVIS.app`.
4. `jarvis setup-models` downloads the wake word, Kokoro voice, Whisper and LLM models (`qwen3.5:4b`, `qwen3.5:9b`,
   `embeddinggemma:300m`).
5. `jarvis doctor` verifies hardware, macOS, packages, models and permissions (output saved to `build/doctor.json`).

## Permissions

macOS asks for each on first use; you can also open **Command Center → Settings → Permissions**.

| Permission | Why | Where |
|---|---|---|
| Microphone | wake word and push-to-talk | Privacy & Security → Microphone |
| Accessibility | clicking/typing in apps, reading native UIs, window arrangement, ⌃⌘Q lock | Privacy & Security → Accessibility |
| Screen Recording | screenshots for "what's on my screen" and OCR fallback | Privacy & Security → Screen & System Audio Recording |
| Automation (per app) | controlling Arc, Finder, System Events | prompted per app ("JARVIS wants to control Arc") |

Hot keys use Carbon hot keys, which need **no** Input Monitoring permission.

> **Rebuilding resets permissions.** Ad-hoc signatures change with every build, and macOS ties permissions to the
> signature. To keep permissions across rebuilds, create a self-signed code-signing certificate once (Keychain Access →
> Certificate Assistant → Create a Certificate → type "Code Signing", name "JARVIS Local") and build with
> `JARVIS_SIGN_IDENTITY="JARVIS Local" ./scripts/build_app.sh`.

### Arc specifics

* URL navigation and tab control work through Arc's AppleScript support.
* Reading and clicking page elements uses `execute javascript` in the active tab. If Arc refuses, JARVIS says so and falls
  back to the accessibility tree and screenshots. (Chrome/Brave/Edge/Safari need "Allow JavaScript from Apple Events" in
  their Developer/Develop menu.)

## Your first shortcut: "open my IB"

Either **say it**:

> "JARVIS, create a shortcut called Open My IB." → "What should the shortcut do?" → "Open Arc and go to this URL."

…with your IB course page open in Arc (JARVIS uses the current tab's address, or a URL on your clipboard). It reads the draft back and saves on "yes".

Or **build it** in Command Center → Shortcuts → New: step `open_url`, paste your course URL, browser `Arc`. Optionally add a
`verify` step with `url_contains` and part of the address. JARVIS never invents this URL.

Then: "Hey JARVIS, open my IB" → "Go to the assignments" → "Open the most recent one" → "Read the instructions and tell me what I need to do."

## Do Not Disturb / Focus

macOS has no public API for Focus. Create a shortcut in the **Shortcuts** app named `JARVIS Focus On` with the action
"Set Focus → Do Not Disturb → On" (and optionally `JARVIS Focus Off`). JARVIS shortcuts run it with the `macos_shortcut` step.

## Updating JARVIS

Pull the new code, then run `./scripts/build_app.sh` and copy `build/JARVIS.app` to /Applications. Your data in
`~/Library/Application Support/JARVIS` (settings, memory, shortcuts, index) is untouched.

## Files and folders

| Path | Contents |
|---|---|
| `~/Library/Application Support/JARVIS/jarvis.sqlite3` | memory, shortcuts, task history, activity log, file index |
| `~/Library/Application Support/JARVIS/settings.json` | settings |
| `~/Library/Application Support/JARVIS/models/` | Kokoro voice |
| `~/.ollama/models` | LLMs (managed by Ollama) |
| `~/.cache/huggingface` | Whisper models |
| `~/Library/Logs/JARVIS/` | logs |

No audio or screenshots are ever written to disk (screenshots go to a temp file that is deleted immediately after use).
