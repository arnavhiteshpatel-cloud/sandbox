# DragShelf

A hidden, edge-activated drag-and-drop shelf for macOS. Drag something toward the edge of the
screen and a small glass shelf slides in. Drop it, keep working, and drag it out later into any app.
When you're not using it, DragShelf is invisible: no Dock icon, no floating window.

Everything stays on your Mac. There are no accounts, subscriptions, analytics or cloud services.
It needs no special permissions.

> **Status — please read [docs/TESTING.md](docs/TESTING.md).** The platform-independent core is
> unit-tested (64 tests). The AppKit/SwiftUI app was written without access to a Mac: it has
> **not yet been compiled or run on macOS**. Building it on your Mac (below) is the first real check.

## Install on your Mac

One step, inside this repository folder:

```bash
bash DragShelf/scripts/setup-mac.sh
```

This script:
- Checks for Apple's free Command Line Tools and offers to install them if missing.
- Builds `DragShelf.app` and runs the tests and the AppKit self-test.
- Creates `DragShelf/build/DragShelf.dmg`.
- Installs the app to `/Applications` (or `~/Applications`) and opens it.

No admin password or Apple developer account is needed. The app is ad-hoc signed.

Manual build:

```bash
cd DragShelf
```

```bash
scripts/build-app.sh --test --dmg
```

The app is written to `build/DragShelf.app` and the DMG to `build/DragShelf.dmg`. Add `--install` to install and launch it.

Requires macOS 13 Ventura or later and Swift 5.9 or later. Any current Command Line Tools have it.

## Using it

| | |
|---|---|
| **Reveal while dragging** | Drag a file, image, text selection or link and hold it against the **right edge** of the screen for a moment (configurable: any edges, a hot corner, delay, sensitivity). |
| **Keyboard** | **⌃⌥Space** shows/hides the shelf from any app. **⌃⌥V** adds the current clipboard to the shelf. |
| **Drag out** | Drag tiles into Finder, Mail, Messages, Slack, an editor… Select several (⌘-click / ⇧-click) to drag them together. Dragging out **copies**; originals never move unless you allow it in Settings. |
| **Stacks** | Items dropped together form a stack. Click it to see its contents. Drag the stack to drag all of them. |
| **Hiding** | An empty shelf hides by itself. A shelf with items hides when you move away, and keeps the items. Rest the pointer at the edge to bring it back. **Pin** keeps it open. **Esc** hides it. |
| **Actions** | Right-click a tile: Open, Quick Look, Copy, Copy Path, Show in Finder, Share, Save a Copy, Edit Text, Move to Shelf, Remove. Space = Quick Look, ⌫ = remove, ⌘Z = undo, arrows = navigate. |
| **Several shelves** | ⋯ → New Shelf. Chips appear in the header. Drop items on a chip to move them. Right-click a chip to rename, merge or delete it. With one shelf, none of this is visible. |
| **Clipboard history** | Optional, off by default (Settings → Privacy). |

Settings are in the menu-bar tray icon → Settings…, or **⌘,** while the shelf is focused. If you
hide the menu-bar icon, open DragShelf again from Applications or Spotlight to get to Settings.

## How it works (short)

- **Edge activation:** DragShelf watches mouse-button and drag events. macOS allows this without
  Accessibility permission. It also checks the system's shared *drag pasteboard*, which every app
  writes to when it starts a real drag. Only then does it check whether the pointer rests in an
  edge region. Ordinary mouse movement, text selection and window dragging never open the shelf.
  The full explanation and its limits are in [docs/DESIGN.md](docs/DESIGN.md).
- **Storage:** files and folders are kept as *references* (bookmarks plus a file-identity check).
  Nothing is copied, and a moved file is followed. A deleted file, or a different file at the old
  path, is shown as unavailable and never substituted. Text, links, images from browsers,
  screenshots and promised files are stored as copies in
  `~/Library/Application Support/DragShelf`, with every original data flavour preserved.
  Clearing a shelf deletes only those copies.
- **Idle cost:** no timers or polling while idle. Event monitors only do work while a mouse button
  is held, or on mouse moves when hover-reveal is active and the hidden shelf holds items. Measure it
  yourself: `DragShelf.app/Contents/MacOS/DragShelf --measure-idle 30`.

## Project layout

```
DragShelf/
  Package.swift
  Sources/DragShelfCore/   Foundation-only logic, unit-tested on macOS and Linux
    Activation.swift         edge/corner geometry, multi-display, dwell detector
    HideController.swift     the auto-hide rules as a pure state machine
    Models.swift             items, stacks, shelves, library operations
    ShelfStore.swift         persistence, owned-blob storage, safe garbage collection
    Settings.swift           settings (tolerant decoding), shortcuts, retention rules
    Layout.swift             shelf sizing/placement, text & link helpers
  Sources/DragShelf/       the macOS app (AppKit + SwiftUI)
    Activation/              DragMonitor (global drag detection), HotKeyCenter (Carbon hotkeys)
    DragDrop/                PasteboardIngestor (drops, promises), DragOut (writers, promises),
                             DropTargetView (NSDraggingDestination), TileInteractionView (drag source)
    Window/                  ShelfPanel (non-activating NSPanel), ShelfController (+DragDrop, +Actions)
    UI/                      SwiftUI shelf, tiles, previews, stacks, editor
    Items/                   FileResolver (bookmarks/identity), ThumbnailProvider (QuickLook)
    Model/                   ShelfModel, SettingsStore
    Settings/                Settings window
    SelfTest.swift           --selftest and --measure-idle
  Tests/DragShelfCoreTests/
  Resources/               Info.plist (LSUIElement), AppIcon.icns
  scripts/                 build-app.sh, setup-mac.sh
  docs/                    DESIGN.md, TESTING.md
```

Development:

```bash
cd DragShelf && swift test
```

That runs the core tests, on macOS or Linux. CI (`.github/workflows/dragshelf.yml`) runs
them on Linux, and builds plus self-tests the app on a macOS runner when one is available.
