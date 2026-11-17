# Verification record

All results below were produced on 2026-11-17 in the development container. "Synthetic" data is a
deterministic csTimer-format backup (`src/core/testdata.ts`) with 20,013 solves in 5 sessions
(incl. +2/DNF, comments with quotes/semicolons, missing dates, multi-phase splits, a string-encoded
session, extra csTimer fields, and csTimer's cached `stat` values). **The user's real export has not
been imported yet.**

## Unit tests — `npx vitest run` (99 tests)
- Statistics: csTimer trim table (ao5→1 … ao1000→50), DNF rules, Fenwick rolling averages equal a naive
  implementation on 3,000 random solves for mo3…ao1000, 20k×ao10000 under 1.5 s, csTimer formatting
  (truncate singles, round averages), time parsing.
- Importer: penalties, multi-phase conversion, extra-field preservation, invalid-entry reporting,
  exact field preservation for all 20,013 solves, csTimer cached count/mean match for every session,
  re-import = 0 added, incremental re-import adds only new solves, csTimer and Facelet export round trips
  are lossless, CSV round trip.
- Cube/algorithms: simulator agrees with cubing.js's solver; all 21 PLL and 57 OLL algorithms preserve
  F2L, orient/permute correctly and are pairwise distinct; training scramblers produce the requested states.
- Timer engine: hold/arm, early release, key repeat, inspection +2/DNF boundaries, voice-warning timing,
  multi-phase splits, blur/escape, modifier keys.
- Insights (PB thresholds), analytics (aggregation, milestones, Welch test, plateaus, 20k perf), training
  (SM-2, case selection, cross solver vs. known depth distribution).

## Rust — `cargo test --lib` (5 tests)
Round trip, atomic failed batch, import + rollback (keeps user solves), snapshot/validate/integrity,
20k bulk insert.

## Native app self-test (Tauri + SQLite, Linux build under Xvfb)
| Check | Result |
|---|---|
| Import 20,013 solves | ✅ commit 581 ms, reload 162 ms |
| Restart → all solves persisted, timed solve fields identical | ✅ 20,015/20,015 |
| Re-import detects duplicates | ✅ 20,013 duplicates, 0 added |
| Rollback removes only imported solves | ✅ removed 20,013, kept 2 |
| Restore from backup | ✅ 20,015 restored, integrity ok |

## End-to-end acceptance — `node tests/e2e/acceptance.mjs` (22/22)
Launch 375 ms · offline random-state scramble · inspection→green→run→stop records a 1,521 ms solve
(1,500 ms intended) · time hidden while solving · persistence after reload · ao5 / DNF / +2 / mo3 /
undo arithmetic · import preview shows 20,013 before writing · import verified · every field and order
matches the source · re-import adds 0 · search 91 ms · timer render 204 ms with 19k-solve session ·
backup restore · csTimer export contains every solve · zero network requests · no page errors.

## Production bundle smoke test — `node tests/e2e/prod-smoke.mjs`
Scrambles in web workers + WASM, 3D cube, keyboard solve, zero external requests, no errors.

## Acceptance criteria status
| # | Criterion | Status |
|---|---|---|
| 1 | Launches independently | ✅ Linux native build; macOS via CI (pending download on the Mac) |
| 2 | Polished, user-approved visual identity | ✅ HUD design approved iteratively |
| 3 | Generate scramble & time a real solve | ✅ |
| 4 | Solves persist after restart | ✅ (native + browser) |
| 5 | csTimer import without loss | ✅ synthetic · ⏳ real file |
| 6 | No duplicates on re-import | ✅ |
| 7 | Penalties & rolling averages correct | ✅ |
| 8 | Large datasets searchable/analysable | ✅ |
| 9 | Fullscreen timing | ✅ F / ⌃⌘F, UI hides while timing (native fullscreen API in Tauri) |
| 10 | Export & restore | ✅ |
| 11 | Runs without Claude/API credentials | ✅ no network at all |
| 12 | No subscription/cloud | ✅ |
