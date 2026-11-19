import SwiftUI
import AppKit
import DragShelfCore

struct ShelfGrid: View {
    let targets: [TileTarget]
    @ObservedObject var model: ShelfModel
    let controller: ShelfController
    let tile: CGFloat
    let loadWebsiteIcons: Bool

    var body: some View {
        let layout = controller.currentLayout()
        let cell = ShelfLayout.cellSize(tile: tile)
        let vertical = controller.edge.orientation == .vertical
        ScrollView(vertical ? .vertical : .horizontal, showsIndicators: layout.scrolls) {
            if vertical {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(cell.width), spacing: ShelfLayout.spacing),
                                         count: max(1, layout.columns)),
                          spacing: ShelfLayout.spacing) {
                    tiles
                }
                .padding(.horizontal, ShelfLayout.padding)
                .padding(.top, 2)
                .padding(.bottom, ShelfLayout.padding)
            } else {
                LazyHGrid(rows: Array(repeating: GridItem(.fixed(cell.height), spacing: ShelfLayout.spacing),
                                      count: max(1, layout.rows)),
                          spacing: ShelfLayout.spacing) {
                    tiles
                }
                .padding(.horizontal, ShelfLayout.padding)
                .padding(.top, 2)
                .padding(.bottom, ShelfLayout.padding)
            }
        }
    }

    @ViewBuilder private var tiles: some View {
        let insertion = model.dropInsertionIndex
        ForEach(Array(targets.enumerated()), id: \.element) { index, target in
            TileView(target: target, model: model, controller: controller, tile: tile,
                     loadWebsiteIcons: loadWebsiteIcons,
                     insertBefore: insertion == index,
                     insertAfter: insertion == targets.count && index == targets.count - 1)
                .transition(.scale(scale: 0.85).combined(with: .opacity))
        }
    }
}

struct TileView: View {
    let target: TileTarget
    @ObservedObject var model: ShelfModel
    let controller: ShelfController
    let tile: CGFloat
    let loadWebsiteIcons: Bool
    let insertBefore: Bool
    let insertAfter: Bool

    private var items: [ShelfItem] { model.items(for: target) }
    private var isSelected: Bool { model.selection.contains(target.id) }
    private var isHovered: Bool { model.hovered == target }

    var body: some View {
        let items = self.items
        let available = items.allSatisfy { model.isAvailable($0) }
        VStack(spacing: 3) {
            ZStack {
                if items.count > 1 {
                    StackPreview(items: items, model: model, side: tile, fanned: isHovered, loadWebsiteIcons: loadWebsiteIcons)
                } else if let item = items.first {
                    ItemPreview(item: item, model: model, side: tile, loadWebsiteIcons: loadWebsiteIcons)
                }
                if !available {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 13))
                        .symbolRenderingMode(.multicolor)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(2)
                }
            }
            .frame(width: tile, height: tile)
            .opacity(available ? 1 : 0.5)

            Text(title(items))
                .font(.system(size: 10.5, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .padding(.horizontal, 5)
                .frame(height: ShelfLayout.labelHeight - 3)
                .background(Capsule().fill(isSelected ? Color.accentColor : Color.clear))
                .frame(maxWidth: tile + 6)
        }
        .frame(width: tile, height: tile + ShelfLayout.labelHeight)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.16) : Color.primary.opacity(isHovered ? 0.06 : 0))
                .padding(-4)
        )
        .overlay(TileHitArea(target: target, delegate: controller, toolTip: tooltip(items, available: available)))
        .overlay(alignment: .topTrailing) {
            if isHovered {
                RemoveButton { controller.remove([target]) }
                    .offset(x: 7, y: -7)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .leading) {
            if insertBefore { InsertionBar(height: tile).offset(x: -7) }
        }
        .overlay(alignment: .trailing) {
            if insertAfter { InsertionBar(height: tile).offset(x: 7) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel(items, available: available))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : [.isButton])
        .accessibilityAction(named: Text(items.count > 1 ? "Show stack contents" : "Open")) {
            if items.count > 1 { controller.expand(target.id) } else { controller.open(items) }
        }
        .accessibilityAction(named: Text("Quick Look")) { controller.quickLook(items) }
        .accessibilityAction(named: Text("Copy")) { controller.copy(items) }
        .accessibilityAction(named: Text("Remove from shelf")) { controller.remove([target]) }
    }

    private func title(_ items: [ShelfItem]) -> String {
        if items.count > 1 { return "\(items.count) items" }
        return items.first?.displayName ?? ""
    }

    private func accessibilityLabel(_ items: [ShelfItem], available: Bool) -> String {
        if items.count > 1 {
            return "Stack of \(items.count) items: " + items.prefix(4).map(\.displayName).joined(separator: ", ")
        }
        guard let i = items.first else { return "" }
        return "\(i.kind.title), \(i.displayName)" + (available ? "" : ", unavailable")
    }

    private func tooltip(_ items: [ShelfItem], available: Bool) -> String {
        guard items.count == 1, let item = items[first: 0] else {
            return items.prefix(8).map(\.displayName).joined(separator: "\n")
        }
        switch item.content {
        case .file(let ref):
            switch model.resolution(for: item) {
            case .missing?: return "The original file was deleted or moved to the Trash.\n\(ref.path)"
            case .replaced?: return "A different file now exists at the original location.\n\(ref.path)"
            case .moved(let url)?: return "Moved to \(url.path)"
            default: return ref.path
            }
        case .storedFile:
            return "\(item.displayName)\nA copy kept by DragShelf"
        case .data(let d):
            if item.kind == .link { return [d.title, d.url].compactMap { $0 }.joined(separator: "\n") }
            if let t = d.text { return TextAnalysis.snippet(t, maxCharacters: 300) }
            return item.displayName
        }
    }
}

private extension Array {
    subscript(first index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

struct RemoveButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(Color.primary.opacity(0.8))
                .frame(width: 17, height: 17)
                .background(Circle().fill(.regularMaterial))
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help("Remove from shelf (the original is not touched)")
        .accessibilityLabel("Remove from shelf")
    }
}

struct InsertionBar: View {
    let height: CGFloat
    var body: some View {
        Capsule()
            .fill(Color.accentColor)
            .frame(width: 3, height: height * 0.8)
            .shadow(color: Color.accentColor.opacity(0.6), radius: 3)
            .allowsHitTesting(false)
    }
}

// MARK: - Previews

struct ItemPreview: View {
    let item: ShelfItem
    @ObservedObject var model: ShelfModel
    let side: CGFloat
    let loadWebsiteIcons: Bool

    var body: some View {
        switch item.kind {
        case .text:
            TextCard(text: textOf(item), side: side)
        case .link:
            LinkCard(item: item, side: side, loadIcon: loadWebsiteIcons)
        default:
            FileThumb(item: item, url: model.isAvailable(item) ? model.fileURL(for: item) : nil, side: side)
        }
    }

    private func textOf(_ item: ShelfItem) -> String {
        if case .data(let d) = item.content { return d.text ?? item.displayName }
        return item.displayName
    }
}

struct FileThumb: View {
    let item: ShelfItem
    let url: URL?
    let side: CGFloat
    @StateObject private var loader = ThumbnailLoader()
    @Environment(\.displayScale) private var scale

    var body: some View {
        ZStack {
            if let img = loader.image {
                if loader.isThumbnail {
                    Image(nsImage: img)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.primary.opacity(0.14), lineWidth: 0.5))
                        .shadow(color: .black.opacity(0.22), radius: 3, y: 1.5)
                        .padding(side * 0.07)
                } else {
                    Image(nsImage: img)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                        .padding(side * 0.02)
                }
            }
        }
        .frame(width: side, height: side)
        .onAppear { loader.load(item: item, url: url, side: side, scale: scale) }
        .onChange(of: url) { newURL in loader.load(item: item, url: newURL, side: side, scale: scale) }
        .onChange(of: side) { newSide in loader.load(item: item, url: url, side: newSide, scale: scale) }
    }
}

struct TextCard: View {
    let text: String
    let side: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(Color(nsColor: .textBackgroundColor))
            .overlay(
                Text(TextAnalysis.snippet(text, maxCharacters: 140))
                    .font(.system(size: max(7.5, side * 0.105)))
                    .foregroundStyle(Color.primary.opacity(0.75))
                    .multilineTextAlignment(.leading)
                    .padding(side * 0.08)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading),
                alignment: .topLeading
            )
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.primary.opacity(0.14), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.18), radius: 3, y: 1.5)
            .padding(side * 0.1)
    }
}

struct LinkCard: View {
    let item: ShelfItem
    let side: CGFloat
    let loadIcon: Bool
    @StateObject private var favicon = FaviconLoader()

    private var urlString: String? {
        if case .data(let d) = item.content { return d.url }
        return nil
    }

    private var host: String {
        guard let s = urlString, let u = URL(string: s) else { return item.displayName }
        return TextAnalysis.displayHost(u)
    }

    var body: some View {
        RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(LinearGradient(colors: [Color.accentColor.opacity(0.85), Color.accentColor.opacity(0.55)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(
                VStack(spacing: side * 0.06) {
                    Group {
                        if let img = favicon.image {
                            Image(nsImage: img).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
                                .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                        } else {
                            Image(systemName: "globe").resizable().aspectRatio(contentMode: .fit)
                                .foregroundStyle(Color.white.opacity(0.95))
                        }
                    }
                    .frame(width: side * 0.32, height: side * 0.32)
                    Text(host)
                        .font(.system(size: max(7.5, side * 0.11), weight: .semibold))
                        .foregroundStyle(Color.white)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .padding(.horizontal, 4)
                }
            )
            .shadow(color: .black.opacity(0.2), radius: 3, y: 1.5)
            .padding(side * 0.1)
            .onAppear { favicon.load(urlString, enabled: loadIcon) }
    }
}

/// Several items that arrived together, drawn as a small fanned pile with a count badge.
struct StackPreview: View {
    let items: [ShelfItem]
    @ObservedObject var model: ShelfModel
    let side: CGFloat
    let fanned: Bool
    let loadWebsiteIcons: Bool

    var body: some View {
        let shown = Array(items.prefix(3))
        let inner = side * 0.8
        ZStack {
            ForEach(Array(stride(from: shown.count - 1, through: 0, by: -1)), id: \.self) { i in
                ItemPreview(item: shown[i], model: model, side: inner, loadWebsiteIcons: loadWebsiteIcons)
                    .rotationEffect(.degrees(angle(i)))
                    .offset(x: offset(i), y: i == 0 ? 0 : -side * 0.02)
            }
            Text("\(items.count)")
                .font(.system(size: 10, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(Color.white)
                .padding(.horizontal, 6)
                .frame(minWidth: 18, minHeight: 17)
                .background(Capsule().fill(Color.accentColor))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.6), lineWidth: 1))
                .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        }
        .frame(width: side, height: side)
    }

    private func angle(_ i: Int) -> Double {
        switch i {
        case 1: return fanned ? -13 : -6
        case 2: return fanned ? 13 : 6
        default: return 0
        }
    }

    private func offset(_ i: Int) -> CGFloat {
        switch i {
        case 1: return fanned ? -side * 0.16 : -side * 0.05
        case 2: return fanned ? side * 0.16 : side * 0.05
        default: return 0
        }
    }
}

// MARK: - Empty state & editor

struct EmptyDropView: View {
    let targeted: Bool
    let receiving: Bool

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: targeted ? "tray.and.arrow.down.fill" : "tray.and.arrow.down")
                .font(.system(size: 26, weight: .light))
            Text(receiving ? "Receiving…" : (targeted ? "Release to keep it here" : "Drop here"))
                .font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(targeted ? Color.accentColor : Color.secondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(targeted ? Color.accentColor.opacity(0.10) : Color.clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(targeted ? Color.accentColor : Color.secondary.opacity(0.45),
                              style: StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
        )
        .scaleEffect(targeted ? 1.03 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Empty shelf. Drop files, images, text or links here.")
    }
}

struct TextEditOverlay: View {
    let item: ShelfItem
    let controller: ShelfController
    @State private var text: String
    @FocusState private var focused: Bool

    init(item: ShelfItem, controller: ShelfController) {
        self.item = item
        self.controller = controller
        var initial = ""
        if case .data(let d) = item.content { initial = d.text ?? "" }
        _text = State(initialValue: initial)
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Text("Edit Text").font(.system(size: 12, weight: .semibold))
                Spacer()
            }
            TextEditor(text: $text)
                .font(.system(size: 12))
                .scrollContentBackground(.hidden)
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.primary.opacity(0.15), lineWidth: 0.5))
                .focused($focused)
                .accessibilityLabel("Text")
            HStack {
                Button("Cancel") { controller.cancelEditing() }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Save") { controller.commitEditing(text) }
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("Save (⌘↩)")
            }
            .controlSize(.small)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
        .onAppear { focused = true }
    }
}
