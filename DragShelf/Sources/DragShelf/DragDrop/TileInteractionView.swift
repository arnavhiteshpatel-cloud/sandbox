import AppKit
import SwiftUI

protocol TileInteractionDelegate: AnyObject {
    func tileClicked(_ target: TileTarget, modifiers: NSEvent.ModifierFlags, clickCount: Int)
    func tileMouseUp(_ target: TileTarget, modifiers: NSEvent.ModifierFlags)
    func tileBeganDrag(_ target: TileTarget, from view: TileInteractionView, event: NSEvent)
    func tileMenu(_ target: TileTarget, view: TileInteractionView) -> NSMenu?
    func tileHover(_ target: TileTarget, inside: Bool)
    func tileRegistered(_ view: TileInteractionView)
}

/// A transparent AppKit view laid over each SwiftUI tile. It owns the precise mouse handling
/// SwiftUI can't provide: click-through on an inactive panel, multi-item drag sessions
/// (NSDraggingSession), context menus and hover tracking — without delaying drags.
final class TileInteractionView: NSView {
    var target: TileTarget = .entry(UUID())
    weak var delegate: TileInteractionDelegate?
    /// The session source (the shelf controller) for drags started here.
    weak var draggingSource: NSDraggingSource?

    private var mouseDownEvent: NSEvent?
    private var trackingArea: NSTrackingArea?
    private var dragStarted = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { delegate?.tileRegistered(self) }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingArea { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingArea = t
    }

    override func mouseEntered(with event: NSEvent) { delegate?.tileHover(target, inside: true) }
    override func mouseExited(with event: NSEvent) { delegate?.tileHover(target, inside: false) }

    override func mouseDown(with event: NSEvent) {
        mouseDownEvent = event
        dragStarted = false
        // Selection happens on mouse-down (so a drag carries the current selection);
        // double-click opens.
        delegate?.tileClicked(target, modifiers: event.modifierFlags, clickCount: event.clickCount)
    }

    override func mouseDragged(with event: NSEvent) {
        guard !dragStarted, let down = mouseDownEvent else { return }
        let a = down.locationInWindow, b = event.locationInWindow
        guard hypot(b.x - a.x, b.y - a.y) >= 3 else { return }
        dragStarted = true
        delegate?.tileBeganDrag(target, from: self, event: down)
    }

    override func mouseUp(with event: NSEvent) {
        let wasClick = !dragStarted && mouseDownEvent != nil && event.clickCount <= 1
        mouseDownEvent = nil
        dragStarted = false
        if wasClick { delegate?.tileMouseUp(target, modifiers: event.modifierFlags) }
    }

    override func rightMouseDown(with event: NSEvent) {
        if case .shelf = target {} else {
            delegate?.tileClicked(target, modifiers: event.modifierFlags.union(.control), clickCount: 1)
        }
        super.rightMouseDown(with: event)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        delegate?.tileMenu(target, view: self)
    }

    // Accessibility is provided by the SwiftUI tile underneath.
    override func isAccessibilityElement() -> Bool { false }
}

/// SwiftUI wrapper for `TileInteractionView`.
struct TileHitArea: NSViewRepresentable {
    let target: TileTarget
    weak var delegate: TileInteractionDelegate?
    var toolTip: String?

    func makeNSView(context: Context) -> TileInteractionView {
        let v = TileInteractionView(frame: .zero)
        v.target = target
        v.delegate = delegate
        v.toolTip = toolTip
        return v
    }

    func updateNSView(_ nsView: TileInteractionView, context: Context) {
        nsView.target = target
        nsView.delegate = delegate
        if nsView.toolTip != toolTip { nsView.toolTip = toolTip }
    }
}
