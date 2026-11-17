# JARVIS

A local, voice-controlled assistant for macOS that operates your Mac. Wake word, speech recognition,
speech synthesis, reasoning and computer control all run **on your Mac**. JARVIS does not use Claude,
the Anthropic API, cloud inference or any paid service, so it keeps working after any subscription ends.

```
"Hey JARVIS."                         → "Yes?" (pill HUD appears)
"Open my IB."                         → your shortcut: Arc, new tab, your course URL, verified
"Go to the assignments."              → finds the link on the page and clicks it (no AI needed)
"Open the most recent one."           → local AI agent: observes the page, picks, clicks, verifies
"Read the instructions and tell me what I need to do."
```

## How it works

| Level | Handles | Engine | Cost |
|---|---|---|---|
| 1 Instant | open apps, volume, lock, scroll, back, "click assignments", your shortcuts | deterministic router + shortcut engine | milliseconds, no model loaded |
| 2 Local AI | "find the paper about Parkinson's", "what's on my screen" | local LLM (Qwen3.5 via Ollama) with tools | seconds |
| 3 Agent | "open Canvas and list my next three assignments" | bounded observe → act → verify loop | tens of seconds |

* **Voice:** openWakeWord "hey_jarvis" (behind an energy gate) · Whisper (MLX on Apple Silicon) · Kokoro `bm_george` voice.
* **Computer control:** your real Arc via AppleScript + injected JavaScript (keeps your logins), the Accessibility tree for
  native apps, and screenshots + Apple Vision OCR as a last resort.
* **Memory & search:** SQLite + FTS5, semantic vectors, Spotlight. Everything stays in `~/Library/Application Support/JARVIS`.
* **Power:** three modes, wake word only on AC (your choice), models unloaded on idle timers, indexing only while charging.
* **Safety:** delete, submit, send and buy actions require confirmation, enforced in code. Web/file content is treated as untrusted data.

## Install (on the Mac, once)

```bash
git clone <this repo> jarvis && cd jarvis
```

```bash
./scripts/install.sh
```

The script installs Ollama (free) and builds `JARVIS.app` with its own embedded Python. It also downloads all models (about 10 GB)
and copies the app to /Applications. Then grant the permissions JARVIS asks for. See [docs/SETUP.md](docs/SETUP.md).

## Use

* **Talk:** hold **⌥⇧C** (always), or say **"Hey JARVIS"** when plugged in.
* **Stop everything:** **⌃⌥⌘.** or say "JARVIS, stop".
* **Menu bar:** click the icon for the popover; right-click for modes, mute, launch at login and quit.
* **Command Center:** live tasks, dashboard, shortcut editor, memory, file search, settings.

## Documentation

| | |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | installation, permissions, first shortcut ("open my IB") |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | components, data flow, extension points |
| [docs/MODELS.md](docs/MODELS.md) | model choice, benchmark results, how to upgrade or replace models |
| [docs/POWER.md](docs/POWER.md) | battery design, what is measured vs. estimated, how to profile |
| [docs/TESTING.md](docs/TESTING.md) | test suite, acceptance tests (40), current status |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | known limitations |
| [docs/JOURNAL.md](docs/JOURNAL.md) | development journal (decisions, status, next actions) |

## Development

```bash
uv venv .venv -p 3.12 && source .venv/bin/activate && uv pip install -e ".[dev,files,voice,stt-cpu]"
```

```bash
JARVIS_PLATFORM=fake python -m pytest -q
```

```bash
JARVIS_PLATFORM=fake python -m jarvis serve --no-voice
```

The last command opens the UI at http://127.0.0.1:47823/ui/index.html?token=… (the token is in the data dir). It runs against a *simulated* computer, for UI work on any OS.
