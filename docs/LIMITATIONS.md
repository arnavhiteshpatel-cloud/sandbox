# Known limitations

Honest list, newest understanding first. "Unverified" means designed and written but not yet run on a Mac.

## Not yet verified on the Mac (highest priority)

* **Nothing macOS-specific has run yet.** The Swift shell, AppleScript/Arc control, Accessibility, Quartz input, Vision
  OCR, microphone/speaker I/O, MLX Whisper, the app bundle and the power behaviour were all written in a Linux container.
  Expect a round of fixes on first build. The Python core (78 tests), the browser JavaScript (8 tests in real Chromium),
  real-model voice pipeline and real-model agent runs were verified on Linux. See [TESTING.md](TESTING.md).
* **Swift compile:** all six Swift files pass `swiftc -parse` (Swift 6.0.3). `Daemon.swift` also type-checks on Linux;
  the AppKit/WebKit/Carbon parts can only be type-checked on macOS.
* **Arc `execute javascript`:** Arc's AppleScript dictionary supports it, but whether Arc requires a setting to allow it is
  unverified. Without it, page reading/clicking falls back to the accessibility tree (slower, less precise).
* **TCC attribution:** the design assumes macOS attributes the Python child's microphone/accessibility/automation use to
  JARVIS.app (the "responsible process"). If a prompt names "python3" instead, grant that entry.

## By design / platform limits

* **Every app is reachable, but not every app is equally controllable.** Order of reliability: built-in integrations
  (Notes, Reminders, Calendar, Mail, Messages) → AppleScript for scriptable apps → the accessibility tree (most native and
  Electron apps) → screenshot + OCR clicking (anything visible, slowest). Games, remote desktops, canvas-only apps and secure
  input fields (passwords) can't be operated. Unverified on the Mac: brightness media keys on the built-in display, Wi-Fi
  toggling without an admin prompt, and the exact System Settings pane identifiers on 15.7 (unknown panes open Settings' main page).

* **⌥⇧C needs Accessibility.** macOS 15 blocks Option/Option+Shift-only global shortcuts via `RegisterEventHotKey`, so
  push-to-talk uses a keyboard event tap (it sees key events system-wide but only acts on ⌥⇧C). Without
  Accessibility it falls back to ⌃⌥C.

* **Wake word:** the pre-trained `hey_jarvis` model expects "hey JARVIS". "JARVIS" alone may not trigger it; use the hot key
  or train a custom openWakeWord model. The sound-alike "Hey Travis" scored 0.48 against a 0.5 threshold in testing, so tune
  sensitivity to your voice and room. The `hey_jarvis` model is CC BY-NC-SA 4.0: fine for personal use, not for selling.
* **No true acoustic echo cancellation:** talking over JARVIS works through a voice-activity model, a measured echo model and
  ducking (see JOURNAL, 2026-11-19). It was tested with recorded speech and simulated echo, not with your Mac's speakers.
  With very loud speakers and a quiet voice it may need a second or a louder word; Esc, the talk key and "Hey JARVIS" always
  work. Headphones make it near-instant.
* **The microphone indicator** (orange dot) is on whenever the wake word is listening (on AC by your choice).
* **Do Not Disturb/Focus** has no public API. It works through a Shortcuts-app shortcut you create once.
* **Web pages:** cross-origin iframes, canvas-rendered apps and closed shadow DOMs are invisible to DOM control. Screenshot +
  OCR/vision is the fallback, which is slower and coordinate-based.
* **Single display:** screenshots/OCR use the main display.
* **Apps that block automation** (some Electron or secure-input fields, password prompts) can't be driven. JARVIS reports the
  failure instead of pretending.
* **Local model quality:** a 9B model is far below frontier cloud models. Long, ambiguous, multi-site tasks will sometimes fail.
  The agent is bounded and verifies outcomes, so failures are reported rather than hidden. Accuracy numbers: [MODELS.md](MODELS.md).
* **First AI step latency:** Qwen3.5 is a hybrid (recurrent + attention) model, and llama.cpp-based runtimes can't reuse a
  *partially* matching prompt cache for it. Every agent task therefore pays for a full prompt evaluation of about 3k tokens.
  Questions that don't involve your computer skip the agent (~250 tokens) and simple commands skip the AI entirely. Every
  reply's latency is in the activity log; measure with `jarvis bench`.
* **Arc's future:** The Browser Company moved Arc to maintenance mode in 2025. JARVIS also supports Chrome, Brave, Edge and Safari
  (Settings → Browser).
* **Permissions after rebuilds:** builds are signed with a local certificate so permissions persist. If that certificate couldn't be created, each rebuild needs permissions granted again ([SETUP.md](SETUP.md)).
* **Semantic search** needs the embedding model in Ollama. Without it, search falls back to keyword + Spotlight.
