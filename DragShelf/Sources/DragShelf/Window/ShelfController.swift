import AppKit
import SwiftUI
import Quartz
import DragShelfCore

extension TileTarget {
    var id: UUID {
        switch self {
        case .entry(let i), .item(let i), .shelf(let i): return i
        }
    }
}

/// Owns the shelf panel: showing, placing, resizing, hiding, and all interaction with it.
final class ShelfController: NSObject {
    let model: ShelfModel
    let settingsStore: SettingsStore
    let ingestor: PasteboardIngestor
    let panel = ShelfPanel()
    let dropView = DropTargetView(frame: NSRect(x: 0, y: 0, width: 200, height: 160))
    let quickLook = QuickLookController()
    weak var dragMonitor: DragMonitor?

    var hide: HideController
    private(set) var isShown = false
    private(set) var edge: ScreenEdge = .right
    private var screenID: String?
    private var hideWork: DispatchWorkItem?
    private var visibilityGeneration = 0
    let tileViews = NSHashTable<TileInteractionView>.weakObjects()
    var lastClickedID: UUID?
    var isQuickLookLocked = false

    // Wired by AppController.
    var onVisibilityChanged: ((Bool) -> Void)?
    var openSettingsHandler: (() -> Void)?
    var addClipboardHandler: (() -> Void)?
    var clipboardWriteHandler: (() -> Void)?

    var settings: DragShelfSettings { settingsStore.settings }

    init(model: ShelfModel, settingsStore: SettingsStore, ingestor: PasteboardIngestor) {
        self.model = model
        self.settingsStore = settingsStore
        self.ingestor = ingestor
        self.hide = HideController(emptyHideDelay: settingsStore.settings.emptyHideDelay,
                                   collapseDelay: settingsStore.settings.collapseDelay)
        super.init()

        dropView.delegate = self
        let root = ShelfRootView(model: model, settingsStore: settingsStore, controller: self)
        let hosting = ShelfHostingView(rootView: root)
        // The panel size is driven by ShelfLayout, not by SwiftUI's ideal size.
        hosting.sizingOptions = []
        dropView.install(content: hosting)
        panel.contentView = dropView
        panel.delegate = self
        panel.keyHandler = { [weak self] e in self?.handleKey(e) ?? false }
        quickLook.onEnd = nil
    }

    // MARK: Settings

    func apply(_ s: DragShelfSettings) {
        hide.emptyHideDelay = s.emptyHideDelay
        hide.collapseDelay = s.collapseDelay
        panel.appearance = Self.appearance(for: s.appearance)
        if isShown { relayout(animated: true) }
    }

    static func appearance(for mode: AppearanceMode) -> NSAppearance? {
        switch mode {
        case .system: return nil
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        }
    }

    private var motion: (slide: Bool, duration: TimeInterval) {
        switch settings.animationStyle {
        case .off: return (false, 0)
        case .reduced: return (false, 0.14)
        case .full:
            return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? (false, 0.14) : (true, 0.26)
        }
    }

    // MARK: Showing

    /// Reveal from an activation hit (drag or hover at an edge/corner).
    func reveal(from hit: ActivationHit, reason: RevealReason) {
        let screen = NSScreen.screens.first { $0.displayIdentifier == hit.screenID } ?? NSScreen.main ?? NSScreen.screens[0]
        reveal(reason: reason, edge: hit.target.anchorEdge, screen: screen, anchor: hit.point, makeKey: false)
    }

    /// Reveal from the keyboard shortcut or menu, on the display with the pointer (or the primary).
    func revealFromShortcut() {
        let mouse = NSEvent.mouseLocation
        let screen: NSScreen
        if settings.displayMode == .primaryOnly {
            screen = NSScreen.screens.first ?? NSScreen.main!
        } else {
            screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
        }
        let e = preferredEdge
        let f = screen.frame
        let anchor: CGPoint
        if let c = settings.corner, settings.edges.isEmpty {
            switch c {
            case .topLeft, .topRight: anchor = CGPoint(x: f.midX, y: f.maxY)
            case .bottomLeft, .bottomRight: anchor = CGPoint(x: f.midX, y: f.minY)
            }
        } else {
            anchor = CGPoint(x: f.midX, y: f.midY)
        }
        reveal(reason: .shortcut, edge: e, screen: screen, anchor: anchor, makeKey: true)
    }

    var preferredEdge: ScreenEdge {
        for e in [ScreenEdge.right, .left, .bottom, .top] where settings.edges.contains(e) { return e }
        return settings.corner?.anchorEdge ?? .right
    }

    func toggleFromShortcut() {
        if isShown {
            dismiss()
        } else {
            revealFromShortcut()
        }
    }

    /// Briefly shows the shelf (e.g. after adding the clipboard) without taking focus.
    func flash() {
        if isShown {
            send(.revealed(.drag))
            return
        }
        let mouse = NSEvent.mouseLocation
        let screen = settings.displayMode == .primaryOnly ? (NSScreen.screens.first ?? NSScreen.main!) :
            (NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0])
        reveal(reason: .drag, edge: preferredEdge, screen: screen, anchor: CGPoint(x: screen.frame.midX, y: screen.frame.midY), makeKey: false)
    }

    func reveal(reason: RevealReason, edge newEdge: ScreenEdge, screen: NSScreen, anchor: CGPoint, makeKey: Bool) {
        model.refreshAvailability()
        if isShown {
            send(.revealed(reason))
            if makeKey { panel.makeKeyAndOrderFront(nil) }
            return
        }
        cancelHideTimer()
        edge = newEdge
        screenID = screen.displayIdentifier
        panel.appearance = Self.appearance(for: settings.appearance)

        let target = targetFrame(on: screen, anchor: anchor)
        let m = motion
        visibilityGeneration += 1
        panel.setFrame(m.slide ? ShelfLayout.hiddenFrame(for: target, edge: edge) : target, display: false)
        panel.alphaValue = m.duration > 0 ? 0 : 1
        if makeKey { panel.makeKeyAndOrderFront(nil) } else { panel.orderFrontRegardless() }
        isShown = true
        if m.duration > 0 {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = m.duration
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1.0)
                panel.animator().setFrame(target, display: true)
                panel.animator().alphaValue = 1
            }
        }
        panel.invalidateShadow()
        model.appearToken += 1
        hide.handle(.itemCount(model.activeShelf.itemCount))
        hide.handle(.pinned(model.isPinned))
        send(.revealed(reason))
        onVisibilityChanged?(true)
    }

    func dismiss(animated: Bool = true) {
        guard isShown else { return }
        cancelHideTimer()
        isShown = false
        if QLPreviewPanel.sharedPreviewPanelExists(), let ql = QLPreviewPanel.shared(), ql.isVisible {
            ql.orderOut(nil)
        }
        if model.editingItemID != nil { model.editingItemID = nil }
        model.hovered = nil
        model.isDropTargeted = false
        model.dropInsertionIndex = nil
        model.dropTargetShelfID = nil
        hide.handle(.hidden)

        visibilityGeneration += 1
        let generation = visibilityGeneration
        let m = motion
        let finish = { [weak self] in
            guard let self = self, self.visibilityGeneration == generation else { return }
            self.panel.orderOut(nil)
            self.panel.alphaValue = 1
        }
        if animated && m.duration > 0 {
            let out = m.slide ? ShelfLayout.hiddenFrame(for: panel.frame, edge: edge) : panel.frame
            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = m.duration * 0.75
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                panel.animator().setFrame(out, display: true)
                panel.animator().alphaValue = 0
            }, completionHandler: finish)
        } else {
            finish()
        }
        onVisibilityChanged?(false)
    }

    // MARK: Layout

    private var currentScreen: NSScreen {
        NSScreen.screens.first { $0.displayIdentifier == screenID } ?? panel.screen ?? NSScreen.main ?? NSScreen.screens[0]
    }

    var tileSide: CGFloat { CGFloat(settings.shelfSize.tileSide) }

    var tileCount: Int {
        model.expandedEntry?.items.count ?? model.activeShelf.entries.count
    }

    func currentLayout(on screen: NSScreen? = nil) -> ShelfLayout {
        let vf = (screen ?? currentScreen).visibleFrame
        let maxLength = edge.orientation == .vertical ? vf.height * 0.8 : vf.width * 0.8
        return ShelfLayout.compute(count: tileCount, orientation: edge.orientation, tile: tileSide, maxLength: maxLength)
    }

    private func targetFrame(on screen: NSScreen, anchor: CGPoint) -> CGRect {
        var size = currentLayout(on: screen).contentSize
        if model.editingItemID != nil {
            // Give the text editor room to work.
            size.width = max(size.width, 300)
            size.height = max(size.height, 260)
        }
        return ShelfLayout.panelFrame(size: size, edge: edge, anchor: anchor, visibleFrame: screen.visibleFrame)
    }

    /// Resizes the panel for its current contents, keeping it centred where it is.
    func relayout(animated: Bool) {
        guard isShown else { return }
        let screen = currentScreen
        let f = panel.frame
        let target = targetFrame(on: screen, anchor: CGPoint(x: f.midX, y: f.midY))
        guard target != f else { return }
        if animated && motion.duration > 0 {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.2
                ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1.0)
                panel.animator().setFrame(target, display: true)
            }
        } else {
            panel.setFrame(target, display: true)
        }
        panel.invalidateShadow()
    }

    /// Displays were added/removed/rearranged.
    func screensChanged() {
        guard isShown else { return }
        if !NSScreen.screens.contains(where: { $0.displayIdentifier == screenID }) {
            screenID = (NSScreen.main ?? NSScreen.screens.first)?.displayIdentifier
        }
        relayout(animated: false)
    }

    func libraryChanged() {
        hide.handle(.itemCount(model.activeShelf.itemCount))
        if isShown {
            relayout(animated: true)
            apply(hide.decision)
        }
    }

    // MARK: Hiding

    func send(_ event: HideController.Event) {
        apply(hide.handle(event))
    }

    private func apply(_ decision: HideDecision) {
        cancelHideTimer()
        guard isShown, case .hideAfter(let delay) = decision else { return }
        let work = DispatchWorkItem { [weak self] in self?.hideTimerFired() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func cancelHideTimer() {
        hideWork?.cancel()
        hideWork = nil
    }

    private func hideTimerFired() {
        guard isShown else { return }
        let mouse = NSEvent.mouseLocation
        let near = panel.frame.insetBy(dx: -4, dy: -4).contains(mouse)
        let dragging = dragMonitor?.isDragging == true && NSEvent.pressedMouseButtons & 1 != 0
        let atEdge = dragMonitor?.isInActivationRegion(mouse) == true
        // Fallbacks for tracking events AppKit doesn't deliver during drags:
        //  • pointer over the shelf → not in use-finished yet
        //  • a drag is still going and the pointer rests at the edge or right next to the shelf
        //  • a hover reveal while the pointer still rests at the edge
        if near
            || (dragging && (atEdge || panel.frame.insetBy(dx: -60, dy: -60).contains(mouse)))
            || (hide.reason == .hover && atEdge) {
            apply(hide.decision)
            return
        }
        dismiss()
    }

    func togglePin() {
        model.isPinned.toggle()
        send(.pinned(model.isPinned))
    }

    func focusPanel() {
        panel.makeKeyAndOrderFront(nil)
    }
}

// MARK: - NSWindowDelegate

extension ShelfController: NSWindowDelegate {
    func windowDidBecomeKey(_ notification: Notification) {
        send(.focusGained)
    }

    func windowDidResignKey(_ notification: Notification) {
        send(.focusLost)
    }
}
