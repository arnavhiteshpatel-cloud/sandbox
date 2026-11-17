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
| Subscription | Claude access ends **2026-12-05**. Nothing at runtime may depend on Claude or Anthropic. |

## Environment facts

- Development so far happened in a **Linux x86_64 cloud container** (Claude Code on the web). **No Mac was attached.**
  Consequently, nothing macOS-specific (Swift build, Accessibility, microphone, Arc, power) has been executed yet.
- Target: MacBook Pro 14" (Nov 2024), M4 Pro, 24 GB, macOS 15.7.3 (as reported by the user; `jarvis doctor` verifies this on the Mac).
