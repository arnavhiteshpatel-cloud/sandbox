import SwiftUI
import AppKit
import DragShelfCore

/// Hosting view that accepts the first click even though the panel never activates the app,
/// so header buttons work on the first click.
final class ShelfHostingView: NSHostingView<ShelfRootView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

struct ShelfRootView: View {
    @ObservedObject var model: ShelfModel
    @ObservedObject var settingsStore: SettingsStore
    let controller: ShelfController

    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = true

    private var settings: DragShelfSettings { settingsStore.settings }
    private var tile: CGFloat { CGFloat(settings.shelfSize.tileSide) }
    private var highContrast: Bool { contrast == .increased }

    private var animation: Animation? {
        switch settings.animationStyle {
        case .off: return nil
        case .reduced: return .easeInOut(duration: 0.15)
        case .full: return reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.32, dampingFraction: 0.82)
        }
    }

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                ShelfHeader(model: model, controller: controller)
                content
            }
            if let id = model.editingItemID, let item = model.library.item(id) {
                TextEditOverlay(item: item, controller: controller)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(sheen)
        .clipShape(RoundedRectangle(cornerRadius: DropTargetView.cornerRadius, style: .continuous))
        .overlay(border)
        .scaleEffect(appeared ? 1 : 0.965)
        .onChange(of: model.appearToken) { _ in
            guard settings.animationStyle == .full, !reduceMotion else { return }
            appeared = false
            withAnimation(.spring(response: 0.36, dampingFraction: 0.72)) { appeared = true }
        }
        .animation(animation, value: model.library)
        .animation(animation, value: model.expandedEntryID)
        .animation(animation, value: model.isDropTargeted)
        .animation(animation, value: model.dropInsertionIndex)
        .animation(animation, value: model.editingItemID)
    }

    @ViewBuilder private var content: some View {
        if let entry = model.expandedEntry {
            ShelfGrid(targets: entry.items.map { TileTarget.item($0.id) }, model: model, controller: controller,
                      tile: tile, loadWebsiteIcons: settings.loadWebsiteIcons)
        } else if model.activeShelf.isEmpty {
            EmptyDropView(targeted: model.isDropTargeted, receiving: model.pendingReceives > 0)
                .frame(height: ShelfLayout.emptyDropHeight)
                .padding(.horizontal, ShelfLayout.padding)
                .padding(.bottom, ShelfLayout.padding)
        } else {
            ShelfGrid(targets: model.activeShelf.entries.map { TileTarget.entry($0.id) }, model: model, controller: controller,
                      tile: tile, loadWebsiteIcons: settings.loadWebsiteIcons)
        }
    }

    private var sheen: some View {
        Group {
            if highContrast {
                Color(nsColor: .windowBackgroundColor).opacity(0.92)
            } else {
                LinearGradient(colors: [Color.white.opacity(0.10), Color.white.opacity(0.0)], startPoint: .top, endPoint: .center)
            }
        }
    }

    private var border: some View {
        let targeted = model.isDropTargeted
        return RoundedRectangle(cornerRadius: DropTargetView.cornerRadius, style: .continuous)
            .strokeBorder(targeted ? Color.accentColor.opacity(0.95) : Color.primary.opacity(highContrast ? 0.5 : 0.12),
                          lineWidth: targeted ? 2 : (highContrast ? 1.5 : 0.5))
            .shadow(color: targeted ? Color.accentColor.opacity(0.45) : .clear, radius: 8)
            .allowsHitTesting(false)
    }
}

// MARK: - Header

struct ShelfHeader: View {
    @ObservedObject var model: ShelfModel
    let controller: ShelfController

    var body: some View {
        HStack(spacing: 4) {
            if let entry = model.expandedEntry {
                HeaderButton(symbol: "chevron.left", label: "Back to shelf") { controller.collapse() }
                Text("\(entry.items.count) items")
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                HeaderButton(symbol: "square.grid.2x2", label: "Unstack") {
                    let id = entry.id
                    controller.collapse()
                    model.mutate { $0.unstack(id) }
                }
            } else if model.library.shelves.count > 1 {
                ShelfChips(model: model, controller: controller)
                Spacer(minLength: 2)
            } else {
                Text(model.library.displayName(of: model.activeShelf))
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                if model.activeShelf.itemCount > 0 {
                    Text("\(model.activeShelf.itemCount)")
                        .font(.system(size: 11, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("\(model.activeShelf.itemCount) items")
                }
                Spacer(minLength: 4)
            }

            if model.pendingReceives > 0 {
                ProgressView()
                    .controlSize(.small)
                    .scaleEffect(0.6)
                    .frame(width: 18, height: 18)
                    .accessibilityLabel("Receiving files")
            }
            if model.storageOverLimit {
                Image(systemName: "externaldrive.badge.exclamationmark")
                    .font(.system(size: 11))
                    .foregroundStyle(.orange)
                    .help("Stored copies exceed the storage limit set in Settings.")
                    .accessibilityLabel("Storage limit exceeded")
            }
            HeaderButton(symbol: model.isPinned ? "pin.fill" : "pin",
                         label: model.isPinned ? "Unpin shelf" : "Pin shelf (keep it open)",
                         active: model.isPinned) { controller.togglePin() }
            HeaderButton(symbol: "ellipsis.circle", label: "More") { controller.showMoreMenu() }
        }
        .padding(.leading, 12)
        .padding(.trailing, 8)
        .frame(height: ShelfLayout.headerHeight)
    }
}

struct HeaderButton: View {
    let symbol: String
    let label: String
    var active = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(active ? Color.accentColor : (hovering ? Color.primary : Color.secondary))
                .frame(width: 24, height: 24)
                .background(Circle().fill(Color.primary.opacity(hovering ? 0.09 : 0)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}

/// Shelf switcher (only shown when there is more than one shelf).
struct ShelfChips: View {
    @ObservedObject var model: ShelfModel
    let controller: ShelfController

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(model.library.shelves) { shelf in
                    let active = shelf.id == model.library.activeShelfID
                    let targeted = model.dropTargetShelfID == shelf.id
                    HStack(spacing: 3) {
                        Text(model.library.displayName(of: shelf))
                            .lineLimit(1)
                        if shelf.itemCount > 0 {
                            Text("\(shelf.itemCount)").monospacedDigit().opacity(0.7)
                        }
                    }
                    .font(.system(size: 11, weight: active ? .semibold : .medium))
                    .foregroundStyle(active ? Color.white : Color.primary)
                    .padding(.horizontal, 8)
                    .frame(height: 20)
                    .background(Capsule().fill(active ? Color.accentColor : Color.primary.opacity(targeted ? 0.2 : 0.07)))
                    .overlay(Capsule().strokeBorder(Color.accentColor, lineWidth: targeted ? 1.5 : 0))
                    .overlay(TileHitArea(target: .shelf(shelf.id), delegate: controller,
                                         toolTip: "Drop here to move items to this shelf. Right-click for options."))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(model.library.displayName(of: shelf)), \(shelf.itemCount) items\(active ? ", current" : "")")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { controller.switchToShelf(shelf.id) }
                }
            }
        }
    }
}
