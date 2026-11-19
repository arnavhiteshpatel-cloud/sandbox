import AppKit
import DragShelfCore

/// Detects drags reaching the activation edge/corner.
///
/// How a system-wide drag is recognised (no Accessibility permission needed):
///  • A global + local NSEvent monitor observes left-mouse down / dragged / up. macOS delivers
///    these to monitors of other apps without special permission (keyboard events would need it).
///  • On mouse-down the change count of the shared *drag pasteboard* (NSPasteboard(name: .drag))
///    is remembered. Every app that starts an AppKit drag session writes its items to that
///    pasteboard, so when the count changes during the same mouse-down, a real drag with content
///    is in progress — as opposed to selecting text, resizing a window or drawing a marquee.
///  • Only then are cursor positions fed to the dwell detector.
///
/// Limits (documented in docs/DESIGN.md): drags implemented without the AppKit pasteboard
/// (rare; some games/remote-desktop apps) won't be recognised; the keyboard shortcut still works.
final class DragMonitor {
    /// Called when the shelf should appear.
    var onActivate: ((ActivationHit, RevealReason) -> Void)?
    /// Called when a recognised drag starts / ends anywhere on the system.
    var onDragStateChanged: ((Bool) -> Void)?

    private(set) var isDragging = false
    private var monitors: [Any] = []
    private var hoverMonitors: [Any] = []
    private var dragChangeCount = 0
    private var lastPasteboardCheck: TimeInterval = 0
    private var deadline: DispatchWorkItem?
    private var mouseIsDown = false

    private let dragDetector: ActivationDetector
    private let hoverDetector: ActivationDetector
    private(set) var screens: [ScreenInfo] = []

    init(settings: DragShelfSettings) {
        dragDetector = ActivationDetector(config: settings.activationConfig, screens: [])
        hoverDetector = ActivationDetector(config: settings.hoverActivationConfig, screens: [])
        refreshScreens()
    }

    deinit { stop() }

    // MARK: Configuration

    func apply(_ settings: DragShelfSettings) {
        dragDetector.config = settings.activationConfig
        hoverDetector.config = settings.hoverActivationConfig
    }

    func refreshScreens() {
        let primary = NSScreen.screens.first
        screens = NSScreen.screens.map {
            ScreenInfo(id: $0.displayIdentifier, frame: $0.frame, visibleFrame: $0.visibleFrame, isPrimary: $0 == primary)
        }
        dragDetector.screens = screens
        hoverDetector.screens = screens
    }

    // MARK: Lifecycle

    func start() {
        guard monitors.isEmpty else { return }
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        if let g = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] e in self?.handle(e) }) {
            monitors.append(g)
        }
        if let l = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] e in self?.handle(e); return e }) {
            monitors.append(l)
        }
    }

    func stop() {
        monitors.forEach { NSEvent.removeMonitor($0) }
        monitors.removeAll()
        setHoverMonitoring(false)
        deadline?.cancel()
    }

    /// Hover reveal (no drag) needs mouse-moved events. They are only observed while the shelf
    /// is hidden *and* holds items *and* the option is on — otherwise nothing is installed.
    func setHoverMonitoring(_ enabled: Bool) {
        if enabled == !hoverMonitors.isEmpty { return }
        if enabled {
            if let g = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] e in self?.handleHover(e) }) {
                hoverMonitors.append(g)
            }
            if let l = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved], handler: { [weak self] e in self?.handleHover(e); return e }) {
                hoverMonitors.append(l)
            }
        } else {
            hoverMonitors.forEach { NSEvent.removeMonitor($0) }
            hoverMonitors.removeAll()
            hoverDetector.reset()
        }
    }

    var isHoverMonitoring: Bool { !hoverMonitors.isEmpty }

    // MARK: Events

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func handle(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown:
            mouseIsDown = true
            dragChangeCount = NSPasteboard(name: .drag).changeCount
            lastPasteboardCheck = 0
            setDragging(false)
            dragDetector.reset()

        case .leftMouseDragged:
            if !isDragging {
                // Throttle the (IPC) change-count query to ~30 Hz while the button is held.
                let t = now
                guard t - lastPasteboardCheck > 0.033 else { return }
                lastPasteboardCheck = t
                guard NSPasteboard(name: .drag).changeCount != dragChangeCount else { return }
                setDragging(true)
            }
            process(dragDetector.update(point: NSEvent.mouseLocation, time: now), reason: .drag)

        case .leftMouseUp:
            mouseIsDown = false
            deadline?.cancel()
            dragDetector.reset()
            setDragging(false)

        default:
            break
        }
    }

    private func handleHover(_ event: NSEvent) {
        guard !mouseIsDown else { return }
        process(hoverDetector.update(point: NSEvent.mouseLocation, time: now), reason: .hover)
    }

    private func setDragging(_ dragging: Bool) {
        guard dragging != isDragging else { return }
        isDragging = dragging
        onDragStateChanged?(dragging)
    }

    /// Called when a drag ends without a mouse-up reaching us (e.g. dropped onto the shelf,
    /// whose own app consumes the event) — keeps state honest.
    func noteDragEnded() {
        if NSEvent.pressedMouseButtons & 1 == 0 {
            mouseIsDown = false
            deadline?.cancel()
            dragDetector.reset()
            setDragging(false)
        }
    }

    private func process(_ output: ActivationDetector.Output, reason: RevealReason) {
        switch output {
        case .none:
            deadline?.cancel()
            deadline = nil
        case .activate(let hit):
            deadline?.cancel()
            deadline = nil
            onActivate?(hit, reason)
        case .pending(let at):
            // The cursor may rest against the edge without producing events: check once at the deadline.
            deadline?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                if reason == .drag {
                    guard self.isDragging, NSEvent.pressedMouseButtons & 1 != 0 else { return }
                    self.process(self.dragDetector.update(point: NSEvent.mouseLocation, time: self.now), reason: .drag)
                } else {
                    guard self.isHoverMonitoring else { return }
                    self.process(self.hoverDetector.update(point: NSEvent.mouseLocation, time: self.now), reason: .hover)
                }
            }
            deadline = work
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0.01, at - now + 0.005), execute: work)
        }
    }

    /// Whether `point` is inside an activation region (used to keep a just-revealed shelf open
    /// while the cursor still rests at the edge).
    func isInActivationRegion(_ point: CGPoint) -> Bool {
        ActivationGeometry.hit(at: point, screens: screens, config: dragDetector.config) != nil
    }
}

extension NSScreen {
    var displayIdentifier: String {
        if let n = deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            return n.stringValue
        }
        return localizedName
    }
}
