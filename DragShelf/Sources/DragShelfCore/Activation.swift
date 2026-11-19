import Foundation

// MARK: - Screen description (platform neutral)

/// A display, described in the global AppKit coordinate space
/// (origin at the bottom-left of the primary display, y grows upwards).
public struct ScreenInfo: Equatable {
    public var id: String
    public var frame: CGRect
    /// Frame minus menu bar and Dock (where the shelf may be placed).
    public var visibleFrame: CGRect
    public var isPrimary: Bool

    public init(id: String, frame: CGRect, visibleFrame: CGRect? = nil, isPrimary: Bool) {
        self.id = id
        self.frame = frame
        self.visibleFrame = visibleFrame ?? frame
        self.isPrimary = isPrimary
    }
}

public enum ScreenEdge: String, Codable, CaseIterable, Hashable {
    case left, right, top, bottom

    public var title: String {
        switch self {
        case .left: return "Left"
        case .right: return "Right"
        case .top: return "Top"
        case .bottom: return "Bottom"
        }
    }

    /// Left/right edges show a vertical (column) shelf, top/bottom a horizontal strip.
    public var orientation: ShelfOrientation {
        switch self {
        case .left, .right: return .vertical
        case .top, .bottom: return .horizontal
        }
    }
}

public enum ScreenCorner: String, Codable, CaseIterable, Hashable {
    case topLeft, topRight, bottomLeft, bottomRight

    public var title: String {
        switch self {
        case .topLeft: return "Top Left"
        case .topRight: return "Top Right"
        case .bottomLeft: return "Bottom Left"
        case .bottomRight: return "Bottom Right"
        }
    }

    /// The edge along which a shelf revealed from this corner is laid out.
    public var anchorEdge: ScreenEdge {
        switch self {
        case .topLeft, .bottomLeft: return .left
        case .topRight, .bottomRight: return .right
        }
    }
}

public enum ActivationTarget: Equatable, Hashable {
    case edge(ScreenEdge)
    case corner(ScreenCorner)

    public var anchorEdge: ScreenEdge {
        switch self {
        case .edge(let e): return e
        case .corner(let c): return c.anchorEdge
        }
    }
}

public struct ActivationHit: Equatable {
    public var screenID: String
    public var target: ActivationTarget
    public var point: CGPoint
}

public struct ActivationConfig: Equatable {
    public var edges: Set<ScreenEdge>
    public var corner: ScreenCorner?
    /// Thickness of the activation band, in points.
    public var sensitivity: CGFloat
    /// Dwell time required inside the band before activating.
    public var delay: TimeInterval
    /// When true only the primary display has activation regions.
    public var primaryDisplayOnly: Bool

    public init(edges: Set<ScreenEdge>, corner: ScreenCorner?, sensitivity: CGFloat, delay: TimeInterval, primaryDisplayOnly: Bool) {
        self.edges = edges
        self.corner = corner
        self.sensitivity = sensitivity
        self.delay = delay
        self.primaryDisplayOnly = primaryDisplayOnly
    }

    /// Side length of the square corner region.
    public var cornerSize: CGFloat { max(sensitivity * 4, 24) }
}

// MARK: - Geometry

public enum ActivationGeometry {

    /// The screen that contains `point`, tolerating the inclusive max edges that
    /// `NSEvent.mouseLocation` can report (e.g. y == frame.maxY at the very top).
    public static func screen(containing point: CGPoint, in screens: [ScreenInfo]) -> ScreenInfo? {
        if let exact = screens.first(where: { $0.frame.contains(point) }) { return exact }
        return screens.first { s in
            point.x >= s.frame.minX && point.x <= s.frame.maxX &&
            point.y >= s.frame.minY && point.y <= s.frame.maxY
        }
    }

    /// True if moving outward from `point` across `edge` would land on another display,
    /// i.e. that part of the edge is a pass-through to a neighbour, not a physical edge.
    public static func edgeLeadsToAnotherScreen(_ edge: ScreenEdge, of screen: ScreenInfo, at point: CGPoint, screens: [ScreenInfo]) -> Bool {
        let f = screen.frame
        let probe: CGPoint
        switch edge {
        case .left: probe = CGPoint(x: f.minX - 1, y: point.y)
        case .right: probe = CGPoint(x: f.maxX + 1, y: point.y)
        case .top: probe = CGPoint(x: point.x, y: f.maxY + 1)
        case .bottom: probe = CGPoint(x: point.x, y: f.minY - 1)
        }
        return screens.contains { $0.id != screen.id && $0.frame.insetBy(dx: -0.5, dy: -0.5).contains(probe) }
    }

    /// Distance from `point` to `edge` of `frame` (0 when on the edge).
    public static func distance(from point: CGPoint, to edge: ScreenEdge, of frame: CGRect) -> CGFloat {
        switch edge {
        case .left: return point.x - frame.minX
        case .right: return frame.maxX - point.x
        case .top: return frame.maxY - point.y
        case .bottom: return point.y - frame.minY
        }
    }

    /// Returns the activation region under `point`, if any. Corners win over edges.
    public static func hit(at point: CGPoint, screens: [ScreenInfo], config: ActivationConfig) -> ActivationHit? {
        guard let screen = screen(containing: point, in: screens) else { return nil }
        if config.primaryDisplayOnly && !screen.isPrimary { return nil }
        let f = screen.frame

        if let corner = config.corner {
            let size = config.cornerSize
            let (h, v): (ScreenEdge, ScreenEdge)
            switch corner {
            case .topLeft: (h, v) = (.left, .top)
            case .topRight: (h, v) = (.right, .top)
            case .bottomLeft: (h, v) = (.left, .bottom)
            case .bottomRight: (h, v) = (.right, .bottom)
            }
            let dh = distance(from: point, to: h, of: f)
            let dv = distance(from: point, to: v, of: f)
            if dh <= size && dv <= size && dh >= -1 && dv >= -1,
               !edgeLeadsToAnotherScreen(h, of: screen, at: point, screens: screens),
               !edgeLeadsToAnotherScreen(v, of: screen, at: point, screens: screens) {
                return ActivationHit(screenID: screen.id, target: .corner(corner), point: point)
            }
        }

        // Pick the closest enabled edge within the band.
        var best: (ScreenEdge, CGFloat)?
        for edge in ScreenEdge.allCases where config.edges.contains(edge) {
            let d = distance(from: point, to: edge, of: f)
            guard d >= -1, d <= config.sensitivity else { continue }
            if edgeLeadsToAnotherScreen(edge, of: screen, at: point, screens: screens) { continue }
            if best == nil || d < best!.1 { best = (edge, d) }
        }
        if let (edge, _) = best {
            return ActivationHit(screenID: screen.id, target: .edge(edge), point: point)
        }
        return nil
    }
}

// MARK: - Dwell detector

/// Turns a stream of cursor positions into activation decisions.
///
/// It is purely reactive: the caller feeds it points (from mouse-dragged / mouse-moved
/// events) and, when it answers `.pending(deadline)`, schedules a single one-shot check
/// at that deadline (the cursor may rest motionless against the edge, producing no events).
public final class ActivationDetector {
    public enum Output: Equatable {
        case none
        case pending(deadline: TimeInterval)
        case activate(ActivationHit)
    }

    public var config: ActivationConfig
    public var screens: [ScreenInfo]

    private var candidate: ActivationHit?
    private var candidateSince: TimeInterval = 0
    private var firedForCurrentDwell = false
    public private(set) var lastPoint: CGPoint?

    public init(config: ActivationConfig, screens: [ScreenInfo]) {
        self.config = config
        self.screens = screens
    }

    public func reset() {
        candidate = nil
        firedForCurrentDwell = false
        lastPoint = nil
    }

    public func update(point: CGPoint, time: TimeInterval) -> Output {
        lastPoint = point
        guard let hit = ActivationGeometry.hit(at: point, screens: screens, config: config) else {
            candidate = nil
            firedForCurrentDwell = false
            return .none
        }
        if candidate == nil || candidate!.screenID != hit.screenID || candidate!.target != hit.target {
            candidate = hit
            candidateSince = time
            firedForCurrentDwell = false
        }
        if firedForCurrentDwell { return .none }
        if time - candidateSince >= config.delay {
            firedForCurrentDwell = true
            var h = hit
            h.point = point
            return .activate(h)
        }
        return .pending(deadline: candidateSince + config.delay)
    }

    /// Re-evaluates the last known point (used when a scheduled deadline fires).
    public func recheck(time: TimeInterval) -> Output {
        guard let p = lastPoint else { return .none }
        return update(point: p, time: time)
    }
}
