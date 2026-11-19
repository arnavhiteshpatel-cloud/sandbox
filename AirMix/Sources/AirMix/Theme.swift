import AirMixAudio
import AirMixCore
import AppKit
import SwiftUI

/// Design tokens. Colors adapt to light and dark appearance.
enum Theme {
    static let accent = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.42, green: 0.72, blue: 1.00, alpha: 1)
            : NSColor(srgbRed: 0.10, green: 0.47, blue: 0.95, alpha: 1)
    })
    static let accent2 = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.62, green: 0.55, blue: 1.00, alpha: 1)
            : NSColor(srgbRed: 0.40, green: 0.33, blue: 0.95, alpha: 1)
    })
    static let boost = Color(red: 1.0, green: 0.62, blue: 0.25)
    static let danger = Color(red: 1.0, green: 0.36, blue: 0.36)
    static let meterLow = Color(red: 0.36, green: 0.86, blue: 0.62)
    static let meterMid = Color(red: 0.98, green: 0.80, blue: 0.30)

    static let fillGradient = LinearGradient(colors: [accent, accent2], startPoint: .leading, endPoint: .trailing)
    static let verticalFill = LinearGradient(colors: [accent2, accent], startPoint: .top, endPoint: .bottom)

    static let hairline = Color.primary.opacity(0.08)
    static let track = Color.primary.opacity(0.09)
    static let cardFill = Color.primary.opacity(0.035)
    static let cardStroke = Color.primary.opacity(0.07)
    static let secondaryText = Color.secondary

    static let corner: CGFloat = 12
    static let smallCorner: CGFloat = 8

    static func rowTitle() -> Font { .system(size: 13, weight: .medium) }
    static func caption() -> Font { .system(size: 11, weight: .regular) }
    static func mono(_ size: CGFloat = 11) -> Font { .system(size: size, weight: .medium, design: .rounded).monospacedDigit() }
    static func sectionTitle() -> Font { .system(size: 11, weight: .semibold) }
}

struct Card<Content: View>: View {
    var padding: CGFloat = 12
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .background(
                RoundedRectangle(cornerRadius: Theme.corner, style: .continuous)
                    .fill(Theme.cardFill)
                    .overlay(RoundedRectangle(cornerRadius: Theme.corner, style: .continuous)
                        .strokeBorder(Theme.cardStroke, lineWidth: 0.5))
            )
    }
}

struct SectionHeader: View {
    let title: String
    var trailing: AnyView? = nil

    var body: some View {
        HStack {
            Text(title.uppercased())
                .font(Theme.sectionTitle())
                .kerning(0.6)
                .foregroundStyle(.secondary)
            Spacer()
            if let trailing { trailing }
        }
    }
}

/// Native window/popover vibrancy.
struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .popover
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blending
        v.state = .active
        return v
    }

    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.blendingMode = blending
    }
}

/// Small circular icon button used throughout.
struct IconButton: View {
    let symbol: String
    var help: String = ""
    var active: Bool = false
    var tint: Color = Theme.accent
    var size: CGFloat = 24
    let action: () -> Void
    @State var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.5, weight: .semibold))
                .foregroundStyle(active ? tint : (hovering ? Color.primary : Color.secondary))
                .frame(width: size, height: size)
                .background(Circle().fill(Color.primary.opacity(hovering ? 0.08 : 0)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(help)
        .onHover { hovering = $0 }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }
}

/// App icon from its bundle, or a category glyph.
@MainActor
enum IconCache {
    private static var cache: [String: NSImage] = [:]

    static func icon(for id: String, bundlePath: String?) -> NSImage? {
        if let hit = cache[id] { return hit }
        var image: NSImage?
        if let path = bundlePath, FileManager.default.fileExists(atPath: path) {
            image = NSWorkspace.shared.icon(forFile: path)
        } else if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
            image = NSWorkspace.shared.icon(forFile: url.path)
        }
        if let image { cache[id] = image }
        return image
    }
}

struct AppIconView: View {
    let id: String
    let bundlePath: String?
    let category: AppCategory
    var size: CGFloat = 26
    var dimmed = false

    var body: some View {
        Group {
            if let img = IconCache.icon(for: id, bundlePath: bundlePath) {
                Image(nsImage: img).resizable().interpolation(.high)
            } else {
                RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
                    .fill(LinearGradient(colors: [Color.primary.opacity(0.18), Color.primary.opacity(0.08)],
                                         startPoint: .top, endPoint: .bottom))
                    .overlay(Image(systemName: category.symbolName)
                        .font(.system(size: size * 0.45, weight: .semibold))
                        .foregroundStyle(.secondary))
            }
        }
        .frame(width: size, height: size)
        .saturation(dimmed ? 0 : 1)
        .opacity(dimmed ? 0.55 : 1)
    }
}
