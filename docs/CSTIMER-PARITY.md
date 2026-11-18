# csTimer feature-parity checklist

Status legend: ✅ implemented & tested · 🟡 partial · ⛔ not implemented (reason given) · ➖ intentionally out of scope

This list was compiled from csTimer's source (`src/js/**`, studied Nov 2026), not from memory alone.
Parity does **not** claim full parity until every row is ✅ or ➖.

## Timer
| csTimer feature | Status | Notes |
|---|---|---|
| Spacebar hold-to-arm, release-to-start, any key stops | ✅ | Event-timestamp timing; unit + E2E tested |
| Hold time ("preTime": 0 / 0.3 / 0.55 / 1 s) | ✅ | Default 0.3 s like csTimer |
| WCA inspection (15 s), +2 after 15 s, DNF after 17 s | ✅ | Unit tested |
| Inspection voice / beep at 8 s and 12 s | ✅ | System speech (offline) + WebAudio beep |
| Inspection length option | ✅ | 8/12/15 s |
| Timer display while running (full / 0.1 / seconds / hidden) | ✅ | Default hidden ("solving") per user preference |
| Hide UI while timing | ✅ | |
| Multi-phase timing (split per key press) | ✅ | Per-session phase count; splits stored in csTimer's format |
| Typing input mode | ✅ | csTimer digit convention (1234 → 12.34) |
| Millisecond precision option | ✅ | 0.01 / 0.001; stats truncate like csTimer |
| Key auto-repeat / accidental input handling | ✅ | Repeat ignored; stop key cannot re-arm; blur cancels arming |
| Focus loss during solve | ✅ | Timer keeps running; arming cancelled |
| Stackmat / GAN / Bluetooth timers & smart cubes | ➖ | Excluded by request |
| Virtual cube timer | ⛔ | Not planned |

## Scrambles
| Feature | Status | Notes |
|---|---|---|
| All WCA events, random-state | ✅ | cubing.js (MPL-2.0): 2x2–7x7, BLD, FMC, OH, Clock, Mega, Pyra, Skewb, SQ1, 4/5BLD, MBLD; FTO |
| 3x3 training types: PLL, OLL, LL, ZBLL/COLL, ELL, CLL, LSLL, cross-solved (F2L), edges/corners only, LSE, random-move, 2-gen | ✅ | Random restricted *state* solved by cubing.js; unit-tested states |
| 2x2 CLL | ✅ | |
| Remaining csTimer special types (EG1/EG2, TCLL, Mehta, Yau/Hoya 4x4 stages, ZZLL, 2GLL, VLS/WVLS, …) | 🟡 | Unknown imported types are preserved verbatim; new scrambles fall back to the puzzle's WCA scrambler |
| Last / next scramble navigation | ✅ | ← / → |
| Custom scramble input | ✅ | Double-click scramble |
| Scramble image (net) | ✅ | Plus live 3D cube + animated scramble guide (new) |
| Scramble length option for random-move types | ⛔ | Fixed lengths |

## Sessions
| Feature | Status | Notes |
|---|---|---|
| Multiple sessions | ✅ | Unlimited (csTimer: 15 default) |
| Create / rename / delete | ✅ | Delete is undoable |
| Merge | ✅ | Chronological or append |
| Split | ✅ | At any solve |
| Reorder / sort | ✅ | Custom order + sort by name/size/recent |
| Session-specific scramble type & phases | ✅ | |
| Per-session CSV export | ✅ | csTimer CSV layout (re-importable) |
| Auto-switch session by scramble type | ⛔ | |

## Solves & history
| Feature | Status | Notes |
|---|---|---|
| Solve list with ao5/ao12 | ✅ | Recent strip + full History (virtualised, 20k+) |
| Penalties OK/+2/DNF, manual | ✅ | ⌘1/⌘2/⌘3, chips, bulk |
| Delete last solve (Alt+Z) | ✅ | ⌥Z or ⌘⌫; undoable; Recently-deleted bin |
| Undo / redo | ✅ | Every edit |
| Comments | ✅ | |
| Move solves between sessions | ✅ | |
| Edit solve date | ✅ | Solve sheet |
| Search / filter | ✅ | Text, session, penalty, time range, date range, sort (new) |

## Statistics
| Feature | Status | Notes |
|---|---|---|
| Current & best single | ✅ | |
| mo3, ao5, ao12, ao25, ao50, ao100, ao200, ao500, ao1000, ao2000, ao5000, ao10000 | ✅ | O(n log n) Fenwick; matches csTimer trimming & DNF rules (tests) |
| Customisable list of averages | ✅ | Any moN/aoN |
| Trim percentage | ✅ | 5% (csTimer default) or 10% |
| Average detail popup with copyable text | ✅ | Trimmed solves in parentheses |
| Session mean, median, σ, count | ✅ | |
| Distribution | ✅ | Analytics |
| Trend chart | ✅ | Timer panel + Analytics |
| Daily statistics | ✅ | Analytics (day/week/month/year) |
| Cross-session statistics | ✅ | Analytics scope |
| PB notifications | ✅ | Toast for new single / ao5 / ao12 / ao50 / ao100 / ao1000 PB |
| "Threshold to break best" | ✅ | PB targets panel (new) |

## Data
| Feature | Status | Notes |
|---|---|---|
| Export to file (csTimer JSON) | ✅ | Round-trip tested |
| Import from file (csTimer JSON) | ✅ | Preview, validation, duplicates, verification, rollback |
| Import from other timers (csTimer CSV, Twisty Timer) | ✅ | |
| Import from BlockKeeper / CubeDesk / DCTimer | ⛔ | |
| Cloud sync (WCA account / Google Drive) | ➖ | Local-only by design |
| Auto backup | ✅ | Daily + before every import/rollback/restore |

## Appearance & UX
| Feature | Status | Notes |
|---|---|---|
| Colour themes | ✅ | HUD, Vision, Telemetry, Pure Black |
| Font selection & sizes | ✅ | Timer font/weight/size, scramble size/font |
| Cube colour scheme | ✅ | |
| Keyboard shortcuts | ✅ | `?` overlay |
| Fullscreen | ✅ | F / ⌃⌘F |
| Languages | ➖ | English only |

## Tools
| Feature | Status | Notes |
|---|---|---|
| Cross solver | ✅ | Training → Cross |
| EOLine / Roux 1st block / 2x2 face solvers | ⛔ | |
| Metronome | ⛔ | |
| BLD helper, pattern tool | ⛔ | |
| Online battle / competition | ➖ | Offline app |
