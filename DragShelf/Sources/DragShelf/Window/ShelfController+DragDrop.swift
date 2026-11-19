import AppKit
import DragShelfCore

// MARK: - Dropping onto the shelf

extension ShelfController: DropTargetDelegate {
    func isInternalDrag(_ info: NSDraggingInfo) -> Bool {
        guard let source = info.draggingSource as? ShelfController else { return false }
        return source === self
    }

    private func operation(for info: NSDraggingInfo) -> NSDragOperation {
        if isInternalDrag(info) { return .move }
        let mask = info.draggingSourceOperationMask
        // Always .copy for external content: returning .move would tell some sources (e.g. text
        // editors) to delete what was dragged. DragShelf never takes content away from its source.
        if mask.contains(.copy) { return .copy }
        if mask.contains(.generic) { return .generic }
        let promised = info.draggingPasteboard.canReadObject(forClasses: [NSFilePromiseReceiver.self], options: nil)
        if promised && mask.contains(.move) { return .move } // the source writes a new file for us
        if mask.contains(.link) { return .link }
        return []
    }

    func dropTargetEntered(_ info: NSDraggingInfo) -> NSDragOperation {
        send(.dragEntered)
        model.isDropTargeted = true
        return dropTargetUpdated(info)
    }

    func dropTargetUpdated(_ info: NSDraggingInfo) -> NSDragOperation {
        let p = dropView.convert(info.draggingLocation, from: nil)
        let chip = shelfChip(at: p)
        if model.dropTargetShelfID != chip { model.dropTargetShelfID = chip }
        let index = isInternalDrag(info) && chip == nil ? insertionIndex(at: p) : nil
        if model.dropInsertionIndex != index { model.dropInsertionIndex = index }
        return operation(for: info)
    }

    func dropTargetExited() {
        model.isDropTargeted = false
        model.dropInsertionIndex = nil
        model.dropTargetShelfID = nil
        send(.dragExited)
    }

    func dropTargetPerform(_ info: NSDraggingInfo) -> Bool {
        let p = dropView.convert(info.draggingLocation, from: nil)
        let chip = shelfChip(at: p)
        defer {
            model.isDropTargeted = false
            model.dropInsertionIndex = nil
            model.dropTargetShelfID = nil
            send(.dropPerformed)
        }

        if isInternalDrag(info) {
            let entryIDs = model.draggingOutEntryIDs
            let itemIDs = model.draggingOutItemIDs
            if let target = chip, target != model.library.activeShelfID {
                model.mutate { lib in
                    lib.moveEntries(entryIDs, toShelf: target)
                    lib.moveItems(itemIDs, toShelf: target)
                }
            } else if !entryIDs.isEmpty, model.expandedEntryID == nil {
                let index = insertionIndex(at: p) ?? model.activeShelf.entries.count
                model.mutate { lib in lib.moveEntries(entryIDs, toIndex: index, in: lib.activeShelfID) }
            }
            return true
        }

        let shelfID = chip ?? model.library.activeShelfID
        let stack = settings.stackMultiItemDrops
        let result = ingestor.ingest(info.draggingPasteboard) { [weak self] items in
            guard let self = self else { return }
            self.model.pendingReceives = max(0, self.model.pendingReceives - 1)
            self.model.add(items, stack: stack, shelf: shelfID)
        }
        if result.pendingPromises > 0 { model.pendingReceives += 1 }
        if !result.items.isEmpty { model.add(result.items, stack: stack, shelf: shelfID) }
        return !result.items.isEmpty || result.pendingPromises > 0
    }

    func dropTargetEnded() {
        model.isDropTargeted = false
        dragMonitor?.noteDragEnded()
    }

    func pointerEntered() { send(.pointerEntered) }
    func pointerExited() {
        send(.pointerExited)
        model.hovered = nil
    }

    // MARK: Geometry helpers

    /// Tile views currently in the panel, with their frames in `dropView` coordinates.
    private func liveTiles() -> [(TileInteractionView, CGRect)] {
        tileViews.allObjects.compactMap { v in
            guard v.window === panel, v.superview != nil, !v.isHiddenOrHasHiddenAncestor else { return nil }
            return (v, v.convert(v.bounds, to: dropView))
        }
    }

    func shelfChip(at p: CGPoint) -> UUID? {
        for (v, f) in liveTiles() {
            if case .shelf(let id) = v.target, f.insetBy(dx: -2, dy: -2).contains(p) { return id }
        }
        return nil
    }

    /// Reading-order insertion index for an internal reorder drop at `p`.
    func insertionIndex(at p: CGPoint) -> Int? {
        let entries = model.activeShelf.entries
        var best: (index: Int, frame: CGRect, distance: CGFloat)?
        for (v, f) in liveTiles() {
            guard case .entry(let id) = v.target, let i = entries.firstIndex(where: { $0.id == id }) else { continue }
            let d = hypot(f.midX - p.x, f.midY - p.y)
            if best == nil || d < best!.distance { best = (i, f, d) }
        }
        guard let b = best else { return nil }
        let after = edge.orientation == .vertical ? (p.x > b.frame.midX || p.y < b.frame.minY) : (p.x > b.frame.midX)
        return after ? b.index + 1 : b.index
    }
}

// MARK: - Tiles: selection, dragging out, hover

extension ShelfController: TileInteractionDelegate {
    func tileRegistered(_ view: TileInteractionView) {
        tileViews.add(view)
    }

    func tileHover(_ target: TileTarget, inside: Bool) {
        if inside {
            model.hovered = target
        } else if model.hovered == target {
            model.hovered = nil
        }
    }

    func tileClicked(_ target: TileTarget, modifiers: NSEvent.ModifierFlags, clickCount: Int) {
        if case .shelf(let id) = target {
            switchToShelf(id)
            return
        }
        let id = target.id
        if clickCount >= 2 {
            if case .entry(let eid) = target, let e = model.library.entry(eid), e.isStack {
                expand(eid)
            } else {
                open(model.items(for: target))
            }
            return
        }
        if modifiers.contains(.command) {
            if model.selection.contains(id) { model.selection.remove(id) } else { model.selection.insert(id) }
        } else if modifiers.contains(.shift), let anchor = lastClickedID {
            let ids = model.visibleTargets.map(\.id)
            if let a = ids.firstIndex(of: anchor), let b = ids.firstIndex(of: id) {
                model.selection = Set(ids[min(a, b)...max(a, b)])
            }
        } else if !model.selection.contains(id) {
            model.selection = [id]
        }
        lastClickedID = id
    }

    func tileMouseUp(_ target: TileTarget, modifiers: NSEvent.ModifierFlags) {
        guard modifiers.intersection([.command, .shift, .control]).isEmpty else { return }
        if case .shelf = target { return }
        // A plain click on a stack opens it; on a tile in a multi-selection, selects just it.
        if case .entry(let eid) = target, let e = model.library.entry(eid), e.isStack, model.selection.count <= 1 {
            expand(eid)
            return
        }
        model.selection = [target.id]
    }

    func tileBeganDrag(_ target: TileTarget, from view: TileInteractionView, event: NSEvent) {
        if case .shelf = target { return }
        let targets: [TileTarget]
        if model.selection.contains(target.id) {
            targets = model.visibleTargets.filter { model.selection.contains($0.id) }
        } else {
            targets = [target]
            model.selection = [target.id]
        }

        var draggingItems: [NSDraggingItem] = []
        let side: CGFloat = min(64, view.bounds.width)
        let base = NSRect(x: (view.bounds.width - side) / 2, y: (view.bounds.height - side) / 2, width: side, height: side)
        for t in targets {
            for (n, item) in model.items(for: t).enumerated() {
                guard let writer = DragOut.writer(for: item, model: model, forDrag: true) else { continue }
                let di = NSDraggingItem(pasteboardWriter: writer)
                let offset = CGFloat(min(n, 4)) * 3
                di.setDraggingFrame(base.offsetBy(dx: offset, dy: -offset), contents: DragOut.image(for: item, model: model, side: side))
                draggingItems.append(di)
            }
        }
        guard !draggingItems.isEmpty else {
            NSSound.beep()
            return
        }

        model.draggingOutEntryIDs = targets.compactMap { (t: TileTarget) -> UUID? in
            if case .entry(let e) = t { return e }
            return nil
        }
        model.draggingOutItemIDs = targets.compactMap { (t: TileTarget) -> UUID? in
            if case .item(let i) = t { return i }
            return nil
        }
        send(.dragOutBegan)
        let session = view.beginDraggingSession(with: draggingItems, event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = true
        session.draggingFormation = draggingItems.count > 1 ? .stack : .none
    }
}

// MARK: - Drag source

extension ShelfController: NSDraggingSource {
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        switch context {
        case .withinApplication:
            return [.move, .copy]
        case .outsideApplication:
            // Copy by default: Finder would otherwise *move* the original on the same volume.
            return settings.allowMovingOriginals ? [.copy, .move, .generic] : [.copy]
        @unknown default:
            return [.copy]
        }
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        let entryIDs = model.draggingOutEntryIDs
        let itemIDs = model.draggingOutItemIDs
        model.draggingOutEntryIDs = []
        model.draggingOutItemIDs = []
        let droppedOnShelf = isShown && panel.frame.contains(screenPoint)
        if settings.removeAfterDragOut, !operation.isEmpty, !droppedOnShelf {
            model.mutate(undoable: true) { lib in
                lib.removeEntries(Set(entryIDs))
                lib.removeItems(Set(itemIDs))
            }
        }
        send(.dragOutEnded)
        dragMonitor?.noteDragEnded()
    }
}
