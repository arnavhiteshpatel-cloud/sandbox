import Foundation

public enum ShelfOrientation: Equatable {
    /// A column hugging the left or right edge.
    case vertical
    /// A strip hugging the top or bottom edge.
    case horizontal
}

/// Computes the shelf panel's size from what it holds, so the shelf is only as large as needed.
public struct ShelfLayout: Equatable {
    public var columns: Int
    public var rows: Int
    public var contentSize: CGSize
    /// True when the grid is taller/wider than allowed and must scroll.
    public var scrolls: Bool

    public static let padding: CGFloat = 12
    public static let spacing: CGFloat = 10
    public static let headerHeight: CGFloat = 34
    public static let labelHeight: CGFloat = 18
    public static let minWidth: CGFloat = 176
    public static let emptyDropHeight: CGFloat = 112

    public static func cellSize(tile: CGFloat) -> CGSize {
        CGSize(width: tile, height: tile + labelHeight)
    }

    /// - Parameters:
    ///   - count: number of tiles
    ///   - maxLength: the largest extent allowed along the shelf's main axis (screen-dependent)
    public static func compute(count: Int, orientation: ShelfOrientation, tile: CGFloat, maxLength: CGFloat) -> ShelfLayout {
        let cell = cellSize(tile: tile)
        let p = padding, sp = spacing, h = headerHeight

        guard count > 0 else {
            let w = max(minWidth, tile * 2 + sp + p * 2)
            return ShelfLayout(columns: 0, rows: 0, contentSize: CGSize(width: w, height: h + emptyDropHeight + p), scrolls: false)
        }

        switch orientation {
        case .vertical:
            let columns = count <= 3 ? 1 : 2
            let rows = Int((Double(count) / Double(columns)).rounded(.up))
            let gridW = CGFloat(columns) * cell.width + CGFloat(columns - 1) * sp
            let width = max(minWidth, gridW + p * 2)
            let fullH = h + CGFloat(rows) * cell.height + CGFloat(rows - 1) * sp + p
            let maxH = max(maxLength, h + cell.height + p)
            return ShelfLayout(columns: columns, rows: rows, contentSize: CGSize(width: width, height: min(fullH, maxH)), scrolls: fullH > maxH)

        case .horizontal:
            let rows = count <= 6 ? 1 : 2
            let columns = Int((Double(count) / Double(rows)).rounded(.up))
            let gridW = CGFloat(columns) * cell.width + CGFloat(columns - 1) * sp + p * 2
            let fullW = max(minWidth, gridW)
            let height = h + CGFloat(rows) * cell.height + CGFloat(rows - 1) * sp + p
            let maxW = max(maxLength, minWidth)
            return ShelfLayout(columns: columns, rows: rows, contentSize: CGSize(width: min(fullW, maxW), height: height), scrolls: fullW > maxW)
        }
    }

    /// Where to place the panel: flush (with an inset) against `edge` of `visibleFrame`,
    /// centred on the cursor along the edge and clamped to stay fully on screen
    /// (never under the menu bar or Dock, which `visibleFrame` excludes).
    public static func panelFrame(size: CGSize, edge: ScreenEdge, anchor: CGPoint, visibleFrame vf: CGRect, inset: CGFloat = 10) -> CGRect {
        var x: CGFloat, y: CGFloat
        switch edge {
        case .left:
            x = vf.minX + inset
            y = anchor.y - size.height / 2
        case .right:
            x = vf.maxX - inset - size.width
            y = anchor.y - size.height / 2
        case .top:
            x = anchor.x - size.width / 2
            y = vf.maxY - inset - size.height
        case .bottom:
            x = anchor.x - size.width / 2
            y = vf.minY + inset
        }
        x = min(max(x, vf.minX + inset), vf.maxX - inset - size.width)
        y = min(max(y, vf.minY + inset), vf.maxY - inset - size.height)
        return CGRect(x: x.rounded(), y: y.rounded(), width: size.width, height: size.height)
    }

    /// The off-screen-ward start frame for the slide-in animation.
    public static func hiddenFrame(for frame: CGRect, edge: ScreenEdge, distance: CGFloat = 24) -> CGRect {
        switch edge {
        case .left: return frame.offsetBy(dx: -distance, dy: 0)
        case .right: return frame.offsetBy(dx: distance, dy: 0)
        case .top: return frame.offsetBy(dx: 0, dy: distance)
        case .bottom: return frame.offsetBy(dx: 0, dy: -distance)
        }
    }
}

// MARK: - Text helpers

public enum TextAnalysis {
    /// If `text` is a single web/mail link, returns it (bare domains get https://).
    /// Never returns file:// or other local/executable schemes.
    public static func link(in text: String) -> URL? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count < 4096, !t.contains(where: { $0.isWhitespace }) else { return nil }
        let allowed = ["http", "https", "mailto", "ftp"]
        if let u = URL(string: t), let scheme = u.scheme?.lowercased() {
            if allowed.contains(scheme) {
                if scheme == "mailto" { return u }
                return (u.host?.isEmpty == false) ? u : nil
            }
            // "example.com:8080/x" parses with scheme "example.com"; fall through to bare-domain check.
            if !scheme.contains(".") { return nil }
        }
        // Bare domain like "example.com/path"
        let hostPart = t.split(separator: "/", maxSplits: 1).first.map(String.init) ?? t
        let labels = hostPart.split(separator: ".")
        guard labels.count >= 2, let tld = labels.last, tld.count >= 2, tld.allSatisfy({ $0.isLetter }),
              hostPart.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == ":" }) else { return nil }
        return URL(string: "https://" + t)
    }

    /// A short single-paragraph preview of `text`.
    public static func snippet(_ text: String, maxCharacters: Int = 160) -> String {
        let collapsed = text.split(whereSeparator: { $0.isNewline }).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: " ")
        if collapsed.count <= maxCharacters { return collapsed }
        return String(collapsed.prefix(maxCharacters - 1)) + "…"
    }

    /// A name for a text item ("Hello world…").
    public static func title(forText text: String, maxCharacters: Int = 40) -> String {
        let s = snippet(text, maxCharacters: maxCharacters)
        return s.isEmpty ? "Text" : s
    }

    /// A short display name for a link: the host without "www.".
    public static func displayHost(_ url: URL) -> String {
        if url.scheme?.lowercased() == "mailto" {
            return url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
        }
        var h = url.host ?? url.absoluteString
        if h.hasPrefix("www.") { h.removeFirst(4) }
        return h
    }
}
