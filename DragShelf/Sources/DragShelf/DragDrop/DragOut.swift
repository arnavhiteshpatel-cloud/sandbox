import AppKit
import UniformTypeIdentifiers
import DragShelfCore

/// A file promise for image data (so Finder gets a real file) that also carries every stored
/// flavour (so apps that accept image data get it directly).
final class DataItemPromiseProvider: NSFilePromiseProvider {
    var flavours: [(NSPasteboard.PasteboardType, URL)] = []

    override func writableTypes(for pasteboard: NSPasteboard) -> [NSPasteboard.PasteboardType] {
        var types = super.writableTypes(for: pasteboard)
        for (t, _) in flavours where !types.contains(t) { types.append(t) }
        return types
    }

    override func writingOptions(forType type: NSPasteboard.PasteboardType, pasteboard: NSPasteboard) -> NSPasteboard.WritingOptions {
        if flavours.contains(where: { $0.0 == type }) { return [] }
        return super.writingOptions(forType: type, pasteboard: pasteboard)
    }

    override func pasteboardPropertyList(forType type: NSPasteboard.PasteboardType) -> Any? {
        if let (_, url) = flavours.first(where: { $0.0 == type }) {
            return try? Data(contentsOf: url)
        }
        return super.pasteboardPropertyList(forType: type)
    }
}

/// Writes promised files for data items (image data dragged to Finder, etc.).
final class PromiseWriter: NSObject, NSFilePromiseProviderDelegate {
    static let shared = PromiseWriter()

    struct Payload {
        var source: URL
        var fileName: String
    }

    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.qualityOfService = .userInitiated
        return q
    }()

    func filePromiseProvider(_ filePromiseProvider: NSFilePromiseProvider, fileNameForType fileType: String) -> String {
        (filePromiseProvider.userInfo as? Payload)?.fileName ?? "Item"
    }

    func filePromiseProvider(_ filePromiseProvider: NSFilePromiseProvider, writePromiseTo url: URL, completionHandler: @escaping (Error?) -> Void) {
        guard let payload = filePromiseProvider.userInfo as? Payload else {
            completionHandler(CocoaError(.fileNoSuchFile))
            return
        }
        do {
            // The destination is a new file chosen by the receiver; never overwrite silently.
            if FileManager.default.fileExists(atPath: url.path) { throw CocoaError(.fileWriteFileExists) }
            try FileManager.default.copyItem(at: payload.source, to: url)
            completionHandler(nil)
        } catch {
            completionHandler(error)
        }
    }

    func operationQueue(for filePromiseProvider: NSFilePromiseProvider) -> OperationQueue {
        queue
    }
}

enum DragOut {
    /// Pasteboard writers for items, used for dragging out and for copying.
    /// - Parameter forDrag: when false (copying to the clipboard) file promises are not used.
    static func writers(for items: [ShelfItem], model: ShelfModel, forDrag: Bool) -> [NSPasteboardWriting] {
        items.compactMap { writer(for: $0, model: model, forDrag: forDrag) }
    }

    static func writer(for item: ShelfItem, model: ShelfModel, forDrag: Bool) -> NSPasteboardWriting? {
        switch item.content {
        case .file, .storedFile:
            guard model.isAvailable(item), let url = model.fileURL(for: item) else { return nil }
            return url as NSURL

        case .data(let d):
            let flavours: [(NSPasteboard.PasteboardType, URL)] = d.representations.compactMap { rep in
                guard let url = model.store.blobURL(rep.blob) else { return nil }
                return (NSPasteboard.PasteboardType(rep.type), url)
            }
            guard !flavours.isEmpty else { return nil }

            if forDrag, item.kind == .image || item.kind == .pdf, let rep = DataFlavors.previewRepresentation(d),
               let source = model.store.blobURL(rep.blob) {
                let ext = DataFlavors.fileExtension(for: rep.type) ?? source.pathExtension
                var base = FileNames.sanitize(item.displayName, fallback: "Image")
                if !ext.isEmpty && !base.lowercased().hasSuffix("." + ext.lowercased()) { base += "." + ext }
                let provider = DataItemPromiseProvider(fileType: rep.type, delegate: PromiseWriter.shared)
                provider.userInfo = PromiseWriter.Payload(source: source, fileName: base)
                provider.flavours = flavours
                return provider
            }

            let pbItem = NSPasteboardItem()
            for (type, url) in flavours {
                if let data = try? Data(contentsOf: url) { pbItem.setData(data, forType: type) }
            }
            // Lets the shelf recognise its own drag even when the item has only custom flavours.
            if forDrag { pbItem.setString(item.id.uuidString, forType: DragShelfPasteboard.internalType) }
            return pbItem
        }
    }

    /// The icon/thumbnail used for an item in drag images and menus.
    static func image(for item: ShelfItem, model: ShelfModel, side: CGFloat) -> NSImage {
        if let cached = ThumbnailProvider.shared.cachedThumbnail(for: item, side: side) { return cached }
        let img: NSImage
        switch item.kind {
        case .text: img = NSImage(systemSymbolName: "text.alignleft", accessibilityDescription: "Text") ?? NSImage()
        case .link: img = NSImage(systemSymbolName: "link", accessibilityDescription: "Link") ?? NSImage()
        default:
            if let url = model.fileURL(for: item) {
                img = NSWorkspace.shared.icon(forFile: url.path)
            } else if let t = item.typeIdentifier.flatMap({ UTType($0) }) {
                img = NSWorkspace.shared.icon(for: t)
            } else {
                img = NSWorkspace.shared.icon(for: .data)
            }
        }
        // Workspace icons can be shared instances; resize a copy.
        let sized = (img.copy() as? NSImage) ?? img
        sized.size = NSSize(width: side, height: side)
        return sized
    }
}
