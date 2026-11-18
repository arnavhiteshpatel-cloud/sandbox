# Progress & resume notes

_Last updated: 2026-11-17_

## User decisions (gathered by asking — do not change without asking)
- Look: **original, futuristic, sleek "HUD"** design (not a csTimer copy). Approved elements: **live 3D cube**, **time ruler**. Rejected: csTimer-like rail/stage layouts, flat "Studio" cards, bars for recent solves, progress bars on averages, the post-solve delta, anything under the timer.
- If the background is a plain colour it must be **black** (→ "Pure Black" theme). Default theme: HUD (ice blue).
- Timer font: **Inter** (weight 300). While solving: **static word "solving"**, no animation, time hidden.
- Start flow = csTimer: tap space → 15 s WCA inspection → hold 0.3 s until green → release → any key stops.
- **⌥Z deletes the last solve.**
- Bluetooth/smart cubes: out of scope.

## Status
| Area | State |
|---|---|
| Core stats (csTimer-exact), importer/exporter, cube simulator, verified OLL/PLL | ✅ tested |
| SQLite backend (Rust), backups, restore, rollback, integrity | ✅ tested (cargo + native self-test) |
| Timer screen (HUD), inspection, penalties, undo/redo, PB targets/toasts, scramble guide | ✅ tested (unit + E2E) |
| History, Sessions (create/rename/delete/merge/split/reorder/CSV), Settings, Import wizard | ✅ tested (E2E) |
| Analytics (11 sections) | ✅ tested (unit + browser) |
| Training (library, recognition, SRS drill, cross solver, F2L, phases, plan) | ✅ tested (unit + browser) |
| macOS packaging | ⏳ Workflow `.github/workflows/macos.yml` is ready, but GitHub stops every job before its first step (2 s, no logs) on this private repo — an account-level Actions restriction (billing/minutes/verification). Either fix that in GitHub Settings → Billing and re-run, or build locally on the Mac (README). |
| Import of the user's **real** csTimer export | ⏳ awaiting the file — only synthetic data so far |

## Next steps / open items
1. Confirm the macOS CI artifact builds; download and test on the user's M4 Mac.
2. Import the user's real csTimer backup; compare the import report against csTimer's displayed numbers (screenshot: 19,043 solves, mean 17.47, best 8.50, ao5 best 12.48, ao12 best 13.46 …).
3. Parity gaps listed as ⛔ in `docs/CSTIMER-PARITY.md` (extra csTimer scramble types, auto-switch session by event, metronome, BLD helper, EOLine/Roux solvers, BlockKeeper/CubeDesk import).
4. Ideas raised but not built: x-cross practice; dev-only per-window blur tuning.

## How to resume in a new Claude Code session
```bash
npm ci
npx vite --port 1420 &          # dev server (browser backend)
npx vitest run                  # 99 unit tests
node tests/e2e/acceptance.mjs   # 22 acceptance checks (needs dev server)
npm run build && npx vite preview --port 4173 & node tests/e2e/prod-smoke.mjs
cd src-tauri && cargo test --lib
```
In the browser console (dev only): `await __faceletDemo()` loads 20,013 synthetic csTimer solves;
`__faceletStore.getState()` exposes the store. Native self-test: run the built binary with
`PARITY_SELFTEST=write|verify PARITY_SELFTEST_OUT=report.json PARITY_DATA_DIR=/tmp/x`.
Design concept mockups live in `design/concepts/` (served by the dev server at `/design/concepts/*.html`).
