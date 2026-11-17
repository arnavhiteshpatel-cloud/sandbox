# Power and battery

**Status: designed for low power; not yet measured on the target Mac.** Development happened in a Linux cloud container
without access to your MacBook, so no Mac power numbers exist yet. Every figure below is labelled *measured (where)* or
*estimate*. Run `jarvis.powerprof` (below) to produce the real numbers.

## Design

| When | What runs | What doesn't |
|---|---|---|
| Idle, on battery (default: hotkey only) | native shell (event-driven), Python service blocked on events, Ollama server idle | microphone **closed**, no models in memory beyond unload timers, no polling except a 5-minute housekeeping tick |
| Idle, on AC (wake word on) | mic stream at 16 kHz, 80 ms frames; energy gate skips wake-word inference in silence | STT, TTS, LLM unloaded on timers |
| Talking | wake/PTT → capture → Whisper → router; LLM only when needed | |
| After use | LLM unloads after keep-alive (30 s / 5 min / 30 min by mode); Whisper and Kokoro after 60 s / 5 min / 30 min | |

Further measures:
* **Wake word only on AC** (your choice), so on battery there is no open microphone at all.
* **Energy gate:** *measured (Linux CPU, synthetic audio)* 30 s of quiet room noise → 0 of 375 frames sent to the neural
  model, 3 ms CPU in total, versus 1,598 ms CPU without the gate.
* **Deterministic first:** about half of everyday commands (apps, volume, scroll, back, click-by-name, shortcuts) never load the LLM.
* **Prompt-cache friendly agent:** append-only history, and when the runtime returns raw tool-call text, JARVIS replays it
  verbatim. *Measured (Linux CPU, llama-cpp-python, Qwen3.5-4B, before the verbatim replay):* only 5 of 19 agent calls reused
  the cache (61–127 new tokens). The other 14 re-read the whole prompt (about 2,400 tokens), because Qwen3.5's hybrid layers
  can't drop a mismatched tail. Tool subsetting cuts the per-task prompt by about 41% for web tasks. How well Ollama on macOS
  reuses the cache must be measured with `jarvis bench` (its "Median LLM call" column).
* **Pre-warm** the LLM on wake word only in Balanced/Max (overlaps model load with your speech); never in Battery Saver.
* **Indexing** only while charging, in a separate process at background QoS (`taskpolicy -b`: efficiency cores, throttled
  I/O), stopped when unplugged unless you started it.
* **No sleep prevention:** JARVIS takes no power assertion. The optional "keep awake during long tasks" uses
  `caffeinate -i` tied to the task and is off by default. Sleep stops the mic and indexing; wake restores them.
* **UI:** the HUD panel is hidden when idle, and animations run only while active (none in Battery Saver or with Reduce
  Motion). The WebSocket has no heartbeat.

## Modes

| | Battery Saver | Balanced (default on battery) | Max Performance (default on AC) |
|---|---|---|---|
| LLM | qwen3.5:4b, unload after 30 s | qwen3.5:9b, 5 min | qwen3.5:9b + thinking, 30 min |
| Speech recognition | Whisper small | Whisper large-v3-turbo | large-v3-turbo |
| Agent step limit | 8 | 20 | 40 |
| Screenshot vision | off (OCR only) | on | on |
| Pre-warm on wake | no | yes | yes |
| Indexing | never | while charging | while charging |
| Animations | none | normal | full |

Auto-switching: AC → Max, battery → Balanced, ≤30% → Battery Saver. Switching is deferred while a task runs and never
interrupts it. A manual choice holds until the power source changes.

## Measuring (on the Mac)

```bash
sudo /Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis.powerprof --minutes 3
```

Run it **unplugged**, with fixed display brightness and other apps quit. Per scenario it records:
* SoC power (CPU+GPU+ANE) from `powermetrics`, in mW (measured).
* Whole-system discharge power from the battery gauge (`ioreg` voltage × current), in W (measured). This includes the display, SSD and Wi-Fi.
* JARVIS processes' CPU %, peak RSS and idle wakeups/s, thermal pressure, and any sleep assertions.

Scenarios: baseline (JARVIS off) · idle hotkey-only · idle wake word (quiet) · idle wake word (speech nearby) · speech
recognition loop · LLM inference · screenshot analysis · browser automation · one command per minute · extended
autonomous task. Sleep/wake behaviour is checked by acceptance tests 30–31.

The report gives deltas against the baseline and an **estimated** battery-life effect: Δ W × 10 h against the 72.4 Wh design
capacity. Actual capacity is lower as the battery ages; `jarvis doctor` shows "Maximum Capacity".

### Expectations to verify (estimates, not measurements)

* Idle on battery (hotkey only): should be indistinguishable from baseline (≪ 0.1 W). Nothing runs.
* Idle with wake word: the target is < 0.5 W. Costs are the audio input path plus the energy-gated detector. CPU work is tiny
  (*measured on Linux:* 1.2–1.5 ms per 80 ms frame when it does run, about 2% of one core). The audio hardware itself is the
  unknown that only the Mac can measure.
* Inference: tens of watts briefly while generating; energy per command depends mostly on prompt length and model size.

Sources: [Ollama](https://ollama.com) keep_alive semantics; Apple `powermetrics(1)`, `taskpolicy(8)`, `pmset(1)`.
