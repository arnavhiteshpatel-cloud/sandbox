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
| “Do it” ending (2026-11-18) | **Ask, then submit**: short spoken summary (“Answered 10 of 10; unsure about 4 and 7. Submit?”); presses Submit on yes and verifies. |
| “Do it” progress | **HUD only, silent** (readable steps: “Typing an answer · 3 answered”). |
| Learning phrasings | **Ask first** (“Should I remember that … means …?”); declined phrasings are never asked again. |
| HUD position | **Top-left corner**, just under the menu bar. |
| Typing look | **Instant** (fast keystrokes; paste for long text). |
| Thinking indicator | **Show “Thinking it through…”** on the HUD. |
| Simple confirmations | **Silent**: shown on the HUD only; spoken only for answers, questions and problems. |
| Talk-over interruption | **On**. |
| Colors | **Closest to the film**: black with cyan/light-blue holographic light and amber accents (unchanged). |
| Menu-bar icon | **Ring / reactor** (unchanged). |
| Briefing | **On request** (“brief me”, “what's my day look like”): calendar, reminders due, battery. No automatic greeting. |
| Confirmations | **Voice + HUD buttons** (unchanged). |
| Listening sound | **None**. |
| Shortcut suggestions | **Whenever useful**: notices routines (same actions together on ≥3 days) and offers a shortcut; at most every 4 h; declined ones never again. |
| History retention | **30 days** for commands, task steps, activity; memories/shortcuts kept until deleted. |
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

### Feedback round 2 (2026-11-18): first real use
Reported: "open Arc" took 30 s and opened Archive Utility; talks too much and too slowly; Esc and ⌃⌥⌘. didn't stop it;
couldn't interrupt by talking; black box behind the HUD; wrong biology document and "open it" opened Audio MIDI Setup.
Root causes and fixes:
- App matching used substring fuzzy matching ("arc" ⊂ "archive utility", "it" matched an app). Now strict: exact/alias/
  whole-word prefix/close spelling only; pronouns never resolve to apps; Spotlight-based app discovery; STT aliases (ark→Arc);
  a stray leading word from the wake phrase is ignored.
- Max Performance had thinking always on (slow). Now `agent/thinking.py` decides per request (complex → think), escalates
  mid-task when struggling, and supports "think carefully" / "quickly". Setting `llm.think_policy`.
- Brevity: replies under 20 words unless detail is requested; spoken text trimmed; TTS 1.25×; end-of-speech 600 ms;
  settings migration (v2) applies these to existing installs.
- Stop: Esc is global while JARVIS is active; ⌃⌥⌘. is also detected via the event tap; speech stops within 50 ms.
- Barge-in by talking (echo-ratio detection, `voice.barge_in`).
- HUD: html background was opaque. Now transparent; text uses two lines.
- Files: instant "find …" with spoken top match; "open it / the second one / next one"; file names weighted in ranking.
- New: background internet lookups (`jarvis/web.py`: DuckDuckGo → Bing → Wikipedia; tools web_search/read_webpage;
  "look up …" fast path). Never opens the browser.
- New: phrase learning (`jarvis/learning.py`) plus vocabulary priming of Whisper.
128 tests pass.

### “JARVIS, do it” + typing (2026-11-18, user request)
- Completion mode (`Assistant._complete_task`, `COMPLETION_RULES`): read the whole task → answer each item (thinking,
  `calculate`, background web lookups) → fill fields / dropdowns by label / radios / documents → verify → Next → stop before
  submit (`strict_finalize`: Submit/Finish/Turn in/Complete-quiz always confirm, regardless of the user's words). Up to 100 steps
  and 30 min plugged in. New tools: `calculate` (AST-safe), `click_visual` (vision grounding, 0–1000 coordinates → click).
- Typing: real keystrokes with Return/Tab for line breaks, paste for long text (clipboard restored), automatic fallback from
  direct fill to keystrokes for rich editors, focus check (`focused_editable`) before typing; dictation mode; “write …” composes then types.
- Simulator gained a two-page practice quiz with real field state; benchmark case `do_it_quiz`.

### Design round (2026-11-18)
User asked to be consulted instead of having design guessed; three rounds of questions, answers recorded in the decision
table above and implemented (settings migration v3 applies them to the existing install). Real-model “do it” on the
practice quiz: first run failed (model asked “what task?”) → added auto-observe + must-act; second run got Q1–Q2 right but
stuck on a native dropdown → clicking an option's text now selects it; third run **PASS** (all 5 answers, stopped before submit).

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

- **Bug 3 (fixed, 2026-11-18):** after reinstalling, JARVIS was switched on under Accessibility but reported no permission.
  Cause: ad-hoc signatures change on every build and TCC grants are tied to the signature, so the list entry belonged to the
  previous build. Immediate fix for the user: `tccutil reset All local.jarvis.assistant`, then reopen and allow. Permanent
  fixes: `scripts/create_signing_identity.sh` makes a local "JARVIS Local Signing" certificate that the build uses
  automatically (permissions now survive rebuilds); the app listens for `com.apple.accessibility.api` and re-arms the ⌥⇧C
  tap with no restart; Settings → Permissions re-checks every 3 s and has a **Reset permissions** button with an explanation.
