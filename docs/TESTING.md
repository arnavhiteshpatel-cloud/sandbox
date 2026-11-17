# Testing

## 1. Unit and integration tests (run anywhere)

```bash
JARVIS_PLATFORM=fake python -m pytest -q
```

78 tests, all passing (Linux, Python 3.12, 2026-11-17). They cover:

| File | What |
|---|---|
| `test_router.py` | wake-phrase stripping, STT artefacts ("I.B." → "ib"), 19 built-in intents, element matching, refusal of ambiguous matches |
| `test_shortcuts.py` | validation, parameters, matching without false positives, retries, verification failures, `if` branches, reusable blocks, cancellation, authorization of code steps, persistence/edit/delete/import/export, voice-description parsing |
| `test_assistant_flow.py` | **"open my IB" → "go to the assignments" → "scroll down" → "go back" with zero LLM calls**; ordinal follow-ups handed to the agent with page context; memory surviving a restart; stop and replace-instruction; full voice shortcut-creation dialog; submit confirmation; shortcuts working with the LLM down |
| `test_agent.py` | invalid/unknown tool recovery, failed-click recovery, step limits, repeated-failure abort, mid-task cancellation, Trash confirmation, untrusted-content wrapping, Qwen JSON/XML tool-call parsing, tool subsetting |
| `test_memory_search_policy.py` | explicit vs inferred memory, indexing (hidden/Library folders excluded), relevance, recency, duplicates, incremental re-index, deletions, Office extraction, safety policy, power-mode policy (wake word only on AC, task-aware switching) |
| `test_browser_js.py` | the JavaScript injected into Arc, run in **real Chromium**: discovery including shadow DOM, stable ids, clicks, React-style inputs, inner scroll containers, page reading |

These use `platform/fake.py`, a simulated computer. They prove the logic, **not** that macOS automation works.

## 2. Real-model checks (run in development, Linux CPU)

* **Voice pipeline** (`python -m jarvis.voice.selftest`): real Kokoro → real openWakeWord → real Whisper → router. Result in
  [benchmarks/voice-selftest-linux-cpu.json](benchmarks/voice-selftest-linux-cpu.json): **6/6**.
  * 4/4 wake phrases detected across 4 voices (scores 0.75–0.96); 0/2 false triggers ("Hey Travis…" peaked at 0.48).
  * Transcripts exact; intents correct.
  * Energy gate: 30 s of silence → 0 inferences (3 ms CPU) vs 1,598 ms without the gate.
  * This found and fixed a real bug: openWakeWord 0.4's `reset()` kept about 10 s of audio features, so a previous
    "Hey JARVIS" could re-trigger.
* **Agent with a real model** (`jarvis bench`, Qwen3.5-4B on CPU): **11/11** on the current code, 0 invalid tool calls. See [MODELS.md](MODELS.md).

## 3. Acceptance tests (must run on the Mac)

```bash
/Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis.acceptance
```

The runner drives the real app through its API and checks real effects (Arc's actual URL, files on disk, processes,
power assertions). It asks you to confirm the parts that need a human (your voice, interruption, sleep, Wi-Fi off,
reboot) and appends timestamped evidence to `docs/ACCEPTANCE_RESULTS.md`.

### Status as of 2026-11-17

**None of the 40 acceptance tests has been performed on the Mac yet**, because no Mac was available to the development
session. I don't count simulated results as passes. What exists for each:

| # | Test | Automated? | Evidence so far (non-Mac) |
|---|---|---|---|
| 1 | Recognizes "Hey JARVIS" | human | synthetic voices 4/4 (Linux) |
| 2 | Understands a spoken instruction | human | synthetic transcripts + intents 4/4 |
| 3 | Local speech synthesis | human | Kokoro runs ~1.1–1.5× real time on 4 x86 cores |
| 4 | Follow-up conversation | human | flow test passes on simulator |
| 5 | Interruption | human | stop/replace tests pass; barge-in path not run with audio |
| 6 | No paid AI services | auto | by construction (local endpoints only) |
| 7–14 | Arc, apps, navigate, click, scroll, read, multistep, recovery | auto | browser JS in Chromium 8/8; logic on simulator |
| 15–19 | Shortcuts | auto (+restart) | logic on simulator |
| 20–24 | Memory and files | auto (+restart) | indexing/search on real files (Linux) |
| 25–29 | Power | `jarvis.powerprof` | none (needs Mac) |
| 30–32 | Sleep, wake, idle CPU | auto + human | none |
| 33–40 | Independence | auto + human | by construction |
