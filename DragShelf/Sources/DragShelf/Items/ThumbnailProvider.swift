import AppKit
import Combine
import QuickLookThumbnailing
import UniformTypeIdentifiers
import DragShelfCore

/// Lazily generates and caches thumbnails. QuickLook renders from the file on disk, so large
/// images/videos are never loaded fully into memory; the cache holds only small bitmaps.
final class ThumbnailProvider {
    static let shared = ThumbnailProvider()

    private let cache = NSCache<NSString, NSImage>()
    private var inFlight: [String: [(NSImage?) -> Void]] = [:]

    init() {
        cache.countLimit = 400
        cache.totalCostLimit = 64 * 1024 * 1024
    }

    private func key(_ item: ShelfItem, side: CGFloat, url: URL?) -> String {
        "\(item.id.uuidString)|\(Int(side))|\(url?.path ?? "")"
    }

    func cachedThumbnail(for item: ShelfItem, side: CGFloat) -> NSImage? {
        cache.object(forKey: "\(item.id.uuidString)|\(Int(side))|last" as NSString)
    }

    /// Calls `completion` on the main queue with a thumbnail (or nil if QuickLook can't make one).
    func thumbnail(for item: ShelfItem, url: URL, side: CGFloat, scale: CGFloat, completion: @escaping (NSImage?) -> Void) {
        let k = key(item, side: side, url: url)
        if let img = cache.object(forKey: k as NSString) {
            completion(img)
            return
        }
        if inFlight[k] != nil {
            inFlight[k]?.append(completion)
            return
        }
        inFlight[k] = [completion]

        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: side, height: side),
                                                   scale: scale, representationTypes: .all)
        let lastKey = "\(item.id.uuidString)|\(Int(side))|last"
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { [weak self] rep, _ in
            let image = rep?.nsImage
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let image = image {
                    let cost = Int(side * side * scale * scale * 4)
                    self.cache.setObject(image, forKey: k as NSString, cost: cost)
                    self.cache.setObject(image, forKey: lastKey as NSString, cost: cost)
                }
                let callbacks = self.inFlight.removeValue(forKey: k) ?? []
                callbacks.forEach { $0(image) }
            }
        }
    }

    func invalidate(_ itemID: UUID) {
        // NSCache can't enumerate keys; entries for removed items simply age out.
        _ = itemID
    }

    /// The Finder icon for a file or type (fast, synchronous).
    static func icon(for item: ShelfItem, url: URL?) -> NSImage {
        if let url = url { return NSWorkspace.shared.icon(forFile: url.path) }
        if let t = item.typeIdentifier.flatMap({ UTType($0) }) { return NSWorkspace.shared.icon(for: t) }
        return NSWorkspace.shared.icon(for: .data)
    }
}

/// SwiftUI-facing loader for one tile's preview.
final class ThumbnailLoader: ObservableObject {
    @Published var image: NSImage?
    @Published var isThumbnail = false
    private var loadedKey: String?

    func load(item: ShelfItem, url: URL?, side: CGFloat, scale: CGFloat) {
        let key = "\(item.id)|\(url?.path ?? "-")|\(Int(side))"
        guard key != loadedKey else { return }
        loadedKey = key
        image = ThumbnailProvider.icon(for: item, url: url)
        isThumbnail = false
        guard let url = url else { return }
        ThumbnailProvider.shared.thumbnail(for: item, url: url, side: side, scale: scale) { [weak self] img in
            guard let self = self, self.loadedKey == key, let img = img else { return }
            self.image = img
            // Folders, apps and unknown types come back as icons; only treat real previews as thumbnails.
            self.isThumbnail = [.image, .pdf, .video].contains(item.kind)
        }
    }
}

/// Optional website icons. Off by default (Settings → General); when enabled, fetches
/// https://<host>/favicon.ico directly from the site the link points to — no third-party service.
final class FaviconLoader: ObservableObject {
    @Published var image: NSImage?
    private static let cache = NSCache<NSString, NSImage>()
    private var task: URLSessionDataTask?

    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 5
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        return URLSession(configuration: c)
    }()

    func load(_ urlString: String?, enabled: Bool) {
        guard enabled, let s = urlString, let u = URL(string: s), let host = u.host,
              let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let iconURL = URL(string: "https://\(host)/favicon.ico") else { return }
        if let cached = Self.cache.object(forKey: host as NSString) { image = cached; return }
        task?.cancel()
        task = Self.session.dataTask(with: iconURL) { [weak self] data, response, _ in
            guard let data = data, data.count < 512 * 1024,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let img = NSImage(data: data), img.isValid else { return }
            Self.cache.setObject(img, forKey: host as NSString)
            DispatchQueue.main.async { self?.image = img }
        }
        task?.resume()
    }

    deinit { task?.cancel() }
}
