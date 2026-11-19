# DragShelf — testing record

This file records what has actually been verified, where, and what hasn't been.

## Environment used for development

- The code was written in a **Linux** container. There was no macOS, no Xcode and no macOS SDK.
- No Mac was connected to the session.
- GitHub Actions macOS runners are unavailable for this repository. Jobs on `macos-*` are cancelled
  before their first step; Linux jobs run normally.

Because of that, the AppKit/SwiftUI application **has not been compiled, launched, or used
interactively.** Nothing in this repository claims otherwise.

## Verified

| What | How | Result |
|---|---|---|
| DragShelfCore builds | `swift build`, Swift 6.0.3, Linux | ✅ |
| Activation geometry: edges, corners, inclusive top row, shared-edge pass-through, partial display overlap, primary-only, dwell, re-arm, deadline recheck | `swift test`, 15 tests | ✅ |
| Hide rules: empty, populated, pointer, drag-in, drag-out, pin, shortcut grace, focus loss, locks, reset on hide, retention while hidden | 12 tests | ✅ |
| Library: stacking, insert, reorder, unstack/stack, remove from stack, move between shelves, merge, delete, rename/prune, normalise, blob references | 12 tests | ✅ |
| Storage: save/load round trip, corrupt file moved aside, path-escape rejection, **GC never touches originals or symlink targets**, non-UUID refusal, usage, filename sanitising | 9 tests | ✅ |
| Settings defaults, round trip, tolerant decoding, clamping, shortcut validity; retention expiry; layout sizing and on-screen placement; link detection (rejects `file:`, `javascript:`) | 16 tests | ✅ |
| **Total** | **64 unit tests** | **64 passed, 0 failed** |
| App sources are syntactically valid Swift | `swiftc -parse` on every file | ✅ (syntax only; no type-checking without the macOS SDK) |
| Build scripts are syntactically valid | `bash -n` | ✅ |

## Ready to run on a Mac — not yet run

`scripts/build-app.sh --test` (and `setup-mac.sh`) runs the self-test automatically:

```bash
build/DragShelf.app/Contents/MacOS/DragShelf --selftest
```

It drives the real AppKit code paths through private pasteboards, without any GUI interaction and
without touching your clipboard. It checks:
1. A 4-file drag becomes references (no copies), with the right kinds, as one stack.
2. Dragging out offers exactly the original file URLs.
3. Text round trip; rich text keeps RTF and plain flavours; link keeps URL and title.
4. Image data is stored and copied back byte-identical, and the drag offers a file promise plus PNG.
5. Persistence round trip.
6. A renamed original is followed. A deleted original shows unavailable. A different file at the
   old path is **not** substituted.
7. Scripts are flagged before opening; documents aren't.
8. Clearing deletes DragShelf's copies, and the originals are byte-for-byte untouched.
9. Edge geometry against the real display arrangement.

Idle cost:

```bash
build/DragShelf.app/Contents/MacOS/DragShelf --measure-idle 30
```

## Interactive checklist (needs a person at a Mac)

None of these have been performed yet.

| # | Scenario | Status |
|---|---|---|
| 1 | Drag a file from Finder to the right edge → shelf appears → drop | ☐ not yet tested |
| 2 | Switch to another app | ☐ |
| 3 | Reveal (edge hover or ⌃⌥Space) → drag the file into another app (Mail/Messages/Finder) → it copies, original stays | ☐ |
| 4 | Drag several files at once → one stack; click to expand; drag the stack out | ☐ |
| 5 | Drag an image from Safari/Chrome → thumbnail; drag it to Finder → real image file | ☐ |
| 6 | Drag selected text from TextEdit/Notes → text tile; drag out into another editor; source text not removed | ☐ |
| 7 | Drag a link from the address bar or a page → link tile with title; drag into Messages/Finder | ☐ |
| 8 | PDF and folder | ☐ |
| 9 | Hide and reopen a populated shelf (move away; rest at edge; shortcut) | ☐ |
| 10 | Multiple Spaces and a full-screen app | ☐ |
| 11 | Two displays (each edge, pass-through edge between them, unplug/replug) | ☐ |
| 12 | Quit and relaunch → items restored (default), cleared (clear-on-quit), expired (interval) | ☐ |
| 13 | Clear the shelf → originals untouched in Finder | ☐ |
| 14 | Empty shelf disappears after ~0.8 s | ☐ |
| 15 | Populated shelf is completely invisible after moving away; status-bar count shows items | ☐ |
| 16 | Normal drag-and-drop elsewhere (Finder→Finder, text in editors, window moves) is unaffected when the shelf isn't triggered | ☐ |
| — | Screenshot floating thumbnail drag (file promise) | ☐ |
| — | VoiceOver reads tiles; keyboard navigation (arrows, Space, Return, ⌫, ⌘C, Esc) | ☐ |
| — | Reduce Motion / Increase Contrast / light & dark | ☐ |

## Known risks to check first on a Mac

- **Compile errors.** The app target was reviewed carefully but has never been through the
  compiler. If `swift build` reports errors, send the output — they are usually quick to fix.
- **Global mouse monitoring during another app's drag session.** Global monitors for mouse events
  need no permission, and the drag-pasteboard check is a known technique. That events keep flowing to
  the monitor during every source app's drag loop still has to be confirmed on your macOS version.
  If not, edge reveal won't trigger, and the shortcut remains the fallback.
- **First-click behaviour** of header buttons on the non-activating panel. `acceptsFirstMouse` is
  overridden on the hosting and tile views.
