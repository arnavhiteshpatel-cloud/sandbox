import Foundation
import UniformTypeIdentifiers
import DragShelfCore

/// Creates and resolves references to the user's original files.
///
/// DragShelf is not sandboxed, so plain (non-security-scoped) bookmarks are used.
/// A bookmark follows a file that is moved or renamed on the same volume. To make sure we never
/// silently substitute a *different* file, every resolution is checked against the inode and
/// creation date recorded when the file was dropped.
enum FileResolver {
    enum Resolution: Equatable {
        /// The original, at its recorded location.
        case available(URL)
        /// The same original (identity verified), now at a different location.
        case moved(URL)
        /// The original no longer exists (deleted, in the Trash, or on an unmounted volume).
        case missing
        /// Something else now lives at the original path — refuse to use it.
        case replaced
    }

    static func makeReference(for url: URL) -> FileReference {
        let std = url.standardizedFileURL
        let bookmark = try? std.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
        let isDir = (try? std.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        return FileReference(bookmark: bookmark, path: std.path, identity: identity(of: std), isDirectory: isDir)
    }

    static func identity(of url: URL) -> FileIdentity? {
        var st = stat()
        guard lstat(url.path, &st) == 0 else { return nil }
        let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate
        return FileIdentity(inode: UInt64(st.st_ino), creationDate: created)
    }

    static func resolve(_ ref: FileReference) -> Resolution {
        let fm = FileManager.default

        if let data = ref.bookmark {
            var stale = false
            if let url = try? URL(resolvingBookmarkData: data, options: [.withoutUI, .withoutMounting],
                                  relativeTo: nil, bookmarkDataIsStale: &stale) {
                let std = url.standardizedFileURL
                if fm.fileExists(atPath: std.path) {
                    if isInTrash(std) { return .missing }
                    if let expected = ref.identity, let current = identity(of: std), !expected.matches(current) {
                        return .replaced
                    }
                    // Compare real paths: bookmarks may resolve /var/… as /private/var/… etc.
                    return samePath(std, URL(fileURLWithPath: ref.path)) ? .available(URL(fileURLWithPath: ref.path)) : .moved(std)
                }
            }
        }

        // Fall back to the recorded path, but only if it is provably the same file.
        let url = URL(fileURLWithPath: ref.path)
        guard fm.fileExists(atPath: url.path) else { return .missing }
        if let expected = ref.identity {
            guard let current = identity(of: url), expected.matches(current) else { return .replaced }
        }
        return .available(url)
    }

    static func samePath(_ a: URL, _ b: URL) -> Bool {
        a.standardizedFileURL.resolvingSymlinksInPath().path == b.standardizedFileURL.resolvingSymlinksInPath().path
    }

    static func updatedReference(_ ref: FileReference, movedTo url: URL) -> FileReference {
        var r = ref
        r.path = url.standardizedFileURL.path
        if let b = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) { r.bookmark = b }
        return r
    }

    static func isInTrash(_ url: URL) -> Bool {
        url.pathComponents.contains(".Trash") || url.pathComponents.contains(".Trashes")
    }

    // MARK: Classification

    static func kind(for url: URL) -> (ItemKind, String?) {
        let rv = try? url.resourceValues(forKeys: [.contentTypeKey, .isDirectoryKey, .isPackageKey])
        let type = rv?.contentType
        let isDir = rv?.isDirectory ?? false
        let isPackage = rv?.isPackage ?? false
        return (kind(for: type, isDirectory: isDir, isPackage: isPackage, ext: url.pathExtension), type?.identifier)
    }

    static func kind(for type: UTType?, isDirectory: Bool, isPackage: Bool, ext: String) -> ItemKind {
        if let t = type {
            if t.conforms(to: .applicationBundle) || t.conforms(to: .application) { return .application }
            if isDirectory && !isPackage { return .folder }
            if t.conforms(to: .pdf) { return .pdf }
            if t.conforms(to: .image) { return .image }
            if t.conforms(to: .audio) { return .audio }
            if t.conforms(to: .movie) || t.conforms(to: .video) { return .video }
            if t.conforms(to: .archive) || t.conforms(to: .diskImage) { return .archive }
            if t.conforms(to: .internetLocation) { return .link }
            if isDirectory { return .folder }
            return .file
        }
        let k = FileNames.kind(forExtension: ext, isDirectory: isDirectory)
        return k == .text ? .file : k
    }

    /// Items that could run code when opened. Opening them asks for confirmation first.
    static func isPotentiallyExecutable(_ url: URL) -> Bool {
        let rv = try? url.resourceValues(forKeys: [.contentTypeKey, .isExecutableKey, .isDirectoryKey, .isPackageKey])
        if let t = rv?.contentType {
            let risky: [UTType] = [.application, .applicationBundle, .executable, .script, .shellScript,
                                   .unixExecutable, .appleScript, .osaScript, .pythonScript, .rubyScript,
                                   .perlScript, .phpScript, .javaScript, .systemPreferencesPane, .bundle,
                                   .pluginBundle, .framework]
            if risky.contains(where: { t.conforms(to: $0) }) { return true }
        }
        let riskyExtensions: Set<String> = ["command", "tool", "terminal", "sh", "zsh", "bash", "csh", "fish",
                                           "workflow", "action", "pkg", "mpkg", "jar", "scpt", "scptd",
                                           "applescript", "app", "prefpane", "osax", "kext", "dylib", "inetloc",
                                           "fileloc", "webloc", "url", "terminal", "itermcolors"]
        if riskyExtensions.contains(url.pathExtension.lowercased()) { return true }
        if rv?.isDirectory != true, rv?.isExecutable == true { return true }
        return false
    }
}
