# Parity

> This repository also contains **DragShelf**, a hidden drag-and-drop shelf for macOS — see [`DragShelf/README.md`](DragShelf/README.md).

A premium, local-first speedcubing timer for macOS (Apple Silicon), built to replace csTimer —
with a futuristic HUD design, a live 3D scramble cube, full csTimer import, deep analytics and
training tools. Everything runs offline. No account, subscription, cloud service or AI is needed.

## Install (no build tools required)

1. Open the repository's **Actions** tab on GitHub → workflow **"Build macOS app"** → latest
   successful run → download the artifact **Parity-macOS-arm64** (contains `Parity_*.dmg`
   and `Parity.app.zip`).
2. Open the `.dmg` and drag **Parity** to Applications.
3. The app is ad-hoc signed (no paid Apple developer account), so on first launch macOS will
   block it. Either right-click Parity → **Open** → **Open**, or run once in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Parity.app
```

> Artifacts on GitHub expire after 90 days — keep the `.dmg`, or build from source below.

## Easiest: one-step setup

In Terminal, inside this folder:

```bash
bash scripts/setup-mac.sh
```

It installs the free build tools (only if missing, no admin password), builds Parity, runs its
self-test, installs it to Applications and opens it. The only click needed is "Install" if macOS asks
for its command-line tools.

## Build from source on your Mac (manual)

One-time setup (free tools):

```bash
xcode-select --install
```

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Install Node.js 22 LTS from nodejs.org, then in this folder:

```bash
npm ci
```

```bash
npx tauri build --target aarch64-apple-darwin
```

The app appears in `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Parity.app`
(and a `.dmg` next to it in `bundle/dmg/`). For live development: `npx tauri dev`.

## Importing your csTimer history

In csTimer: **Export → Export to file** (saves `cstimer_YYYYMMDD_hhmmss.txt`).
In Parity: **Settings → Data → Import…** and choose that file. You get a preview (every
session, solve count, date range, and a check against csTimer's own cached count/mean)
before anything is written. After importing, a verification report compares what is stored in
the database with the source, solve by solve. Re-importing a newer backup only adds new solves.
Any import can be undone from **Import history**. The original file is only read, never modified,
and a copy is kept inside the database.

## Your data

- Database: `~/Library/Application Support/app.parity.timer/parity.sqlite` (SQLite, WAL,
  synchronous writes — a solve is on disk before it is shown).
- Backups: `…/app.parity.timer/backups/` — daily at launch and before every import, rollback and
  restore (folder configurable in Settings → Data).
- Export at any time to csTimer format or a full Parity JSON backup.

## Keyboard

Space (tap) inspection · Space (hold until green, release) start · any key stop · ⌥Z delete last ·
⌘Z/⇧⌘Z undo/redo · ⌘1/2/3 OK/+2/DNF · ← → scrambles · ⌥↑/⌥↓ sessions · F fullscreen · `?` all shortcuts.

## Development

```bash
npm run dev          # browser dev server (IndexedDB backend) on http://127.0.0.1:1420
npx vitest run       # unit tests (stats, importer, cube/algorithms, timer engine, analytics, training)
cd src-tauri && cargo test --lib   # SQLite layer tests
node tests/e2e/acceptance.mjs      # end-to-end acceptance tests against the dev server
```

See `docs/ARCHITECTURE.md`, `docs/PROGRESS.md` (status & how to resume), `docs/CSTIMER-PARITY.md`
(csTimer parity checklist) and `docs/VERIFICATION.md` (test evidence).

## Licences

Parity's own code: MIT. Uses cubing.js (MPL-2.0, unmodified), Tauri, React, zustand, uPlot (MIT),
SQLite (public domain), Inter & JetBrains Mono (SIL OFL). Statistics conventions follow csTimer
(GPL-3.0); no csTimer code is included.
