# JARVIS Development Journal

The source of truth for resuming work across sessions. Newest entries at the top of each section.

## User decisions (do not re-ask)

Recorded 2026-11-17, answers given directly by the user:

| Topic | Decision |
|---|---|
| UI technology | "Whatever is best." Chosen: a native Swift menu-bar shell hosting an HTML/CSS UI (WKWebView), served by the local daemon. The UI can be rendered and verified in CI/Linux; the native part stays small. |
| On-screen presence | **Floating HUD only while active** (listening, thinking or speaking), top-center, then disappears. |
| HUD style | **Minimal pill**: a capsule with a glowing status dot and live transcript/response text. |
| Command center | **Live tasks + activity** as the main view, **plus a dashboard** (status, power, model, recent commands, quick shortcuts). Sidebar: Shortcuts, Memory, Search, Settings. |
| Voice | **British male, composed**: Kokoro `bm_george` (fallback: macOS `say -v Daniel`). |
| Personality | Simple commands are **strictly functional** ("Opening Spotify."). Complex, multistep or back-and-forth tasks use **polite, dry wit, "sir"**, JARVIS-like. |
| Wake word | **"Hey JARVIS" only while on AC power**; on battery, **hold-to-talk only**. |
| Push-to-talk | **Hold ⌥⇧C** (Option+Shift+C), left hand. (⌥Space is taken.) |
| Emergency stop | **⌃⌥⌘.** (Ctrl+Option+Cmd+Period), and the voice command "JARVIS, stop". |
| Autonomy | **Confirm only high-impact actions**: delete, submit/send, buy/pay, system changes. Opening, navigating, clicking, reading, moving and renaming files are automatic. |
| File indexing | **Entire home folder** authorized. Hidden folders, ~/Library, keychains and password-manager vaults, app bundles and media libraries are excluded. Heavy indexing runs while charging. |
| Max Performance model | **Benchmark decides.** Ship Qwen3.5 9B; `jarvis bench` on the Mac compares candidates. |
| App access (2026-11-18) | **Every app reachable**, not just Arc. Nothing is blocked by default. Terminal, iTerm, Keychain Access, Passwords, System Settings, password managers, Disk Utility and Activity Monitor are "sensitive": any click, typing or script there asks first. Sending messages always asks. |
| Subscription | Claude access ends **2026-12-05**. Nothing at runtime may depend on Claude or Anthropic. |

## Environment facts

- Development so far happened in a **Linux x86_64 cloud container** (Claude Code on the web). **No Mac was attached.**
  Consequently, nothing macOS-specific (Swift build, Accessibility, microphone, Arc, power) has been executed yet.
- Target: MacBook Pro 14" (Nov 2024), M4 Pro, 24 GB, macOS 15.7.3 (as reported by the user; `jarvis doctor` verifies this on the Mac).

## Status (2026-11-17, session 1)

### Completed (code exists, tested where possible)
- **Core service** (`jarvis/`): config, SQLite DB, event bus, local API with token/Host/Origin guard, CLI.
- **Level 1 router**: built-ins (apps, URLs, volume, lock, time/date/battery, power modes, memory, shortcuts CRUD by voice,
  browser follow-ups incl. deterministic "click X" with an ambiguity guard).
- **Shortcut engine**: validated JSON schema, `{param}` triggers, 25 actions (browser, apps, waits/verify, if/else,
  reusable blocks, agent steps, Shortcuts-app bridge, windows, files, gated shell/AppleScript), retries, run history,
  import/export; voice creation dialog ("open Arc and go to this URL" uses the current tab URL).
- **Agent**: bounded observe→act→verify loop, 25 tools, schema validation and recovery, cancellation, code-enforced
  safety policy, untrusted-content wrapping, tool subsetting, cache-friendly history.
- **macOS layer** (unverified): Arc/Chrome/Safari via AppleScript + injected JS (JS verified in Chromium), AX tree
  snapshot/press/set-value/menus/window frames, CGEvent keys/mouse/scroll, screencapture + Vision OCR, volume/lock/battery/
  notifications/Shortcuts/open/reveal, permission checks.
- **Voice**: mic, energy-gated openWakeWord, VAD capture, PTT, follow-up window, ask/confirm by voice, Whisper (MLX/CPU),
  Kokoro (sentence streaming, interruptible), `say` fallback, idle unloading. Real-model self-test 6/6.
- **Memory** (explicit vs inferred, FTS5) and **file search** (extractors for PDF/Office/code/images, incremental indexer,
  duplicates, hybrid Spotlight + FTS + semantic search).
- **Power**: three modes, auto-switching deferred during tasks, wake word on AC only, charging-only background-QoS indexing.
- **UI**: pill HUD, menu-bar popover, command center (Live, Dashboard, Shortcuts editor, Memory, Search, Settings).
- **Native shell** (unverified, parses with swiftc): menu bar, HUD panel, hot keys, sleep/wake/lock/power events, login item,
  service supervision.
- **Tooling**: `jarvis doctor`, `jarvis bench`, `jarvis.voice.selftest`, `jarvis.powerprof`, `jarvis.acceptance`,
  `scripts/build_app.sh`, `scripts/install.sh`.

### Architecture decisions
1. **Python service + thin Swift shell + web UI.** The Python ecosystem has the local-AI pieces (MLX Whisper, openWakeWord,
   Kokoro, pyobjc); the Swift shell does what must be native (menu bar, hot keys, panels, login item, system
   notifications). The web UI could be rendered and verified without a Mac.
2. **Drive the user's real Arc, not Playwright.** It keeps logins (IB portal) and uses AppleScript + JS for structured DOM
   access, with the AX tree and then OCR as fallbacks.
3. **Single multimodal model** (Qwen3.5) for tools and vision, which avoids a second resident model.
4. **Safety in code, not in prompts.**
5. **No separate intent-classifier model.** The deterministic router is the fast path and everything else goes to one LLM,
   so only one model is resident.

### Independent review of the unverified macOS code (session 1)
A separate reviewer audited the Swift, pyobjc, AppleScript and build script. Fixed: ⌥⇧C rejected by macOS 15
RegisterEventHotKey (now an event tap with a ⌃⌥C fallback); build_app.sh could bundle the project .venv (now
`uv python find --system --python-preference only-managed` plus a venv check); daemon restart race (generation guard plus
wait after SIGKILL); UTF-16 length for typed text; hidden apps missed by `visibleProcessList` (now `lsappinfo list` plus
a pgrep fallback); .pyc writes into the signed bundle (precompiled plus PYTHONPYCACHEPREFIX); duplicate HUD panel after
restart; popover activation; AXEnhancedUserInterface removed. Reviewed as correct: pyobjc AX/Vision/CGEvent call
conventions, AppleScript for Arc/Chrome/Safari, lsappinfo parsing, Carbon/IOKit closures, TCC attribution.

### Benchmark (Linux CPU, Qwen3.5-4B, one run per case)
v1 8/11 → v2 11/11 after tool subsetting and verbatim tool-call replay. Prompt tokens per call fell 1,879 → 679 and
cache-reusing calls rose 5/19 → 25/36. Reports are in docs/benchmarks/.

### Every-app control (session 2, 2026-11-18)
Added universal follow-ups (scroll/back/new tab/close tab in any app), a system layer (media keys, brightness, dark mode,
Wi-Fi, Settings panes, screenshots, window actions), built-in integrations (Notes, Reminders, Calendar, Mail drafts, Messages
with confirmation, Spotify search, any URL scheme), agent tools `app_dictionary` + `script_app` (script any scriptable app,
risky scripts confirmed), AXManualAccessibility for all apps (Electron apps expose their UI), and 5 new shortcut step types.
100 tests pass. Real model (Qwen3.5-4B, CPU): the 3 app cases passed 3/3.

### Known issues / risks
- Nothing macOS-specific has been executed yet (see LIMITATIONS.md).
- Qwen3.5's hybrid architecture limits prompt-cache reuse in llama.cpp-based runtimes, so first-step latency per AI task
  must be measured on the Mac.
- openWakeWord pinned to 0.4.0 (0.5+ needs tflite-runtime, which has no Python 3.12 wheels).

### Exact next actions (do these in order on the Mac)
1. `./scripts/install.sh`. Fix any Swift compile errors (AppKit can't be type-checked on Linux) and re-run.
2. `python -m jarvis doctor`. Confirm M4 Pro / 24 GB / macOS 15.7.3 and that all packages and models are present.
3. Grant permissions; check that the TCC prompts name JARVIS (not python3).
4. Create "Open My IB" with the real URL; run acceptance tests 7–19 (`python -m jarvis.acceptance --only 7,…,19`).
5. `jarvis bench --models qwen3.5:4b,qwen3.5:9b,qwen3:8b --repeat 3` and pick models per mode (update MODELS.md).
6. `sudo … -m jarvis.powerprof` unplugged and fill in POWER.md.
7. Run the remaining acceptance tests; record in ACCEPTANCE_RESULTS.md.

## First run on the Mac (2026-11-18, reported by the user)
- **Worked:** Swift shell compiled on the first try; all Python packages installed; wake word, Kokoro and Whisper
  (turbo + small) models downloaded.
- **Bug 1 (fixed):** `open -a Ollama` ran before Launch Services registered the freshly installed Ollama.app, so the
  Ollama server wasn't running and `setup-models` crashed with "Connection refused". Fix: start by path, wait up to 45 s,
  fall back to `ollama serve`, and fail with a clear message; setup-models checks first.
- **Bug 2 (fixed):** the bundle was 1.3 MB. `uv python find` returns a path through a symlinked `cpython-3.12-…` folder,
  and `cp -R` copied only the link, so packages were installed into uv's Python instead of the app. Fix: copy
  `sys.base_prefix` with `ditto`, then assert the bundled `sys.prefix` and the `jarvis` package are inside the app and the
  app is larger than 200 MB. Verified on Linux with the same uv layout (104 MB real copy; pip installs land inside).
