import AppKit
import Combine
import DragShelfCore

/// What the shelf grid is showing a tile for.
enum TileTarget: Hashable {
    /// A top-level tile (a single item or a stack).
    case entry(UUID)
    /// One item inside an expanded stack.
    case item(UUID)
    /// A shelf chip in the header (shelf switcher).
    case shelf(UUID)
}

/// Observable shelf state shared by the SwiftUI views and the controllers.
/// All mutations go through `mutate`, which persists (debounced) and notifies listeners.
final class ShelfModel: ObservableObject {
    @Published private(set) var library: ShelfLibrary
    @Published var selection: Set<UUID> = []          // entry IDs, or item IDs while a stack is expanded
    @Published var hovered: TileTarget?
    @Published var expandedEntryID: UUID?
    @Published var isDropTargeted = false
    @Published var dropTargetShelfID: UUID?
    @Published var dropInsertionIndex: Int?
    @Published var editingItemID: UUID?
    @Published var isPinned = false
    @Published var pendingReceives = 0
    @Published var storageBytes: Int64 = 0
    @Published var storageOverLimit = false
    @Published private(set) var availability: [UUID: FileResolver.Resolution] = [:]
    @Published var appearToken = 0

    let store: ShelfStore
    /// Called after every library change (item counts, visibility of hover monitoring, timers).
    var onLibraryChanged: (() -> Void)?

    /// Items currently being dragged out of the shelf (entry IDs and/or item IDs).
    var draggingOutEntryIDs: [UUID] = []
    var draggingOutItemIDs: [UUID] = []

    private var saveWork: DispatchWorkItem?
    private var undoStack: [ShelfLibrary] = []
    private let maxUndo = 10

    init(store: ShelfStore, library: ShelfLibrary) {
        self.store = store
        self.library = library
    }

    // MARK: Accessors

    var activeShelf: Shelf { library.activeShelf }

    var expandedEntry: ShelfEntry? {
        guard let id = expandedEntryID else { return nil }
        return activeShelf.entries.first { $0.id == id }
    }

    /// The tiles currently on screen, in order.
    var visibleTargets: [TileTarget] {
        if let e = expandedEntry { return e.items.map { TileTarget.item($0.id) } }
        return activeShelf.entries.map { TileTarget.entry($0.id) }
    }

    func items(for target: TileTarget) -> [ShelfItem] {
        switch target {
        case .entry(let id): return library.entry(id)?.items ?? []
        case .item(let id): return library.item(id).map { [$0] } ?? []
        case .shelf(let id): return library.shelves.first { $0.id == id }?.allItems ?? []
        }
    }

    func resolution(for item: ShelfItem) -> FileResolver.Resolution? {
        availability[item.id]
    }

    func isAvailable(_ item: ShelfItem) -> Bool {
        switch item.content {
        case .file:
            switch availability[item.id] {
            case .missing?, .replaced?: return false
            default: return true
            }
        case .storedFile(let f):
            guard let url = store.blobURL(f.relativePath) else { return false }
            return FileManager.default.fileExists(atPath: url.path)
        case .data:
            return true
        }
    }

    /// URL on disk for file-like items (resolved reference or owned copy).
    func fileURL(for item: ShelfItem) -> URL? {
        switch item.content {
        case .file(let ref):
            switch availability[item.id] ?? FileResolver.resolve(ref) {
            case .available(let u), .moved(let u): return u
            default: return nil
            }
        case .storedFile(let f):
            return store.blobURL(f.relativePath)
        case .data(let d):
            // An image/PDF data item can be previewed through its stored representation.
            if let rep = DataFlavors.previewRepresentation(d) { return store.blobURL(rep.blob) }
            return nil
        }
    }

    // MARK: Mutation

    func mutate(undoable: Bool = false, _ body: (inout ShelfLibrary) -> Void) {
        var l = library
        if undoable {
            undoStack.append(library)
            if undoStack.count > maxUndo { undoStack.removeFirst() }
        }
        body(&l)
        library = l
        // Drop selection / expansion that no longer exists.
        let live = Set(l.activeShelf.entries.map(\.id)).union(l.activeShelf.allItems.map(\.id))
        selection = selection.filter { live.contains($0) }
        if let e = expandedEntryID, !(l.activeShelf.entries.contains { $0.id == e && $0.isStack }) { expandedEntryID = nil }
        scheduleSave()
        onLibraryChanged?()
    }

    var canUndo: Bool { !undoStack.isEmpty }

    func undo() {
        guard let prev = undoStack.popLast() else { return }
        library = prev
        scheduleSave()
        onLibraryChanged?()
    }

    func add(_ items: [ShelfItem], stack: Bool, at index: Int? = nil, shelf: UUID? = nil) {
        guard !items.isEmpty else { return }
        mutate { $0.add(items, to: shelf, at: index, stack: stack) }
        refreshAvailability()
        refreshStorageUsage()
    }

    // MARK: Persistence

    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flush() }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    func flush() {
        saveWork?.cancel()
        saveWork = nil
        do { try store.save(library) } catch { NSLog("DragShelf: could not save state: \(error)") }
    }

    /// Deletes owned blobs that neither the library nor the undo history reference.
    /// Never touches the user's original files.
    func collectGarbage() {
        var keep = library.referencedBlobDirectories
        for snapshot in undoStack { keep.formUnion(snapshot.referencedBlobDirectories) }
        store.collectGarbage(keeping: keep)
        refreshStorageUsage()
    }

    func dropUndoHistory() {
        undoStack.removeAll()
    }

    // MARK: Availability & storage

    /// Re-checks every referenced original (cheap: one bookmark resolution + stat per file).
    func refreshAvailability() {
        var result: [UUID: FileResolver.Resolution] = [:]
        var updates: [ShelfItem] = []
        for item in library.allItems {
            guard case .file(let ref) = item.content else { continue }
            let r = FileResolver.resolve(ref)
            result[item.id] = r
            if case .moved(let url) = r {
                // Same file (identity verified), new location: remember where it went.
                var updated = item
                updated.content = .file(FileResolver.updatedReference(ref, movedTo: url))
                updates.append(updated)
            }
        }
        availability = result
        if !updates.isEmpty {
            var l = library
            for u in updates { l.updateItem(u) }
            library = l
            scheduleSave()
        }
    }

    var storageLimitBytes: Int64 = 2048 * 1024 * 1024

    func refreshStorageUsage() {
        let store = self.store
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let bytes = store.storageUsage()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.storageBytes = bytes
                self.storageOverLimit = bytes > self.storageLimitBytes
            }
        }
    }
}
