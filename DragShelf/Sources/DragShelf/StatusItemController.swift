import AppKit
import DragShelfCore

/// The optional menu-bar icon (Settings → General → Show menu-bar icon).
final class StatusItemController: NSObject, NSMenuDelegate {
    weak var app: AppController?
    private var item: NSStatusItem?

    func setVisible(_ visible: Bool) {
        if visible, item == nil {
            let i = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            if let b = i.button {
                let img = NSImage(systemSymbolName: "tray.and.arrow.down", accessibilityDescription: "DragShelf")
                img?.isTemplate = true
                b.image = img
                b.imagePosition = .imageLeading
                b.setAccessibilityLabel("DragShelf")
            }
            let menu = NSMenu()
            menu.delegate = self
            menu.autoenablesItems = false
            i.menu = menu
            item = i
            refresh()
        } else if !visible, let i = item {
            NSStatusBar.system.removeStatusItem(i)
            item = nil
        }
    }

    /// Shows the number of held items next to the icon (so items are never "lost" while hidden).
    func refresh() {
        guard let b = item?.button, let app = app else { return }
        let n = app.model.library.totalItemCount
        b.title = n > 0 ? "\(n)" : ""
        b.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        b.toolTip = n > 0 ? "DragShelf — \(n) item\(n == 1 ? "" : "s") on your shelves" : "DragShelf"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let app = app else { return }
        let s = app.settings
        let lib = app.model.library

        let show = ActionMenuItem(app.shelf.isShown ? "Hide Shelf" : "Show Shelf", symbol: "sidebar.right",
                                  key: Self.keyEquivalent(s.toggleShortcut), modifiers: Self.modifiers(s.toggleShortcut)) {
            app.shelf.toggleFromShortcut()
        }
        menu.addItem(show)
        let clip = ActionMenuItem("Add Clipboard to Shelf", symbol: "doc.on.clipboard",
                                  key: s.clipboardShortcutEnabled ? Self.keyEquivalent(s.clipboardShortcut) : "",
                                  modifiers: Self.modifiers(s.clipboardShortcut)) {
            app.addClipboardToShelf()
        }
        menu.addItem(clip)
        menu.addItem(.separator())

        if lib.shelves.count > 1 {
            for shelf in lib.shelves {
                let title = "\(lib.displayName(of: shelf))  (\(shelf.itemCount))"
                menu.addItem(ActionMenuItem(title, state: shelf.id == lib.activeShelfID ? .on : .off) {
                    app.shelf.switchToShelf(shelf.id)
                    app.shelf.revealFromShortcut()
                })
            }
        }
        menu.addItem(ActionMenuItem("New Shelf", symbol: "plus.rectangle.on.rectangle") {
            app.shelf.newShelf()
            app.shelf.revealFromShortcut()
        })
        menu.addItem(ActionMenuItem("Clear Shelf", symbol: "trash", enabled: !lib.activeShelf.isEmpty) {
            app.shelf.clearShelf()
        })
        menu.addItem(.separator())

        let count = lib.totalItemCount
        let bytes = ByteCountFormatter.string(fromByteCount: app.model.storageBytes, countStyle: .file)
        let info = NSMenuItem(title: count == 0 ? "No items" : "\(count) item\(count == 1 ? "" : "s") · \(bytes) of copies",
                              action: nil, keyEquivalent: "")
        info.isEnabled = false
        menu.addItem(info)
        menu.addItem(ActionMenuItem("Settings…", symbol: "gearshape", key: ",") { app.openSettings() })
        menu.addItem(ActionMenuItem("Quit DragShelf", symbol: "power", key: "q") { NSApp.terminate(nil) })
    }

    static func keyEquivalent(_ combo: KeyCombo?) -> String {
        guard let c = combo else { return "" }
        if c.keyName == "Space" { return " " }
        return c.keyName.count == 1 ? c.keyName.lowercased() : ""
    }

    static func modifiers(_ combo: KeyCombo?) -> NSEvent.ModifierFlags {
        guard let c = combo else { return [] }
        var f: NSEvent.ModifierFlags = []
        if c.modifiers & KeyCombo.carbonCmd != 0 { f.insert(.command) }
        if c.modifiers & KeyCombo.carbonShift != 0 { f.insert(.shift) }
        if c.modifiers & KeyCombo.carbonOption != 0 { f.insert(.option) }
        if c.modifiers & KeyCombo.carbonControl != 0 { f.insert(.control) }
        return f
    }
}

/// Optional clipboard history. Off by default. macOS has no clipboard-change notification, so
/// while enabled this checks the pasteboard's change counter (a cheap integer read) every 0.75 s
/// with timer tolerance for energy efficiency. When disabled no timer exists.
/// Content marked concealed/transient (password managers) is never recorded.
final class ClipboardWatcher {
    static let shelfName = "Clipboard"
    static let maxEntries = 50

    var onNewContent: ((NSPasteboard) -> Void)?
    private var timer: Timer?
    private var lastChangeCount = NSPasteboard.general.changeCount

    func setEnabled(_ enabled: Bool) {
        if enabled, timer == nil {
            lastChangeCount = NSPasteboard.general.changeCount
            let t = Timer(timeInterval: 0.75, repeats: true) { [weak self] _ in self?.tick() }
            t.tolerance = 0.3
            RunLoop.main.add(t, forMode: .common)
            timer = t
        } else if !enabled {
            timer?.invalidate()
            timer = nil
        }
    }

    /// Call after DragShelf itself writes to the clipboard, so its own copies aren't recorded.
    func ignoreCurrentContents() {
        lastChangeCount = NSPasteboard.general.changeCount
    }

    private func tick() {
        let pb = NSPasteboard.general
        let c = pb.changeCount
        guard c != lastChangeCount else { return }
        lastChangeCount = c
        let types = Set((pb.types ?? []).map(\.rawValue))
        guard types.isDisjoint(with: DataFlavors.privateMarkers) else { return }
        onNewContent?(pb)
    }
}
