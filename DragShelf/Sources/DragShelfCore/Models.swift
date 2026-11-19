import Foundation

// MARK: - Item content

/// Stable identity of a file on disk, used to tell "the same file, moved" from
/// "a different file that now happens to live at the old path".
public struct FileIdentity: Codable, Equatable {
    public var inode: UInt64
    public var creationDate: Date?

    public init(inode: UInt64, creationDate: Date?) {
        self.inode = inode
        self.creationDate = creationDate
    }

    public func matches(_ other: FileIdentity) -> Bool {
        guard inode == other.inode else { return false }
        if let a = creationDate, let b = other.creationDate {
            return abs(a.timeIntervalSince(b)) < 1
        }
        return true
    }
}

/// A reference to a file the user dragged in. The original is never copied, moved or modified.
public struct FileReference: Codable, Equatable {
    /// macOS bookmark data (follows the file if it is moved on the same volume).
    public var bookmark: Data?
    /// Last known absolute path.
    public var path: String
    public var identity: FileIdentity?
    public var isDirectory: Bool

    public init(bookmark: Data?, path: String, identity: FileIdentity?, isDirectory: Bool) {
        self.bookmark = bookmark
        self.path = path
        self.identity = identity
        self.isDirectory = isDirectory
    }
}

/// A file owned by DragShelf (e.g. a received file promise, a screenshot thumbnail, an
/// image dragged out of a browser). Lives at `<storage>/blobs/<relativePath>`.
public struct StoredFile: Codable, Equatable {
    public var relativePath: String
    public var originalName: String

    public init(relativePath: String, originalName: String) {
        self.relativePath = relativePath
        self.originalName = originalName
    }
}

/// One pasteboard flavour of a non-file item (e.g. "public.utf8-plain-text", "public.png",
/// "public.rtf", or an application-specific type), stored verbatim as a blob.
public struct DataRepresentation: Codable, Equatable {
    public var type: String
    public var blob: String
    public var byteCount: Int64

    public init(type: String, blob: String, byteCount: Int64) {
        self.type = type
        self.blob = blob
        self.byteCount = byteCount
    }
}

/// Non-file drag/clipboard content. All original representations are kept, so dragging it
/// back out offers the receiving app the same types the source offered.
public struct DataItem: Codable, Equatable {
    public var representations: [DataRepresentation]
    /// Plain-text summary (full text for text items, for previews and quick actions).
    public var text: String?
    /// Link target for link items.
    public var url: String?
    public var title: String?

    public init(representations: [DataRepresentation], text: String? = nil, url: String? = nil, title: String? = nil) {
        self.representations = representations
        self.text = text
        self.url = url
        self.title = title
    }

    public func representation(ofType type: String) -> DataRepresentation? {
        representations.first { $0.type == type }
    }
}

public enum ItemContent: Codable, Equatable {
    case file(FileReference)
    case storedFile(StoredFile)
    case data(DataItem)

    /// Top-level blob directory names this content owns (for garbage collection).
    public var ownedBlobDirectories: [String] {
        switch self {
        case .file: return []
        case .storedFile(let f): return [Self.topComponent(f.relativePath)]
        case .data(let d): return d.representations.map { Self.topComponent($0.blob) }
        }
    }

    static func topComponent(_ relative: String) -> String {
        String(relative.split(separator: "/", omittingEmptySubsequences: true).first ?? "")
    }
}

public enum ItemKind: String, Codable, CaseIterable {
    case file, folder, image, pdf, audio, video, text, link, richData, application, archive

    public var title: String {
        switch self {
        case .file: return "File"
        case .folder: return "Folder"
        case .image: return "Image"
        case .pdf: return "PDF document"
        case .audio: return "Audio file"
        case .video: return "Video"
        case .text: return "Text"
        case .link: return "Link"
        case .richData: return "Data"
        case .application: return "Application"
        case .archive: return "Archive"
        }
    }
}

public struct ShelfItem: Codable, Identifiable, Equatable {
    public var id: UUID
    public var content: ItemContent
    public var kind: ItemKind
    public var displayName: String
    /// Uniform Type Identifier of the primary representation, when known.
    public var typeIdentifier: String?
    public var addedAt: Date
    /// Bytes owned by DragShelf for this item (0 for references to original files).
    public var storedBytes: Int64

    public init(id: UUID = UUID(), content: ItemContent, kind: ItemKind, displayName: String,
                typeIdentifier: String? = nil, addedAt: Date = Date(), storedBytes: Int64 = 0) {
        self.id = id
        self.content = content
        self.kind = kind
        self.displayName = displayName
        self.typeIdentifier = typeIdentifier
        self.addedAt = addedAt
        self.storedBytes = storedBytes
    }

    /// True when the item points at a user file rather than a copy owned by DragShelf.
    public var isReferenceToOriginal: Bool {
        if case .file = content { return true }
        return false
    }
}

// MARK: - Entries, shelves, library

/// A tile on the shelf: one item, or a stack of items that arrived in the same drag.
public struct ShelfEntry: Codable, Identifiable, Equatable {
    public var id: UUID
    public var items: [ShelfItem]

    public init(id: UUID = UUID(), items: [ShelfItem]) {
        self.id = id
        self.items = items
    }

    public var isStack: Bool { items.count > 1 }
}

public struct Shelf: Codable, Identifiable, Equatable {
    public var id: UUID
    public var name: String?
    public var entries: [ShelfEntry]
    public var createdAt: Date

    public init(id: UUID = UUID(), name: String? = nil, entries: [ShelfEntry] = [], createdAt: Date = Date()) {
        self.id = id
        self.name = name
        self.entries = entries
        self.createdAt = createdAt
    }

    public var itemCount: Int { entries.reduce(0) { $0 + $1.items.count } }
    public var isEmpty: Bool { entries.isEmpty }
    public var allItems: [ShelfItem] { entries.flatMap { $0.items } }
}

public struct ShelfLibrary: Codable, Equatable {
    public static let currentVersion = 1

    public var version: Int
    public var shelves: [Shelf]
    public var activeShelfID: UUID

    public init() {
        let s = Shelf()
        version = Self.currentVersion
        shelves = [s]
        activeShelfID = s.id
    }

    // MARK: Queries

    public var activeShelf: Shelf {
        get { shelves.first { $0.id == activeShelfID } ?? shelves[0] }
        set {
            if let i = shelves.firstIndex(where: { $0.id == newValue.id }) { shelves[i] = newValue }
        }
    }

    public var totalItemCount: Int { shelves.reduce(0) { $0 + $1.itemCount } }
    public var allItems: [ShelfItem] { shelves.flatMap { $0.allItems } }

    public func shelfIndex(_ id: UUID) -> Int? { shelves.firstIndex { $0.id == id } }

    public func displayName(of shelf: Shelf) -> String {
        if let n = shelf.name, !n.trimmingCharacters(in: .whitespaces).isEmpty { return n }
        let i = (shelfIndex(shelf.id) ?? 0) + 1
        return shelves.count == 1 ? "Shelf" : "Shelf \(i)"
    }

    public func item(_ id: UUID) -> ShelfItem? {
        for s in shelves { for e in s.entries { if let it = e.items.first(where: { $0.id == id }) { return it } } }
        return nil
    }

    public func entry(_ id: UUID) -> ShelfEntry? {
        for s in shelves { if let e = s.entries.first(where: { $0.id == id }) { return e } }
        return nil
    }

    /// Blob directories referenced by any item (anything else in storage is garbage).
    public var referencedBlobDirectories: Set<String> {
        Set(allItems.flatMap { $0.content.ownedBlobDirectories })
    }

    // MARK: Mutations

    /// Adds items to a shelf. Several items arriving together become one stack when `stack` is true.
    @discardableResult
    public mutating func add(_ items: [ShelfItem], to shelfID: UUID? = nil, at index: Int? = nil, stack: Bool) -> [UUID] {
        guard !items.isEmpty else { return [] }
        let sid = shelfID ?? activeShelfID
        guard let si = shelfIndex(sid) else { return [] }
        let newEntries: [ShelfEntry] = (stack && items.count > 1) ? [ShelfEntry(items: items)] : items.map { ShelfEntry(items: [$0]) }
        let at = min(max(index ?? shelves[si].entries.count, 0), shelves[si].entries.count)
        shelves[si].entries.insert(contentsOf: newEntries, at: at)
        return newEntries.map { $0.id }
    }

    /// Removes whole entries (tiles). Returns the removed items.
    @discardableResult
    public mutating func removeEntries(_ ids: Set<UUID>) -> [ShelfItem] {
        var removed: [ShelfItem] = []
        for si in shelves.indices {
            removed += shelves[si].entries.filter { ids.contains($0.id) }.flatMap { $0.items }
            shelves[si].entries.removeAll { ids.contains($0.id) }
        }
        return removed
    }

    /// Removes individual items (e.g. one file from inside a stack).
    @discardableResult
    public mutating func removeItems(_ ids: Set<UUID>) -> [ShelfItem] {
        var removed: [ShelfItem] = []
        for si in shelves.indices {
            for ei in shelves[si].entries.indices {
                removed += shelves[si].entries[ei].items.filter { ids.contains($0.id) }
                shelves[si].entries[ei].items.removeAll { ids.contains($0.id) }
            }
            shelves[si].entries.removeAll { $0.items.isEmpty }
        }
        return removed
    }

    public mutating func updateItem(_ item: ShelfItem) {
        for si in shelves.indices {
            for ei in shelves[si].entries.indices {
                if let ii = shelves[si].entries[ei].items.firstIndex(where: { $0.id == item.id }) {
                    shelves[si].entries[ei].items[ii] = item
                    return
                }
            }
        }
    }

    /// Reorders entries inside their shelf so that they appear, in their current relative
    /// order, before the entry currently at `destination` (or at the end).
    public mutating func moveEntries(_ ids: [UUID], toIndex destination: Int, in shelfID: UUID) {
        guard let si = shelfIndex(shelfID) else { return }
        var entries = shelves[si].entries
        let idSet = Set(ids)
        let moving = entries.filter { idSet.contains($0.id) }
        guard !moving.isEmpty else { return }
        // Count moved entries before the destination so the index stays meaningful after removal.
        let clamped = min(max(destination, 0), entries.count)
        let before = entries[..<clamped].filter { idSet.contains($0.id) }.count
        entries.removeAll { idSet.contains($0.id) }
        let insertAt = min(max(clamped - before, 0), entries.count)
        entries.insert(contentsOf: moving, at: insertAt)
        shelves[si].entries = entries
    }

    /// Moves entries (from any shelf) to the end of another shelf.
    public mutating func moveEntries(_ ids: [UUID], toShelf target: UUID) {
        guard let ti = shelfIndex(target) else { return }
        let idSet = Set(ids)
        var moving: [ShelfEntry] = []
        for si in shelves.indices where shelves[si].id != target {
            moving += shelves[si].entries.filter { idSet.contains($0.id) }
            shelves[si].entries.removeAll { idSet.contains($0.id) }
        }
        shelves[ti].entries += moving
    }

    /// Moves individual items (e.g. pulled out of a stack) to another shelf as single entries.
    public mutating func moveItems(_ ids: [UUID], toShelf target: UUID) {
        guard shelfIndex(target) != nil else { return }
        let removed = removeItems(Set(ids))
        let ordered = ids.compactMap { id in removed.first { $0.id == id } }
        add(ordered, to: target, stack: false)
    }

    /// Splits a stack into individual tiles in place.
    public mutating func unstack(_ entryID: UUID) {
        for si in shelves.indices {
            if let ei = shelves[si].entries.firstIndex(where: { $0.id == entryID }), shelves[si].entries[ei].isStack {
                let singles = shelves[si].entries[ei].items.map { ShelfEntry(items: [$0]) }
                shelves[si].entries.replaceSubrange(ei...ei, with: singles)
                return
            }
        }
    }

    /// Combines several entries into one stack (at the position of the first).
    public mutating func stack(_ entryIDs: [UUID]) {
        let idSet = Set(entryIDs)
        guard let si = shelves.firstIndex(where: { s in s.entries.contains { idSet.contains($0.id) } }) else { return }
        let entries = shelves[si].entries
        let selected = entries.filter { idSet.contains($0.id) }
        guard selected.count > 1, let first = entries.firstIndex(where: { idSet.contains($0.id) }) else { return }
        let merged = ShelfEntry(items: selected.flatMap { $0.items })
        var rest = entries
        rest.removeAll { idSet.contains($0.id) }
        let before = entries[..<first].filter { idSet.contains($0.id) }.count
        rest.insert(merged, at: min(first - before, rest.count))
        shelves[si].entries = rest
    }

    @discardableResult
    public mutating func clear(_ shelfID: UUID) -> [ShelfItem] {
        guard let si = shelfIndex(shelfID) else { return [] }
        let removed = shelves[si].allItems
        shelves[si].entries = []
        return removed
    }

    @discardableResult
    public mutating func clearAll() -> [ShelfItem] {
        let removed = allItems
        for si in shelves.indices { shelves[si].entries = [] }
        return removed
    }

    @discardableResult
    public mutating func newShelf(name: String? = nil, activate: Bool = true) -> UUID {
        let s = Shelf(name: name)
        shelves.append(s)
        if activate { activeShelfID = s.id }
        return s.id
    }

    /// Deletes a shelf; its items are removed too. The last shelf is cleared instead.
    @discardableResult
    public mutating func deleteShelf(_ id: UUID) -> [ShelfItem] {
        guard let si = shelfIndex(id) else { return [] }
        if shelves.count == 1 { return clear(id) }
        let removed = shelves[si].allItems
        shelves.remove(at: si)
        if activeShelfID == id { activeShelfID = shelves[max(0, si - 1)].id }
        return removed
    }

    /// Appends all entries of `source` to `target` and deletes `source`.
    public mutating func merge(_ source: UUID, into target: UUID) {
        guard source != target, let si = shelfIndex(source), let ti = shelfIndex(target) else { return }
        shelves[ti].entries += shelves[si].entries
        shelves.remove(at: si)
        if activeShelfID == source { activeShelfID = target }
    }

    public mutating func rename(_ id: UUID, to name: String?) {
        guard let si = shelfIndex(id) else { return }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        shelves[si].name = (trimmed?.isEmpty ?? true) ? nil : trimmed
    }

    public mutating func activate(_ id: UUID) {
        if shelfIndex(id) != nil { activeShelfID = id }
    }

    /// Drops empty, unnamed extra shelves (keeps at least one).
    public mutating func pruneEmptyUnnamedShelves() {
        guard shelves.count > 1 else { return }
        let keep = shelves.filter { !$0.isEmpty || $0.name != nil || $0.id == activeShelfID }
        shelves = keep.isEmpty ? [shelves[0]] : keep
        if shelfIndex(activeShelfID) == nil { activeShelfID = shelves[0].id }
    }

    /// Repairs invariants after decoding (e.g. a dangling active shelf id).
    public mutating func normalize() {
        if shelves.isEmpty { let s = Shelf(); shelves = [s]; activeShelfID = s.id }
        if shelfIndex(activeShelfID) == nil { activeShelfID = shelves[0].id }
        for si in shelves.indices { shelves[si].entries.removeAll { $0.items.isEmpty } }
    }
}
