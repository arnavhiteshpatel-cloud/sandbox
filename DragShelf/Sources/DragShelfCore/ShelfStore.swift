import Foundation

/// On-disk storage for shelf state and for content DragShelf owns.
///
/// Layout:
///   <root>/state.json        – the ShelfLibrary (written atomically)
///   <root>/blobs/<UUID>/…    – owned content: received file promises, copied data flavours
///
/// Safety guarantees (unit-tested):
///   • Only direct children of `blobs/` whose names are UUIDs are ever deleted.
///   • Paths are resolved and validated to stay inside `blobs/` (no `..`, no absolute paths).
///   • Symlinks are removed as links; their targets are never touched.
///   • References to the user's original files are never deleted, moved or written.
public final class ShelfStore {
    public let rootURL: URL
    public let blobsURL: URL
    public let stateURL: URL
    private let fm = FileManager.default

    public init(rootURL: URL) throws {
        self.rootURL = rootURL.standardizedFileURL
        self.blobsURL = self.rootURL.appendingPathComponent("blobs", isDirectory: true)
        self.stateURL = self.rootURL.appendingPathComponent("state.json")
        try fm.createDirectory(at: blobsURL, withIntermediateDirectories: true)
    }

    // MARK: State

    public enum LoadResult: Equatable {
        case none
        case loaded(ShelfLibrary)
        /// The file could not be decoded; it was moved aside to the given URL.
        case corrupt(movedTo: URL?)
    }

    public func load() -> LoadResult {
        guard fm.fileExists(atPath: stateURL.path) else { return .none }
        do {
            let data = try Data(contentsOf: stateURL)
            var lib = try Self.decoder.decode(ShelfLibrary.self, from: data)
            lib.normalize()
            return .loaded(lib)
        } catch {
            let stamp = Int(Date().timeIntervalSince1970)
            let aside = rootURL.appendingPathComponent("state.corrupt-\(stamp).json")
            do { try fm.moveItem(at: stateURL, to: aside); return .corrupt(movedTo: aside) }
            catch { return .corrupt(movedTo: nil) }
        }
    }

    public func save(_ library: ShelfLibrary) throws {
        let data = try Self.encoder.encode(library)
        try data.write(to: stateURL, options: .atomic)
    }

    public func deleteState() {
        try? fm.removeItem(at: stateURL)
    }

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        // Default date strategy (Double since reference date) round-trips exactly.
        return e
    }()

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    // MARK: Blobs

    /// Creates a fresh, empty blob directory and returns its name and URL.
    public func makeBlobDirectory() throws -> (name: String, url: URL) {
        let name = UUID().uuidString
        let url = blobsURL.appendingPathComponent(name, isDirectory: true)
        try fm.createDirectory(at: url, withIntermediateDirectories: false)
        return (name, url)
    }

    /// Writes `data` into a new blob directory under a sanitized file name.
    /// Returns the path relative to `blobs/`.
    public func writeBlob(_ data: Data, fileName: String) throws -> String {
        let dir = try makeBlobDirectory()
        let safe = FileNames.sanitize(fileName)
        try data.write(to: dir.url.appendingPathComponent(safe), options: .atomic)
        return dir.name + "/" + safe
    }

    /// Resolves a blob-relative path, refusing anything that would escape `blobs/`.
    public func blobURL(_ relative: String) -> URL? {
        guard !relative.isEmpty, !relative.hasPrefix("/") else { return nil }
        let parts = relative.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.isEmpty, !parts.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        guard UUID(uuidString: String(parts[0])) != nil else { return nil }
        let url = parts.reduce(blobsURL) { $0.appendingPathComponent(String($1)) }.standardizedFileURL
        guard url.path.hasPrefix(blobsURL.path + "/") else { return nil }
        return url
    }

    /// Deletes one blob directory (by name). Refuses anything that is not a UUID directly under blobs/.
    @discardableResult
    public func deleteBlobDirectory(_ name: String) -> Bool {
        guard UUID(uuidString: name) != nil, !name.contains("/") else { return false }
        let url = blobsURL.appendingPathComponent(name)
        guard url.standardizedFileURL.deletingLastPathComponent().path == blobsURL.path else { return false }
        do { try fm.removeItem(at: url); return true } catch { return false }
    }

    /// Removes blob directories no longer referenced by any item. Returns the names removed.
    @discardableResult
    public func collectGarbage(keeping referenced: Set<String>) -> [String] {
        guard let children = try? fm.contentsOfDirectory(atPath: blobsURL.path) else { return [] }
        var removed: [String] = []
        for name in children where !referenced.contains(name) && UUID(uuidString: name) != nil {
            if deleteBlobDirectory(name) { removed.append(name) }
        }
        return removed
    }

    /// Total bytes used by owned content (symlinks are not followed).
    public func storageUsage() -> Int64 {
        Self.directorySize(blobsURL)
    }

    public static func directorySize(_ url: URL) -> Int64 {
        let fm = FileManager.default
        guard let e = fm.enumerator(atPath: url.path) else { return 0 }
        var total: Int64 = 0
        while let rel = e.nextObject() as? String {
            let p = url.appendingPathComponent(rel).path
            guard let attrs = try? fm.attributesOfItem(atPath: p) else { continue }
            if (attrs[.type] as? FileAttributeType) == .typeRegular {
                total += (attrs[.size] as? NSNumber)?.int64Value ?? 0
            }
        }
        return total
    }
}

// MARK: - File names

public enum FileNames {
    /// Makes an untrusted name safe to use as a single path component.
    public static func sanitize(_ raw: String, fallback: String = "Item") -> String {
        var s = raw.replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .replacingOccurrences(of: "\0", with: "")
        s = String(s.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasPrefix(".") { s.removeFirst() }
        if s.isEmpty { s = fallback }
        if s.utf8.count > 200 {
            let ext = (s as NSString).pathExtension
            var base = (s as NSString).deletingPathExtension
            while (base.utf8.count + ext.utf8.count + 1) > 200 && !base.isEmpty { base.removeLast() }
            s = ext.isEmpty ? base : base + "." + ext
        }
        return s
    }

    /// Lower-cased extension → kind, used when no richer type information is available.
    public static func kind(forExtension ext: String, isDirectory: Bool = false) -> ItemKind {
        if isDirectory { return ext.lowercased() == "app" ? .application : .folder }
        switch ext.lowercased() {
        case "png", "jpg", "jpeg", "gif", "heic", "heif", "tif", "tiff", "bmp", "webp", "svg", "ico", "raw", "dng", "avif":
            return .image
        case "pdf": return .pdf
        case "mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "caf", "opus": return .audio
        case "mov", "mp4", "m4v", "avi", "mkv", "webm", "mpg", "mpeg": return .video
        case "txt", "md", "markdown", "rtf", "csv", "json", "log": return .text
        case "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar", "dmg": return .archive
        case "app": return .application
        case "webloc", "url": return .link
        default: return .file
        }
    }
}

// The store only performs file-system operations through FileManager and immutable URLs,
// so it is safe to use from the background queues that receive file promises.
extension ShelfStore: @unchecked Sendable {}
