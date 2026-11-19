import AppKit
import Carbon.HIToolbox
import Quartz
import UniformTypeIdentifiers
import DragShelfCore

/// An NSMenuItem that runs a closure.
final class ActionMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(_ title: String, symbol: String? = nil, key: String = "", modifiers: NSEvent.ModifierFlags = [.command],
         enabled: Bool = true, state: NSControl.StateValue = .off, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: key)
        target = self
        isEnabled = enabled
        self.state = state
        keyEquivalentModifierMask = modifiers
        if let s = symbol { image = NSImage(systemSymbolName: s, accessibilityDescription: nil) }
    }

    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func run() { handler() }
}

// MARK: - Selection & keyboard

extension ShelfController {
    var selectedTargets: [TileTarget] {
        model.visibleTargets.filter { model.selection.contains($0.id) }
    }

    var selectedItems: [ShelfItem] {
        selectedTargets.flatMap { model.items(for: $0) }
    }

    func handleKey(_ e: NSEvent) -> Bool {
        let code = Int(e.keyCode)
        // While editing text, the text view owns the keyboard (only Escape is ours).
        if model.editingItemID != nil {
            if code == kVK_Escape { cancelEditing(); return true }
            return false
        }
        let cmd = e.modifierFlags.contains(.command)
        if cmd, let ch = e.charactersIgnoringModifiers?.lowercased() {
            switch ch {
            case "c": copy(selectedItems); return true
            case "a": model.selection = Set(model.visibleTargets.map(\.id)); return true
            case "z": model.undo(); return true
            case ",": openSettingsHandler?(); return true
            case "w": dismiss(); return true
            case "o": open(selectedItems); return true
            case "r": reveal(selectedItems); return true
            case "y": quickLook(selectedItems); return true
            default: return false
            }
        }
        switch code {
        case kVK_Escape:
            escape()
            return true
        case kVK_Space:
            quickLook(selectedItems.isEmpty ? model.visibleTargets.prefix(1).flatMap { model.items(for: $0) } : selectedItems)
            return true
        case kVK_Return, kVK_ANSI_KeypadEnter:
            if let t = selectedTargets.first, case .entry(let id) = t, model.library.entry(id)?.isStack == true {
                expand(id)
            } else {
                open(selectedItems)
            }
            return true
        case kVK_Delete, kVK_ForwardDelete:
            removeSelected()
            return true
        case kVK_LeftArrow: moveSelection(dx: -1, dy: 0); return true
        case kVK_RightArrow: moveSelection(dx: 1, dy: 0); return true
        case kVK_UpArrow: moveSelection(dx: 0, dy: -1); return true
        case kVK_DownArrow: moveSelection(dx: 0, dy: 1); return true
        default:
            return false
        }
    }

    func escape() {
        if QLPreviewPanel.sharedPreviewPanelExists(), let ql = QLPreviewPanel.shared(), ql.isVisible {
            ql.orderOut(nil)
        } else if model.expandedEntryID != nil {
            collapse()
        } else {
            // Hides without deleting anything.
            dismiss()
        }
    }

    /// Arrow-key navigation in reading order of the grid.
    func moveSelection(dx: Int, dy: Int) {
        let ids = model.visibleTargets.map(\.id)
        guard !ids.isEmpty else { return }
        let layout = currentLayout()
        let step: Int
        if edge.orientation == .vertical {
            step = dx + dy * max(1, layout.columns)
        } else {
            // LazyHGrid fills each column top-to-bottom.
            step = dy + dx * max(1, layout.rows)
        }
        let current = ids.lastIndex { model.selection.contains($0) }
        let next = current.map { min(max($0 + step, 0), ids.count - 1) } ?? 0
        model.selection = [ids[next]]
        lastClickedID = ids[next]
    }

    // MARK: Stacks & shelves

    func expand(_ entryID: UUID) {
        model.expandedEntryID = entryID
        model.selection = []
        relayout(animated: true)
    }

    func collapse() {
        let id = model.expandedEntryID
        model.expandedEntryID = nil
        model.selection = id.map { [$0] } ?? []
        relayout(animated: true)
    }

    func switchToShelf(_ id: UUID) {
        guard id != model.library.activeShelfID else { return }
        model.expandedEntryID = nil
        model.selection = []
        model.mutate { $0.activate(id) }
        model.refreshAvailability()
    }

    func newShelf() {
        model.expandedEntryID = nil
        model.selection = []
        model.mutate { _ = $0.newShelf() }
    }

    func renameShelf(_ id: UUID) {
        guard let shelf = model.library.shelves.first(where: { $0.id == id }) else { return }
        let field = NSTextField(string: shelf.name ?? "")
        field.placeholderString = model.library.displayName(of: shelf)
        field.frame = NSRect(x: 0, y: 0, width: 240, height: 24)
        let alert = NSAlert()
        alert.messageText = "Rename Shelf"
        alert.informativeText = "Leave empty to use the default name."
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        if runModal(alert) == .alertFirstButtonReturn {
            model.mutate { $0.rename(id, to: field.stringValue) }
        }
    }

    func deleteShelf(_ id: UUID) {
        model.mutate(undoable: true) { _ = $0.deleteShelf(id) }
        model.collectGarbage()
    }

    func clearShelf(_ id: UUID? = nil) {
        let target = id ?? model.library.activeShelfID
        model.expandedEntryID = nil
        model.mutate(undoable: true) { _ = $0.clear(target) }
        model.collectGarbage()
    }

    func removeSelected() {
        let targets = selectedTargets
        guard !targets.isEmpty else { return }
        remove(targets)
    }

    func remove(_ targets: [TileTarget]) {
        let entries = Set(targets.compactMap { t -> UUID? in if case .entry(let e) = t { return e }; return nil })
        let items = Set(targets.compactMap { t -> UUID? in if case .item(let i) = t { return i }; return nil })
        model.mutate(undoable: true) { lib in
            lib.removeEntries(entries)
            lib.removeItems(items)
        }
        model.selection = []
        model.collectGarbage()
    }

    func removeUnavailable() {
        let missing = Set(model.library.allItems.filter { !model.isAvailable($0) }.map(\.id))
        guard !missing.isEmpty else { return }
        model.mutate(undoable: true) { $0.removeItems(missing) }
    }

    // MARK: Item actions

    /// Runs an alert modally, activating DragShelf for it and keeping the shelf up meanwhile.
    @discardableResult
    func runModal(_ alert: NSAlert) -> NSApplication.ModalResponse {
        send(.lock)
        defer { send(.unlock) }
        activateApp()
        return alert.runModal()
    }

    func activateApp() {
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func open(_ items: [ShelfItem]) {
        for item in items.prefix(20) {
            switch item.content {
            case .file, .storedFile:
                guard model.isAvailable(item), let url = model.fileURL(for: item) else { NSSound.beep(); continue }
                if FileResolver.isPotentiallyExecutable(url) {
                    let alert = NSAlert()
                    alert.alertStyle = .warning
                    alert.messageText = "Open “\(item.displayName)”?"
                    alert.informativeText = "This item is an application, script or other file that can run code. DragShelf never opens such items automatically."
                    alert.addButton(withTitle: "Cancel")
                    alert.addButton(withTitle: "Open")
                    guard runModal(alert) == .alertSecondButtonReturn else { continue }
                }
                NSWorkspace.shared.open(url)
            case .data(let d):
                if item.kind == .link, let s = d.url, let u = URL(string: s), Self.isSafeWebURL(u) {
                    NSWorkspace.shared.open(u)
                } else if item.kind == .text {
                    beginEditing(item)
                } else if let url = model.fileURL(for: item) {
                    // Image/PDF data: open the stored copy (a plain image/PDF file) in its viewer.
                    NSWorkspace.shared.open(url)
                } else {
                    NSSound.beep()
                }
            }
        }
    }

    static func isSafeWebURL(_ u: URL) -> Bool {
        ["http", "https", "mailto", "ftp"].contains(u.scheme?.lowercased() ?? "")
    }

    func reveal(_ items: [ShelfItem]) {
        let urls = items.compactMap { item -> URL? in
            guard model.isAvailable(item) else { return nil }
            switch item.content {
            case .file, .storedFile: return model.fileURL(for: item)
            case .data: return nil
            }
        }
        guard !urls.isEmpty else { NSSound.beep(); return }
        NSWorkspace.shared.activateFileViewerSelecting(urls)
    }

    func copy(_ items: [ShelfItem]) {
        guard !items.isEmpty else { return }
        let writers = DragOut.writers(for: items, model: model, forDrag: false)
        guard !writers.isEmpty else { NSSound.beep(); return }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.writeObjects(writers)
        clipboardWriteHandler?()
    }

    func copyPaths(_ items: [ShelfItem]) {
        let paths = items.compactMap { model.fileURL(for: $0)?.path }
        guard !paths.isEmpty else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(paths.joined(separator: "\n"), forType: .string)
        clipboardWriteHandler?()
    }

    func copyLink(_ item: ShelfItem) {
        guard case .data(let d) = item.content, let s = d.url else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        if let u = URL(string: s) { pb.writeObjects([u as NSURL]) }
        pb.setString(s, forType: .string)
        clipboardWriteHandler?()
    }

    func share(_ items: [ShelfItem], from view: NSView) {
        let objects: [Any] = items.compactMap { (item: ShelfItem) -> Any? in
            switch item.content {
            case .file, .storedFile: return model.fileURL(for: item)
            case .data(let d):
                if item.kind == .link, let s = d.url { return URL(string: s) }
                if let url = model.fileURL(for: item) { return url }
                return d.text
            }
        }
        guard !objects.isEmpty else { return }
        let picker = NSSharingServicePicker(items: objects)
        picker.delegate = self
        send(.lock)
        picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }

    func quickLook(_ items: [ShelfItem]) {
        let urls = items.compactMap(previewURL)
        guard !urls.isEmpty else { NSSound.beep(); return }
        quickLook.urls = urls
        panel.quickLookController = quickLook
        if !isQuickLookLocked {
            isQuickLookLocked = true
            send(.lock)
        }
        quickLook.onEnd = { [weak self] in
            guard let self = self, self.isQuickLookLocked else { return }
            self.isQuickLookLocked = false
            self.send(.unlock)
        }
        activateApp()
        panel.makeKeyAndOrderFront(nil)
        guard let ql = QLPreviewPanel.shared() else { return }
        if ql.isVisible {
            ql.reloadData()
        } else {
            ql.makeKeyAndOrderFront(nil)
        }
    }

    /// A file QuickLook can show for the item (text is written to a temporary .txt).
    private func previewURL(_ item: ShelfItem) -> URL? {
        if case .data(let d) = item.content, item.kind == .text || item.kind == .link {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("DragShelf-Preview", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(item.id.uuidString + ".txt")
            let text = item.kind == .link ? (d.url ?? "") : (d.text ?? "")
            try? text.write(to: url, atomically: true, encoding: .utf8)
            return url
        }
        guard model.isAvailable(item) else { return nil }
        return model.fileURL(for: item)
    }

    func saveCopy(_ item: ShelfItem) {
        let savePanel = NSSavePanel()
        var name = FileNames.sanitize(item.displayName)
        var source: URL?
        var text: String?
        switch item.content {
        case .file, .storedFile:
            source = model.fileURL(for: item)
            if let s = source { name = s.lastPathComponent }
        case .data(let d):
            if item.kind == .text || item.kind == .link {
                text = item.kind == .link ? d.url : d.text
                if !name.lowercased().hasSuffix(".txt") { name += ".txt" }
                savePanel.allowedContentTypes = [.plainText]
            } else if let rep = DataFlavors.previewRepresentation(d) ?? d.representations.first {
                source = model.store.blobURL(rep.blob)
                if let ext = DataFlavors.fileExtension(for: rep.type), !name.lowercased().hasSuffix("." + ext) { name += "." + ext }
            }
        }
        guard source != nil || text != nil else { NSSound.beep(); return }
        savePanel.nameFieldStringValue = name
        savePanel.canCreateDirectories = true

        send(.lock)
        defer { send(.unlock) }
        activateApp()
        guard savePanel.runModal() == .OK, let dest = savePanel.url else { return }
        do {
            if let src = source {
                // Never write onto the original itself.
                guard src.standardizedFileURL.path != dest.standardizedFileURL.path else { return }
                if FileManager.default.fileExists(atPath: dest.path) {
                    // The user confirmed "Replace" in the save panel; keep the old file recoverable.
                    try FileManager.default.trashItem(at: dest, resultingItemURL: nil)
                }
                try FileManager.default.copyItem(at: src, to: dest)
            } else if let t = text {
                try t.write(to: dest, atomically: true, encoding: .utf8)
            }
        } catch {
            let alert = NSAlert(error: error)
            runModal(alert)
        }
    }

    // MARK: Text editing

    func beginEditing(_ item: ShelfItem) {
        guard item.kind == .text, case .data = item.content else { return }
        model.editingItemID = item.id
        send(.lock)
        relayout(animated: true)
        focusPanel()
    }

    func commitEditing(_ newText: String) {
        guard let id = model.editingItemID, let old = model.library.item(id) else { cancelEditing(); return }
        model.editingItemID = nil
        send(.unlock)
        relayout(animated: true)
        guard case .data(let d) = old.content, newText != d.text else { return }
        guard let fresh = ingestor.makeTextItem(newText) else { return }
        var updated = old
        updated.content = fresh.content
        updated.displayName = fresh.displayName
        updated.storedBytes = fresh.storedBytes
        model.mutate(undoable: true) { $0.updateItem(updated) }
        model.collectGarbage()
    }

    func cancelEditing() {
        guard model.editingItemID != nil else { return }
        model.editingItemID = nil
        send(.unlock)
        relayout(animated: true)
    }
}

// MARK: - Menus

extension ShelfController: NSMenuDelegate, NSSharingServicePickerDelegate {
    func menuWillOpen(_ menu: NSMenu) { send(.lock) }
    func menuDidClose(_ menu: NSMenu) {
        // Actions from the menu run after it closes; unlock on the next turn of the run loop.
        DispatchQueue.main.async { [weak self] in self?.send(.unlock) }
    }

    func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, didChoose service: NSSharingService?) {
        send(.unlock)
    }

    func tileMenu(_ target: TileTarget, view: TileInteractionView) -> NSMenu? {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self

        if case .shelf(let id) = target {
            buildShelfMenu(menu, shelfID: id)
            return menu
        }

        let targets = model.selection.contains(target.id) ? selectedTargets : [target]
        let items = targets.flatMap { model.items(for: $0) }
        guard let first = items.first else { return nil }
        let single = items.count == 1
        let fileLike = items.allSatisfy { (i: ShelfItem) -> Bool in
            if case .data = i.content { return false }
            return true
        }
        let anyAvailable = items.contains { model.isAvailable($0) }

        // Primary
        if single, first.kind == .link {
            menu.addItem(ActionMenuItem("Open Link", symbol: "safari") { [weak self] in self?.open(items) })
        } else if single, first.kind == .text, case .data = first.content {
            menu.addItem(ActionMenuItem("Edit Text…", symbol: "pencil") { [weak self] in self?.beginEditing(first) })
        } else {
            menu.addItem(ActionMenuItem(single ? "Open" : "Open \(items.count) Items", symbol: "arrow.up.forward.app",
                                        enabled: anyAvailable) { [weak self] in self?.open(items) })
        }
        menu.addItem(ActionMenuItem("Quick Look", symbol: "eye") { [weak self] in self?.quickLook(items) })
        menu.addItem(.separator())

        // Copy & share
        if single, first.kind == .link {
            menu.addItem(ActionMenuItem("Copy Link", symbol: "link") { [weak self] in self?.copyLink(first) })
        }
        menu.addItem(ActionMenuItem(single && first.kind == .image ? "Copy Image" : "Copy", symbol: "doc.on.doc",
                                    enabled: anyAvailable) { [weak self] in self?.copy(items) })
        if fileLike {
            menu.addItem(ActionMenuItem(single ? "Copy Path" : "Copy Paths", symbol: "folder",
                                        enabled: anyAvailable) { [weak self] in self?.copyPaths(items) })
            let isReference = items.allSatisfy { $0.isReferenceToOriginal }
            menu.addItem(ActionMenuItem(isReference ? "Show Original in Finder" : "Show in Finder", symbol: "magnifyingglass",
                                        enabled: anyAvailable) { [weak self] in self?.reveal(items) })
        }
        menu.addItem(ActionMenuItem("Share…", symbol: "square.and.arrow.up") { [weak self, weak view] in
            guard let self = self, let view = view else { return }
            self.share(items, from: view)
        })
        if single {
            let title = (first.kind == .text || first.kind == .link) ? "Save as Text File…" : "Save a Copy…"
            menu.addItem(ActionMenuItem(title, symbol: "square.and.arrow.down",
                                        enabled: model.isAvailable(first)) { [weak self] in self?.saveCopy(first) })
        }

        // Organise
        menu.addItem(.separator())
        if case .entry(let eid) = target, model.library.entry(eid)?.isStack == true, targets.count == 1 {
            menu.addItem(ActionMenuItem("Show Stack Contents", symbol: "square.stack.3d.up") { [weak self] in self?.expand(eid) })
            menu.addItem(ActionMenuItem("Unstack", symbol: "square.grid.2x2") { [weak self] in
                self?.model.mutate { $0.unstack(eid) }
            })
        }
        let entryIDs = targets.compactMap { t -> UUID? in if case .entry(let e) = t { return e }; return nil }
        if entryIDs.count > 1 {
            menu.addItem(ActionMenuItem("Stack Together", symbol: "square.stack") { [weak self] in
                self?.model.mutate { $0.stack(entryIDs) }
            })
        }
        let moveMenu = NSMenu()
        moveMenu.autoenablesItems = false
        let itemIDs = targets.compactMap { t -> UUID? in if case .item(let i) = t { return i }; return nil }
        for shelf in model.library.shelves where shelf.id != model.library.activeShelfID {
            moveMenu.addItem(ActionMenuItem(model.library.displayName(of: shelf)) { [weak self] in
                self?.model.mutate { lib in
                    lib.moveEntries(entryIDs, toShelf: shelf.id)
                    lib.moveItems(itemIDs, toShelf: shelf.id)
                }
            })
        }
        if !moveMenu.items.isEmpty { moveMenu.addItem(.separator()) }
        moveMenu.addItem(ActionMenuItem("New Shelf") { [weak self] in
            guard let self = self else { return }
            self.model.mutate { lib in
                let id = lib.newShelf(activate: false)
                lib.moveEntries(entryIDs, toShelf: id)
                lib.moveItems(itemIDs, toShelf: id)
            }
        })
        let moveItem = NSMenuItem(title: "Move to Shelf", action: nil, keyEquivalent: "")
        moveItem.image = NSImage(systemSymbolName: "rectangle.portrait.and.arrow.right", accessibilityDescription: nil)
        moveItem.submenu = moveMenu
        menu.addItem(moveItem)

        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Remove from Shelf", symbol: "xmark.circle") { [weak self] in self?.remove(targets) })
        return menu
    }

    private func buildShelfMenu(_ menu: NSMenu, shelfID: UUID) {
        menu.addItem(ActionMenuItem("Rename…", symbol: "pencil") { [weak self] in self?.renameShelf(shelfID) })
        let others = model.library.shelves.filter { $0.id != shelfID }
        if !others.isEmpty {
            let merge = NSMenu()
            merge.autoenablesItems = false
            for s in others {
                merge.addItem(ActionMenuItem(model.library.displayName(of: s)) { [weak self] in
                    self?.model.mutate { $0.merge(shelfID, into: s.id) }
                })
            }
            let mergeItem = NSMenuItem(title: "Merge Into", action: nil, keyEquivalent: "")
            mergeItem.image = NSImage(systemSymbolName: "arrow.triangle.merge", accessibilityDescription: nil)
            mergeItem.submenu = merge
            menu.addItem(mergeItem)
        }
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Clear Shelf", symbol: "trash") { [weak self] in self?.clearShelf(shelfID) })
        menu.addItem(ActionMenuItem("Delete Shelf", symbol: "minus.circle", enabled: model.library.shelves.count > 1) { [weak self] in
            self?.deleteShelf(shelfID)
        })
    }

    /// The header's "more" menu.
    func showMoreMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        menu.addItem(ActionMenuItem("New Shelf", symbol: "plus.rectangle.on.rectangle") { [weak self] in self?.newShelf() })
        menu.addItem(ActionMenuItem("Add Clipboard to Shelf", symbol: "doc.on.clipboard") { [weak self] in self?.addClipboardHandler?() })
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Undo", symbol: "arrow.uturn.backward", key: "z", enabled: model.canUndo) { [weak self] in self?.model.undo() })
        let unavailable = model.library.allItems.contains { !model.isAvailable($0) }
        menu.addItem(ActionMenuItem("Remove Unavailable Items", symbol: "exclamationmark.triangle", enabled: unavailable) { [weak self] in
            self?.removeUnavailable()
        })
        menu.addItem(ActionMenuItem("Clear Shelf", symbol: "trash", enabled: !model.activeShelf.isEmpty) { [weak self] in self?.clearShelf() })
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem("Settings…", symbol: "gearshape", key: ",") { [weak self] in self?.openSettingsHandler?() })
        menu.addItem(ActionMenuItem("Quit DragShelf", symbol: "power", key: "q") { NSApp.terminate(nil) })
        let p = panel.mouseLocationOutsideOfEventStream
        menu.popUp(positioning: nil, at: dropView.convert(p, from: nil), in: dropView)
    }
}
