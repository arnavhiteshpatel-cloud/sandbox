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

## Feedback round 3 (2026-11-19): conversation, interruption, speed, permissions
User report: interrupting made JARVIS restart what it was saying; keyboard typing interrupted it; it didn't stop
immediately; the HUD appeared when it started talking instead of at "Hey JARVIS"; still slow; permissions still not
recognized; the follow-up window "straight up doesn't work"; it "has 6 thoughts and interrupts itself"; talk faster.

| Problem | Root cause | Fix |
|---|---|---|
| Restarts what it was saying | The interruption recording kept the last 0.6 s of audio, which contained JARVIS's own voice; Whisper transcribed it and it was answered as a new request | Echo words matching what JARVIS was saying are removed from the transcript (`strip_echo`); if nothing of yours is left it was a false alarm and it **carries on from the interrupted sentence** |
| Keyboard interrupts it | Detection was loudness-only | Silero voice-activity model (bundled with openWakeWord; key clicks score < 0.5, speech ~1.0) + click-proof loudness (median of 10 ms slices) + an **echo model**: the delay from speaker to mic and the echo level are measured from JARVIS's own speech, so each 80 ms frame is compared with the echo expected at that moment |
| Hard case: your voice no louder than its echo | MacBook speakers sit next to the mics | **Ducking**: a suspected voice drops JARVIS to 15 % volume within one 40 ms block; with JARVIS that quiet a real voice is easy to confirm → stop. Not confirmed in ~0.4 s → volume back, nothing lost. The trigger level self-tunes per room (false alarm → stricter, real interruption → more sensitive) |
| Doesn't stop immediately | ~320 ms detection, then the speaker buffer kept playing | Callback-driven player: stop empties the queue (silent within one block), cannot hang |
| "6 thoughts", interrupts itself | Several `speak()` calls could overlap (progress lines, answer, "should I remember…?"), each cancelling the last | One utterance at a time (FIFO lock); stop drops anything queued; spoken progress lines removed (HUD only, per the user's choice); side questions wait until the conversation is quiet |
| Follow-up window doesn't work | (a) the end of the request emitted "idle", which hid the HUD while it was actually listening; (b) any noise started a "recording" that ended as an empty transcript and used up the window; (c) a queued reply could be recorded as your follow-up | Idle only when nothing is speaking/listening/pending; the HUD keeps the reply and says "Listening — go ahead"; recording starts on voice (not noise) and empty results keep listening for the rest of the window; the window pauses while JARVIS talks; default 8 s |
| HUD late | Hidden WKWebViews are throttled by macOS, so the page saw the wake event late | The app listens to the event stream natively (`EventStream.swift`) and shows the top-left HUD on `wake` |
| Slow | Plain questions went through the agent: ~3,300 tokens (36 tool descriptions) to process before the first word; models unloaded after 30 s / 5 min | **Fast conversation path**: questions that don't involve the screen/files/apps get one short call (~250 tokens); current-facts questions go straight to a background web lookup; the model can answer `LOOKUP: …`. Measured on the Linux test box with Qwen3.5-4B: 19 s vs **173 s** for the same question through the agent (absolute times on the M4 Pro will be far lower; the ratio is what matters). Models stay loaded 3 min / 30 min / 2 h by mode; speech recognition and voice pre-load at start-up and on wake; first sentence split at a comma so the voice starts sooner; end-of-speech 500 ms (voice model, not loudness); latency of every reply is written to the activity log |
| Talk faster | — | Voice speed 1.4 (settings migration v4) |
| Permissions still not recognized | A running process can keep getting macOS's answer from when it started; `ax.snapshot`/`menu_select` and the ⌥⇧C tap refused to even try when that cached answer was "no" | Actions always try and only a real `kAXErrorAPIDisabled` counts; the tap retries every 4 s; permissions are checked from a fresh process; if granted-but-stale, the service restarts itself once (the app restarts it) |
| Leaked reasoning | When a server ignores "don't think" and the reply is cut off mid-thought, `<think>…` was returned as the answer | Unclosed think blocks are stripped; the fast path retries with room |

Tests: 162 pass (new `tests/test_voice_conversation.py`: real speech + key clicks mixed at four echo levels; JARVIS's
echo and typing never stop it, your voice does at 0.15–0.8 echo gain even when quieter than the echo; echo removal;
one utterance at a time; stop drops queued speech; player stops within one block and never hangs; recording starts at
speech not key clicks; HUD status stays "listening" during the follow-up window; fast path and lookups).
Not verified here: real microphones/speakers (no audio hardware in the container), the Swift changes (no Swift
toolchain here; reviewed by hand), timings on the M4 Pro.

### Same day: "open arc" → Archive Utility again; "remember" didn't work
- "open up arc" kept "up" ("up arc" matched nothing) and fell to the agent → router accepts "open up / start up / boot up".
- "close archive browser and open arc" was read as closing an app named "archive browser and open arc" → simple
  commands joined by "and"/"then"/commas now run one after another without the AI (only when every part is simple).
- With Arc missing from JARVIS's app list, "arc"/"arch" still prefix-matched **Arc**hive Utility, and apps were opened
  with `open -a <name>`, which lets macOS guess → the resolver only accepts whole words (the last may be abbreviated,
  4+ letters), a nickname like "arch" means Arc or nothing, apps open **by path** (never by name), well-known apps are
  also found by bundle id (Arc: company.thebrowser.Browser), and opening is reported as failed unless that exact app
  starts.
- "Remember that when I say open arc, I mean the Arc browser" only saved a note that nothing consulted → it is now a
  taught phrasing that wins over everything else and an app alias ("arc" → Arc) so "close arc", "switch to arc" work
  too; visible and deletable under Memory → Learned phrasings. Quick answers now include your saved memories.

### Same day: "still taking too long; conversation should be basically seamless"
- **Streaming:** conversation replies stream from the model (Ollama NDJSON / OpenAI SSE) through `SpokenStream`, which
  hands each finished sentence (or a long first clause) to the voice immediately; hidden reasoning and `LOOKUP:` replies
  are never spoken. Measured with the real Qwen3.5-4B on the Linux test box: first sentence ready at 5.0 s vs the full
  reply at 11.4 s (the M4 Pro is far faster in absolute terms; the overlap is the point). Talking over a streamed reply
  also stops the generation.
- **Conversation model:** `llm.chat_models` = 4B in Battery Saver/Balanced (≈2× faster), 9B in Max; tasks keep the 9B.
  Both are warmed at start-up and on "Hey JARVIS"; `setup-models` downloads both.
- **Conversation is the default:** only clear computer work (command verbs, the screen/this page/files/apps, your
  calendar/emails/etc., instructions about your things like "crank up my tunes") goes to the agent; everything else —
  including "my day was rough", "write a poem", "help me think of a name" — gets the fast streamed path.

### Same day: "I can't find an app called Arc" while Arc was open
JARVIS only looked in app folders, Spotlight and (for known apps) Spotlight-by-bundle-id; the user's Arc wasn't found by
any of them (which is also why `open -a Arc` had made macOS guess Archive Utility). Now: **running apps are always
included** (`lsappinfo` gives each one's real path and bundle id, so "close X" works for anything running), apps seen
running are **remembered** (`seen_apps.json`) so they open after being quit, known apps are also looked up through
LaunchServices (`NSWorkspace URLForApplicationWithBundleIdentifier`, no Spotlight needed), one level of subfolders in
/Applications plus Downloads/Desktop are scanned, and "arc" also answers to a running Browser Company app.
Teaching accepts "every time I say X, I mean Y" and "the browser I have open" / "this app".

## Scenario sweep (2026-11-19, user: "simulate as many scenarios as you can … find as many bugs as you can")
Three rounds, all through the real code:
1. **~250 utterances** through the real assistant on the simulated Mac, tracing route (instant / chat / web / agent),
   actions and reply. 20 bugs fixed (commit "Scenario sweep"), pinned by `tests/test_scenarios.py`.
2. **Multi-turn sequences** (shortcut dialogs with "yes", teaching then using, follow-ups, messy transcripts, failures,
   model down): repeated transcripts, cut-off commands, "hey jarvis" alone, volume by amount, shortcut read-back,
   "next one" repeating the current result, model runtime dying mid-session — fixed.
3. **Voice loop end to end in real time** (`tests/test_voice_end_to_end.py`, `tests/_voice_sim.py`): a simulated mic
   mixes room noise, recorded speech, key clicks and JARVIS's own voice returning 120 ms later at 40 %. Found and fixed:
   your sentence posted twice; a "Thinking…" flicker; two interruptions per barge-in; the echo learner learning from
   *your* voice (the bar rose while you talked: up to 3 s late); the voice model scoring two overlapping voices at
   0.2–0.7 (now loudness-led confirmation while ducked; key clicks can't produce sustained loudness). Six scenarios
   (follow-up, typing, talk-over, silence, quiet voice, short "mm") pass repeatedly.
4. **Real model (Qwen3.5-4B) with the new tools:** "close notes" ✓, clipboard ✓; "hide the dock" used light mode and
   claimed success; "empty the trash" called trash_files with an empty path and claimed success → Dock and Trash are
   now real abilities (instant by voice, `system` actions for the agent; emptying asks first), empty paths are refused,
   and the agent can no longer report success when its last real action failed.

### ⌥⇧C = type box (2026-11-19, user: "when I do shift option c I want to be able to type to it, because I have a lot of stuff in the menu bar and it doesn't show")
- ⌥⇧C opens a Spotlight-style box in the top-left (the HUD panel takes keyboard focus without activating JARVIS);
  Return sends, ↑/↓ history, Esc or ⌥⇧C again closes, clicking elsewhere closes. Return on an empty box (or 🎙) starts
  listening, so voice still works on battery when the wake word is off. ⚙, or typing "settings" / "jarvis settings" /
  "open command center", opens the Command Center: the menu-bar icon is hidden behind the notch on the user's Mac.
  ("open system settings" / "open wifi settings" still open macOS settings.)
- Typed requests are answered in writing on the HUD and never open the microphone afterwards (setting
  `voice.speak_typed_replies`). Hold-to-talk remains a setting (`hotkeys.talk_key_action`). Settings migration v5.
- Found while screenshotting it with the real server: when the microphone can't open, the voice loop retried every 2 s
  and posted "Something went wrong" over the HUD each time, wiping the answer → reported once, retries back off to
  60 s, and background voice errors go to the activity log instead of the HUD. Chained commands now show the combined
  result on the HUD.

### "It broke the entire thing" (2026-11-19, after the type-box update)
Symptoms: no wake word (plugged in), ⌥⇧C does nothing, typing in the small panel gets no reply, empty activity list:
the app couldn't talk to its background service. Most likely cause: I had suggested quitting JARVIS from Activity
Monitor (the icon was hidden); a force-quit app never stops its service, so the old service kept running on port
47823. The new service couldn't bind the port, while the app's readiness check (unauthenticated /health) got an
answer from the OLD service and treated it as ready; every real request was then rejected (wrong key).
Fixes: the app stops any leftover `jarvis serve --port 47823` before starting its own; readiness is checked with the
app's key (/api/state), so only its own service counts; the service exits within ~3 s if its app goes away
(verified); a taken port now gives a clear message and exit code 3 (verified); install.sh clears leftovers too.

### "Open my canvas homepage" took 30 s, opened Spotlight, wrong page → "it needs to be WAY smarter", "like the movies"
Root cause: JARVIS didn't know the user's Canvas address, so the agent improvised (Spotlight, guessed domain).
- **Sites** (`jarvis/sites.py`): learned sites → the user's browser history (Arc/Chrome/Brave/Edge/Vivaldi, read-only,
  `immutable=1`; "canvas" → *.instructure.com via a small synonym table) → official site by web search for public names
  → ask once. Whatever is found is remembered (Memory, kind "website"), so the next time is instant. "my X" checks your
  sites before links on the current page.
- **Keyboard shortcuts** (`jarvis/agent/app_keys.py`): well-established shortcuts for Arc, Chrome, Safari, Finder,
  Spotify, Notes, Mail, Messages, VS Code, Slack, Preview, Word, Pages, Terminal + macOS standards. Saying one
  ("toggle the sidebar" in Arc) presses it instantly; the agent gets the front app's shortcuts as context, can look up
  unknown ones and `learn_app_shortcut` them. Never Spotlight; never guess a domain.
- **More context for every task:** open apps, the other tabs in the browser window, learned + most-visited sites, the
  front app's shortcuts.
- **Learns whole tasks:** a multi-step task the AI completed with replayable steps (open app/site, keys, menus, close,
  system toggles; never screen-dependent clicks) is offered as a recipe; next time it's replayed with no AI. A recipe
  that stops working is forgotten and worked out again.
- **Optional smart model** for computer tasks (`llm.smart_model`, e.g. gemma4:26b / qwen3.6:27b, ~17 GB): conversation
  stays on the fast model; falls back if not downloaded. Not default: on 24 GB it competes with speech models for memory.
- Found by the tests: "bring up my scribbles" would have asked "What's the address for your scribbles?" ("my" isn't a
  site) — only explicit site words ask now.

### Canvas → course → homework failed (opened Safari, gave up); Mac lagged after quitting JARVIS (2026-11-19)
- Safari: two routes handed web links to the Mac's DEFAULT browser (system open_location, `open https://…` in the
  shell), and the model could pick a different browser. Now every web link opens in the browser you're using (Arc)
  unless you named another one in the request.
- Giving up: after opening/clicking/back, the agent now immediately gets the new page's links and buttons (no blind
  steps), a find_on_page tool searches the whole page (Canvas dashboards are long), and built-in know-how for Canvas,
  ManageBac, Google Classroom, Schoology, Moodle and Gmail (where courses and assignments live) is added when you're on
  those sites. Rules: navigate section by section; don't stop after one page.
- Lag after quitting: Ollama kept the models loaded (keep-alive) after JARVIS quit: ~10 GB on a 24 GB Mac. JARVIS now
  unloads its models when it quits.

### "open canvas, find my ib 150 class, navigate to online course resources, and find week 13 homework" crashed (2026-11-19)
Traceback from the user's daemon.log: `browser.wait_ready` → `st.get("ready")` on a str.
- Root cause: Arc returns the result of `execute javascript` as a *quoted JSON string*; `js_json` decoded it once and
  got a str. Every JSON page action (state, snapshot, click, type) goes through js_json, so page control in Arc was
  broken; tests used real Chromium via Playwright, never Arc's AppleScript bridge. Fix: `decode_js_result` decodes up
  to three layers and always returns a dict (Chrome and Arc formats both tested).
- Second bug: the whole sentence was routed as `open <"canvas find my ib 150 class navigate…">`. Now a multi-step
  request does its first step instantly (open Canvas) and hands the rest to the agent with a note that step 1 is done;
  long targets are never treated as a site name.

### The user's conversation log (2026-11-19, 16:44–16:48): what went wrong and the fixes
- "learn this, for canvas, …" went to chat, which replied "I have memorized that instruction" — nothing was saved.
  → "learn / note / note to self / keep in mind / tip / for future reference / from now on" are memory commands.
- "open my ib150 course" matched a LabFlow page in history on the word "course", opened it AND remembered it, so
  "open ib150" went straight back to LabFlow. → generic words (course, class, homework, resources, week…) never pick
  a site; a history match is only remembered when the name is in the address; "no, that's wrong" forgets the last
  learned site; while you're on a site, "my X" first looks for a matching link on the page.
- "why are you on labflow?" got nonsense and "yes" got "Opening IB150 now, sir" with nothing done: chat had no idea
  what JARVIS had done and could claim actions. → chat gets "what's happening now" (front app, page, last action),
  must never claim to act or save, and replies `ACTION: <request>` to hand work to the part that can act (never
  back to chat).
- Your Canvas tips weren't shown to the AI unless the request said "canvas". → notes about the site you're on are
  added to the AI's context (lincoln.instructure.com → canvas).
- "Untitled is open." → the page's address is shown when the title isn't loaded yet.

### "Started messing around in the ChatGPT tab" + "draining the f*** out of my battery" (2026-11-19)
- ChatGPT has a "Canvas" button: for "open canvas" the page-click path ran before the user's own sites, clicked it, and
  the agent carried on inside ChatGPT. Now a site you actually use with that name (history, address match) wins over a
  same-named button on an unrelated page; generic words never count, so "open my ib biology hl course" on Canvas still
  clicks the course link (filler like "my … course" is stripped for the page match); word-level nicknames ("ib") only
  count when they're the whole name.
- Battery: Balanced on battery kept models 30 min, pre-loaded on wake, and would use/pre-load the 17 GB smart model.
  Now on battery: smart model never used (unless Max Performance is chosen) and never pre-loaded at all; models kept
  ≤5 min; only the small chat model pre-loads; speech models unload after 5 idle min; the big model is kept 2 min.
