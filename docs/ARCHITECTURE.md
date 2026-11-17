# Architecture

```
┌──────────────────────── JARVIS.app (native, Swift, ~600 lines) ──────────────────────────┐
│ menu-bar item · popover · pill HUD panel · command-center window (all WKWebView → local UI) │
│ Carbon hot keys: hold ⌥⇧C = talk, ⌃⌥⌘. = stop · sleep/wake/lock/power-source notifications │
│ launch at login (SMAppService) · starts and supervises the service, restarts it on crash    │
└───────────────┬───────────────────────────────────────────────────────────────────────────┘
                │ HTTP + WebSocket on 127.0.0.1 (random token per launch, Host/Origin checks)
┌───────────────▼────────────── jarvis service (Python 3.12, embedded) ──────────────────────┐
│ server.py      local API + event stream                                                    │
│ assistant.py   routing, conversation context, dialogs (ask/confirm by voice or UI), tasks   │
│ router.py      Level 1: deterministic intents, text normalization, element matching        │
│ shortcuts/     model (schema+validation) · matcher · engine (steps, waits, verify, if,      │
│                retries, reusable blocks, agent steps) · store (SQLite, import/export, runs) │
│ agent/         Level 2/3: tools (schemas, risk) · policy (safety, enforced in code) ·       │
│                loop (bounded observe→act→verify, cancellation, recovery) · prompts          │
│ llm/           Ollama + OpenAI-compatible clients, robust tool-call parsing                 │
│ voice/         mic · wake word (energy-gated) · VAD capture · Whisper · Kokoro · barge-in   │
│ platform/      Computer interface · macos/ (apps, Arc/AppleScript+JS, AX, input, screen,    │
│                Vision OCR) · fake.py (simulator for tests only)                             │
│ memory.py      explicit vs inferred memories, FTS5                                          │
│ search/        extraction (PDF/Office/code/images) · incremental indexer · hybrid search     │
│ power.py       modes, auto-switching, task-aware deferral, charging-only indexing           │
└────────────────┬──────────────────────────────┬──────────────────────────────────────────────┘
                 │                              │
          Ollama (local LLMs)          macOS: Arc, Finder, AX, Vision, Spotlight, Shortcuts
```

## Request flow

1. **Input.** Wake word or held hot key → the mic captures until 750 ms of silence (or key release) → Whisper → text.
   Typed commands (popover, command center, `jarvis ask`) enter at the same point.
2. **Stop check.** "stop / cancel / never mind" cancels the running task and speech immediately.
3. **Shortcut match.** Exact or fuzzy (≥90 for phrases ≥8 chars) trigger match, including `{param}` slots.
4. **Built-ins.** Opening/quitting apps, URLs, volume, lock, time, battery, memory, power modes and browser follow-ups.
   "Click X" / "go to X" snapshot the page and click only on an **unambiguous** match (exact or a clear fuzzy winner).
5. **Agent.** Anything else goes to the local model with the current context (front app, browser URL/title, relevant
   memories, recent conversation, last result list) and a request-specific subset of tools.
6. **Reply** is spoken (Kokoro) and shown in the HUD. After a reply, a short hands-free follow-up window opens.

A new instruction while a task runs **replaces** it (cancellation is cooperative between steps, and immediate for
model calls and waits).

## Agent loop

* Each step is one model call returning tool calls (max 3 executed per step).
* Tool arguments are validated against their schema; errors go back to the model as tool results so it can recover.
* Repeated identical calls get a nudge at 3 and an abort at 5. The loop also stops after 5 consecutive failures,
  after the step limit (8/20/40 by mode) and at the wall-clock limit (90 s/5 min/15 min).
* History is **append-only** so the runtime's prompt cache stays valid. Older observations are compacted only when the
  context exceeds about 40k characters.
* `done(summary, success)` ends the task; a plain text answer also ends it (conversational replies).

## Safety model

* `agent/policy.py` decides per action: allow, block or confirm. Purchases/payments always confirm. Submit/send/delete
  confirm unless the user's own words asked for exactly that. Trash always confirms (files go to the Trash, never permanent
  deletion). Moves outside approved folders confirm. Blocked apps (Terminal, Keychain Access…) and `javascript:`/`file:`
  URLs are refused.
* Everything read from pages, files, OCR or screenshots is wrapped in `<untrusted>` tags, and the system prompt forbids
  following instructions inside them. Because enforcement lives in code, a prompt injection can at most *propose* an
  action, which the policy layer still gates.
* Shortcuts with `shell`/`applescript` steps created by voice, AI or import must be confirmed when they run. Only ones
  you wrote in the editor run directly.
* The API listens on loopback only and requires a per-launch token. It rejects foreign Host/Origin headers, so websites
  cannot drive JARVIS.

## Extending

* **New app integration:** add methods to `platform/base.py` → implement in `platform/macos/` → expose as an agent tool
  (`agent/tools.py`) and/or a shortcut action (`shortcuts/model.py` + `engine.py`).
* **New built-in command:** add a pattern in `router.route()` and a handler in `Assistant._builtin()`.
* **New model/runtime:** see [MODELS.md](MODELS.md); nothing else changes.
