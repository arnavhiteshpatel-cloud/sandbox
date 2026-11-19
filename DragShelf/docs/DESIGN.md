# DragShelf — design notes

## 1. Detecting a drag anywhere on the system

macOS has no public API that says "a drag session is in progress in some app". The options
considered:

| Approach | Verdict |
|---|---|
| `NSEvent.addGlobalMonitorForEvents` for `.leftMouseDown/.leftMouseDragged/.leftMouseUp` | **Used.** Mouse events (unlike key events) can be monitored globally **without Accessibility permission**. The monitor is passive and can't block or alter events. |
| `NSPasteboard(name: .drag).changeCount` | **Used, to tell real drags apart.** Every AppKit drag session (`NSDraggingSession` / `dragImage`) writes its items to the shared drag pasteboard. The change count is recorded at mouse-down. If it changes while the button is still held, a real drag with content has started. This rules out text selection, window moves, marquee selection and so on. The query runs at most about 30 times a second, and only while the button is held before a drag is recognised. |
| `CGEventTap` | Rejected: needs Accessibility (or Input Monitoring) permission and can affect event delivery. |
| A permanent invisible window along the edge that accepts drags | Rejected as the primary mechanism. To receive `draggingEntered` it must accept mouse events, so it would steal clicks at the screen edge. It also adds a permanent window. |
| Accessibility API | Not needed. |

**What actually happens**
1. Mouse down anywhere: the drag-pasteboard change count is remembered.
2. Mouse dragged: if the count changed, the drag is real. Pointer positions go to
   `ActivationDetector` (DragShelfCore), which tests them against the enabled edges and corner of
   the display under the pointer.
3. The pointer has to stay in the band for the activation delay (0.25 s by default). If it stops
   moving, no events arrive, so one one-shot check is scheduled at the deadline.
4. The shelf (a normal `NSDraggingDestination`) appears next to the edge. The drag still in
   progress is delivered to it by AppKit as usual, so dropping works like dropping on any window.

**Limitations (honest)**
- Drags that don't use the system drag pasteboard aren't recognised. This is rare (some games,
  remote-desktop and VM windows). The keyboard shortcut works everywhere.
- Escape hides the shelf when it has keyboard focus. That happens when it's revealed with the
  shortcut or you click it. A shelf revealed by a drag doesn't take focus, so it never interrupts
  what you're typing. It hides by itself instead.
- Global keyboard shortcuts use `RegisterEventHotKey`. The system delivers only the registered
  combination, so no Accessibility permission is needed and other keystrokes are never seen. If
  another app already owns the combination, Settings says so.

**Avoiding accidental activation**
- Edge reveal needs a real drag *and* a dwell time. Passing through the edge doesn't count, and the
  dwell restarts when the pointer leaves.
- An edge that leads onto another display is a pass-through, not a physical edge, so it's ignored.
  The check is per point, so partially overlapping displays of different heights work.
- Hover reveal (no drag) only exists while the shelf is hidden *and* holds items. It uses a longer
  delay (activation delay + 0.6 s). The mouse-moved monitor is removed whenever it isn't needed.

## 2. Hiding rules

`HideController` (DragShelfCore) is a pure state machine with unit tests. The app feeds it events:
revealed, pointer entered/exited, drag entered/exited, drop performed, drag-out began/ended, pinned,
item count, modal lock/unlock (menus, Quick Look, save panels, the text editor) and focus
gained/lost. It answers either *stay* or *hide after N seconds*. Only one cancellable timer exists,
and only while the shelf is visible.

- Pinned → never auto-hides.
- Drag hovering the shelf, drag-out in progress, pointer over it, or a menu/editor/Quick Look open → stays.
- Empty → hides after the "empty" delay (0.8 s). Populated → hides after the collapse delay (1.2 s).
  Items are kept either way.
- Shortcut reveal → stays until the pointer has visited and left, focus moves elsewhere, Esc, or
  the shortcut again.
- When the timer fires, the real pointer position is checked again. During drags AppKit doesn't
  deliver tracking events reliably. If the pointer is over the shelf, or a drag is still going and
  the pointer rests at the edge or right next to the shelf, the timer is re-armed.

## 3. Windows, Spaces, displays

- `ShelfPanel` is a borderless `NSPanel` with `.nonactivatingPanel`. Clicking or dragging from it
  never activates DragShelf, so the app you're in keeps focus.
- Window level is `.floating`. Collection behaviour is `canJoinAllSpaces`, `fullScreenAuxiliary`,
  `stationary` and `ignoresCycle`, so it appears on every Space and over full-screen apps, and is
  never in ⌘-Tab or Mission Control.
- Placement uses the display's `visibleFrame`, so the shelf never covers the menu bar or Dock. It's
  centred on the pointer along the edge, and clamped on screen.
- Display mode: *every display* has its own activation edges, and the shelf appears where it was
  triggered. Or *primary display only*. Display changes (`didChangeScreenParametersNotification`)
  and wake both refresh the geometry. A shelf on a display that disappeared moves to the main display.
- Sizing comes from `ShelfLayout`. A left/right edge gives a column (1 column up to 3 tiles, then
  2). A top/bottom edge gives a strip (1 row up to 6, then 2). Beyond 80 % of the screen it scrolls.

## 4. Drag and drop

**In.** `PasteboardIngestor` reads the drag pasteboard synchronously during
`performDragOperation`, in this order of preference:
1. **File URLs.** Files and folders become references: a bookmark, the path, and the identity
   (inode plus creation date). Nothing is copied.
2. **File promises** (`NSFilePromiseReceiver`). Screenshots' floating thumbnail, Photos, Mail
   attachments and browser images are received into `blobs/<UUID>/`, on a background queue with a
   timeout. A link drag that also promises a `.webloc` stays a link.
3. **Everything else.** Every pasteboard flavour of every item is stored verbatim as a blob (each
   up to 256 MB). Examples: RTF and plain text, URL plus title, PNG and TIFF, app-specific types.
   Items marked concealed or transient (the nspasteboard.org conventions password managers use) are
   never stored.

DragShelf always answers external drops with **copy**. Answering *move* would make some sources,
such as text editors, delete what you dragged.

**Out.** `DragOut` makes one `NSDraggingItem` per item:
- references and stored files → the file URL;
- image/PDF data → an `NSFilePromiseProvider` subclass that also carries every stored flavour.
  Finder gets a real file and apps get the data directly;
- text, links and other data → an `NSPasteboardItem` with every original flavour.

The source operation mask is **copy only** by default. Finder would otherwise *move* an original on
the same volume. Settings → "Allow moving original files" adds move. Drops back onto the shelf are
recognised as internal: they reorder, or move items to another shelf's chip.

**Tiles.** Each SwiftUI tile has a transparent AppKit `TileInteractionView` over it. It handles
click-through on the non-activating panel, selection, multi-item `beginDraggingSession`, context
menus and hover. This way dragging never waits on a SwiftUI gesture. Accessibility comes from the
SwiftUI tile: label, selected trait, and named actions (Open, Quick Look, Copy, Remove).

## 5. Storage and persistence

- `~/Library/Application Support/DragShelf/state.json` holds the library, written atomically and
  debounced by 0.3 s. A file that won't decode is moved aside, not deleted.
- `blobs/<UUID>/…` holds owned content. Garbage collection deletes only UUID-named children of
  `blobs/` that no item and no undo snapshot reference. It removes symlinks as links, and never
  follows paths outside `blobs/`. The unit tests cover this, including a symlink that points at a
  "precious" original.
- Retention options: keep until removed; clear when DragShelf quits (and after a crash, items are
  not restored); or remove items N hours after they were added. That uses one one-shot timer for
  the next expiry, re-checked on wake.
- Originals: if bookmark resolution finds the **same** file (identity matches) at a new path, the
  tile follows it and the tooltip says it moved. If the file was deleted or is in the Trash, the
  tile shows *unavailable*. If a **different** file now sits at the old path, the tile shows
  *unavailable* and the impostor is never used.
- Storage usage shows in Settings → Storage. Past the configurable limit, a warning badge appears
  in the shelf header.

## 6. Security and privacy

- No network access, except the opt-in "Load website icons" setting. That requests
  `https://<host>/favicon.ico` from the link's own site, with an ephemeral session and no cookies.
- No analytics, accounts, crash reporters or screen capture.
- Dropped content is inert data. Opening an app, script, installer package, `.command` or other
  executable item from the shelf always asks for confirmation first. Links open only for
  http(s), mailto and ftp. Text is never evaluated.
- Stored file names are sanitised: no path separators, control characters or leading dots, and a
  length cap. Blob paths are validated to stay inside `blobs/`.
- Not sandboxed. A sandboxed app could keep references to arbitrary user files only by asking
  for broad file access. Without the sandbox, plain bookmarks work, and macOS (TCC) still asks
  before DragShelf can read the Desktop, Documents or Downloads folders, with the purpose strings
  in Info.plist.

## 7. Performance

- Idle means no timers and no polling. Mouse monitors run a few comparisons per event, and only
  while a button is held. The hover monitor exists only when needed. The clipboard-history timer
  exists only if you enable it, and uses tolerance.
- Thumbnails come from `QLThumbnailGenerator` at tile size, rendering from the file on disk. They're
  cached in an `NSCache` limited to 64 MB, and in-flight requests are coalesced. Large images and
  videos are never loaded into memory.
- Measure idle cost with `DragShelf --measure-idle 30`. It reports CPU seconds used, as
  `getrusage` sees them, and resident memory.
