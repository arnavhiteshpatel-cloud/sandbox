import AppKit
import UniformTypeIdentifiers

protocol DropTargetDelegate: AnyObject {
    func dropTargetEntered(_ info: NSDraggingInfo) -> NSDragOperation
    func dropTargetUpdated(_ info: NSDraggingInfo) -> NSDragOperation
    func dropTargetExited()
    func dropTargetPerform(_ info: NSDraggingInfo) -> Bool
    func dropTargetEnded()
    func pointerEntered()
    func pointerExited()
}

/// The panel's content view: blurred glass background + SwiftUI content, and the
/// NSDraggingDestination that accepts drops from any app.
final class DropTargetView: NSView {
    weak var delegate: DropTargetDelegate?
    let effectView = NSVisualEffectView()
    private var trackingArea: NSTrackingArea?

    static let cornerRadius: CGFloat = 18

    /// Everything DragShelf can store. File promises are included so screenshots, Photos,
    /// Mail attachments and browser images can be dropped.
    static var acceptedTypes: [NSPasteboard.PasteboardType] {
        var t: [NSPasteboard.PasteboardType] = [
            .fileURL, .URL, .string, .rtf, .rtfd, .html, .pdf, .tiff, .png,
            NSPasteboard.PasteboardType("public.jpeg"), NSPasteboard.PasteboardType("public.heic"),
            NSPasteboard.PasteboardType("com.compuserve.gif"), NSPasteboard.PasteboardType("public.url"),
            NSPasteboard.PasteboardType("public.utf16-plain-text"), NSPasteboard.PasteboardType("public.plain-text"),
            NSPasteboard.PasteboardType("com.apple.webarchive"), NSPasteboard.PasteboardType("public.vcard"),
            NSPasteboard.PasteboardType("com.apple.flat-rtfd"), NSPasteboard.PasteboardType("public.image"),
            NSPasteboard.PasteboardType("public.movie"), NSPasteboard.PasteboardType("public.audio"),
            NSPasteboard.PasteboardType("NSFilenamesPboardType"),
            DragShelfPasteboard.internalType,
        ]
        t += NSFilePromiseReceiver.readableDraggedTypes.map { NSPasteboard.PasteboardType($0) }
        return t
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        effectView.material = .popover
        effectView.blendingMode = .behindWindow
        effectView.state = .active
        effectView.maskImage = Self.roundedMask(radius: Self.cornerRadius)
        effectView.frame = bounds
        effectView.autoresizingMask = [.width, .height]
        addSubview(effectView)
        registerForDraggedTypes(Self.acceptedTypes)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func install(content: NSView) {
        content.frame = bounds
        content.autoresizingMask = [.width, .height]
        addSubview(content)
    }

    static func roundedMask(radius: CGFloat) -> NSImage {
        let side = radius * 2 + 1
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
            return true
        }
        image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
        image.resizingMode = .stretch
        return image
    }

    // MARK: Pointer tracking

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingArea { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingArea = t
    }

    override func mouseEntered(with event: NSEvent) { delegate?.pointerEntered() }
    override func mouseExited(with event: NSEvent) { delegate?.pointerExited() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: NSDraggingDestination

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        delegate?.dropTargetEntered(sender) ?? []
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        delegate?.dropTargetUpdated(sender) ?? []
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        delegate?.dropTargetExited()
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool { true }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        delegate?.dropTargetPerform(sender) ?? false
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        delegate?.dropTargetEnded()
    }
}

/// Marker flavour written by DragShelf's own drags, so a drop back onto a shelf is a move/reorder.
enum DragShelfPasteboard {
    static let internalType = NSPasteboard.PasteboardType("app.dragshelf.internal-drag")
}
