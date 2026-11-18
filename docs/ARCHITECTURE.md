# Architecture

## Decision: Tauri 2 + React + TypeScript + SQLite (Rust)

| Option | Verdict |
|---|---|
| **Tauri 2** (WKWebView + Rust) | **Chosen.** ~9 MB app, fast startup, native window, Rust owns the database (real transactions, WAL), ad-hoc signable without a paid account, buildable in CI on Apple Silicon runners. |
| Electron | Works, but ~150 MB, bundles Chromium, higher idle memory; no advantage here. |
| SwiftUI native | Best platform feel, but cubing.js (the established scramble/3D library) is JavaScript; re-implementing random-state scramblers for all WCA events would be risky. Not buildable/testable in this Linux dev environment. |
| PWA / browser | No reliable file-system database or backups; storage can be evicted. |

## Layout

```
src/core/        Pure, unit-tested domain logic (no React)
  types.ts         Solve/Session/ImportRecord/Op model (csTimer-compatible encoding)
  time.ts          formatting/parsing; csTimer truncation semantics
  stats.ts         Fenwick-tree rolling trimmed averages, summaries, regression, Welch t-test
  importer.ts      csTimer JSON/CSV, Twisty Timer, Parity, plain-text parsers + validation
  importPlan.ts    duplicate detection (fingerprint multiset), session matching
  exporter.ts      csTimer JSON, Parity JSON, CSV
  cube.ts          NxN facelet simulator (verified against cubing.js)
  algs.ts / llstate.ts   verified OLL/PLL libraries
  insights.ts      PB targets, percentiles, streaks
  analytics.ts     aggregation, milestones, comparisons, plateaus
  train/           SRS, case selection, cross solver, phase stats
src/data/
  backend.ts       Backend interface; tauriBackend.ts (IPC → Rust) / webBackend.ts (IndexedDB)
  store.ts         zustand store; journaled, optimistic, undoable mutations
  derived.ts       memoised per-session statistics
  settings.ts      typed settings + themes
src/scramble/      cubing.js wrapper, training-state scramblers, prefetch queue
src/timer/         TimerEngine state machine (event timestamps), inspection feedback
src/ui/, src/views/  React UI (HUD design)
src-tauri/src/db.rs   SQLite schema, migrations, atomic batches, import/rollback, VACUUM INTO backups
src-tauri/src/lib.rs  Tauri commands, daily auto-backup, self-test hooks
```

## Data safety design

1. **Write path**: timer stop → op appended to a synchronous localStorage journal → memory updated →
   one SQLite transaction (`synchronous=FULL`, WAL) → journal entry removed. Journal is replayed at
   startup, so a crash between stop and commit cannot lose the solve.
2. **Deletes are soft** (tombstones) and undoable; a "Recently deleted" view restores them.
3. **Imports** run in a single transaction after an automatic `pre-import` snapshot; all imported
   rows carry `import_id`, so rollback is exact. The original file text is stored in the database.
4. **Backups** are consistent `VACUUM INTO` snapshots; restore validates the file
   (`PRAGMA integrity_check`, schema) and snapshots the current DB first. Never overwrites existing backups.
5. **Integrity check** command: SQLite check + orphan detection.
6. Schema has a `meta.schema_version`; migrations are additive (`if v < N`).

## Performance

- Rolling averages: Fenwick tree over value ranks → O(n log n) per average; ao10000 over 20k solves in a few ms.
- Memoisation keyed on array identity; solve lists virtualised.
- Measured (synthetic 20,013-solve csTimer backup): parse+plan 119 ms, native commit 581 ms, native reload 162 ms,
  timer screen render 204 ms, history search 91 ms.

## Builds

- `npm run build` → `dist/` (entry is a thin loader; the Vite preload helper is a separate chunk so
  cubing.js web workers never execute UI code).
- `npx tauri build --target aarch64-apple-darwin` → `.app` + `.dmg` (ad-hoc signed).
- CI: `.github/workflows/macos.yml` runs tests on Linux, builds on `macos-14` (arm64), runs the
  native self-test (`PARITY_SELFTEST=write|verify`) on the built binary, and uploads the artifacts.
