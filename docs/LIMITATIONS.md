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

* **⌥⇧C needs Accessibility.** macOS 15 blocks Option/Option+Shift-only global shortcuts via `RegisterEventHotKey`, so
  push-to-talk uses a keyboard event tap (it sees key events system-wide but only acts on ⌥⇧C). Without
  Accessibility it falls back to ⌃⌥C.

* **Wake word:** the pre-trained `hey_jarvis` model expects "hey JARVIS". "JARVIS" alone may not trigger it; use the hot key
  or train a custom openWakeWord model. The sound-alike "Hey Travis" scored 0.48 against a 0.5 threshold in testing, so tune
  sensitivity to your voice and room. The `hey_jarvis` model is CC BY-NC-SA 4.0: fine for personal use, not for selling.
* **No acoustic echo cancellation:** barge-in works through the wake word or hot key while JARVIS speaks, not by simply talking
  over it (that would let JARVIS hear itself).
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
  *partially* matching prompt cache for it. Every new AI task therefore pays for a full prompt evaluation of about 1.4k–2.4k
  tokens. Follow-up steps within a task are cheap. Measure with `jarvis bench`; consider a non-hybrid model if it's too slow.
* **Arc's future:** The Browser Company moved Arc to maintenance mode in 2025. JARVIS also supports Chrome, Brave, Edge and Safari
  (Settings → Browser).
* **Rebuilding the app resets permissions** unless you sign with a stable identity ([SETUP.md](SETUP.md)).
* **Semantic search** needs the embedding model in Ollama. Without it, search falls back to keyword + Spotlight.
