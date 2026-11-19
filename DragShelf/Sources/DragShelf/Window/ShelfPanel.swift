import AppKit
import Quartz

/// The shelf window: a borderless, non-activating floating panel.
///  • Non-activating: clicking or dragging from it never steals focus from the app you're in.
///  • Joins all Spaces and floats over full-screen apps.
///  • Never appears in the Dock, app switcher or Mission Control window cycle.
final class ShelfPanel: NSPanel {
    /// Returns true if the key event was handled.
    var keyHandler: ((NSEvent) -> Bool)?
    /// Quick Look data source/delegate while the preview panel is controlled by the shelf.
    weak var quickLookController: QuickLookController?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 200, height: 160),
                   styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: true)
        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        hidesOnDeactivate = false
        isMovable = false
        isMovableByWindowBackground = false
        animationBehavior = .none
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
        worksWhenModal = true
        title = "DragShelf"
        setAccessibilityLabel("DragShelf")
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func keyDown(with event: NSEvent) {
        if keyHandler?(event) == true { return }
        super.keyDown(with: event)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command), keyHandler?(event) == true { return true }
        return super.performKeyEquivalent(with: event)
    }

    override func cancelOperation(_ sender: Any?) {
        if let e = NSApp.currentEvent, e.type == .keyDown, keyHandler?(e) == true { return }
    }

    // MARK: Quick Look (QLPreviewPanelController informal protocol)

    override func acceptsPreviewPanelControl(_ panel: QLPreviewPanel!) -> Bool {
        quickLookController != nil
    }

    override func beginPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = quickLookController
        panel.delegate = quickLookController
    }

    override func endPreviewPanelControl(_ panel: QLPreviewPanel!) {
        panel.dataSource = nil
        panel.delegate = nil
        quickLookController?.didEnd()
    }
}

/// Supplies items to the system Quick Look panel.
final class QuickLookController: NSObject, QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    var urls: [URL] = []
    var onEnd: (() -> Void)?

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { urls.count }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> QLPreviewItem! {
        urls[index] as NSURL
    }

    func previewPanel(_ panel: QLPreviewPanel!, handle event: NSEvent!) -> Bool {
        // Let Space / Escape close the panel normally.
        false
    }

    func didEnd() {
        let f = onEnd
        onEnd = nil
        f?()
    }
}
