import Foundation

/// A keyboard shortcut. `keyCode` is a virtual key code, `modifiers` a Carbon modifier mask
/// (cmdKey = 0x100, shiftKey = 0x200, optionKey = 0x800, controlKey = 0x1000).
public struct KeyCombo: Codable, Equatable, Hashable {
    public var keyCode: UInt32
    public var modifiers: UInt32
    /// Human-readable key name captured when recording (e.g. "Space", "D").
    public var keyName: String

    public init(keyCode: UInt32, modifiers: UInt32, keyName: String) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.keyName = keyName
    }

    public static let carbonCmd: UInt32 = 0x100
    public static let carbonShift: UInt32 = 0x200
    public static let carbonOption: UInt32 = 0x800
    public static let carbonControl: UInt32 = 0x1000

    /// e.g. "⌃⌥Space"
    public var displayString: String {
        var s = ""
        if modifiers & Self.carbonControl != 0 { s += "⌃" }
        if modifiers & Self.carbonOption != 0 { s += "⌥" }
        if modifiers & Self.carbonShift != 0 { s += "⇧" }
        if modifiers & Self.carbonCmd != 0 { s += "⌘" }
        return s + keyName
    }

    /// Global shortcuts need at least one of ⌘ ⌥ ⌃ so they don't swallow ordinary typing.
    public var isValidGlobalShortcut: Bool {
        modifiers & (Self.carbonCmd | Self.carbonOption | Self.carbonControl) != 0
    }

    /// ⌃⌥Space — rarely used by apps, easy to press.
    public static let defaultToggle = KeyCombo(keyCode: 49, modifiers: carbonControl | carbonOption, keyName: "Space")
    /// ⌃⌥V — add the current clipboard to the shelf.
    public static let defaultClipboard = KeyCombo(keyCode: 9, modifiers: carbonControl | carbonOption, keyName: "V")
}

public enum ShelfSize: String, Codable, CaseIterable {
    case small, medium, large
    public var title: String { rawValue.capitalized }
    public var tileSide: Double {
        switch self { case .small: return 60; case .medium: return 76; case .large: return 96 }
    }
}

public enum AnimationStyle: String, Codable, CaseIterable {
    case full, reduced, off
    public var title: String {
        switch self { case .full: return "Full"; case .reduced: return "Reduced"; case .off: return "Off" }
    }
}

public enum AppearanceMode: String, Codable, CaseIterable {
    case system, light, dark
    public var title: String { rawValue.capitalized }
}

public enum DisplayMode: String, Codable, CaseIterable {
    /// Every display has its own activation region; the shelf appears where it was triggered.
    case allDisplays
    /// Only the primary display has an activation region and shows the shelf.
    case primaryOnly
    public var title: String {
        switch self { case .allDisplays: return "Every display"; case .primaryOnly: return "Primary display only" }
    }
}

public enum RetentionPolicy: String, Codable, CaseIterable {
    /// Keep items (across relaunches) until removed.
    case untilRemoved
    /// Clear everything when DragShelf quits.
    case clearOnQuit
    /// Remove items a fixed time after they were added.
    case afterInterval
    public var title: String {
        switch self {
        case .untilRemoved: return "Until I remove them"
        case .clearOnQuit: return "Until DragShelf quits"
        case .afterInterval: return "For a limited time"
        }
    }
}

public struct DragShelfSettings: Codable, Equatable {
    // Activation
    public var edges: Set<ScreenEdge> = [.right]
    public var corner: ScreenCorner? = nil
    public var edgeSensitivity: Double = 6          // points
    public var activationDelay: Double = 0.25       // seconds of dwell during a drag
    public var revealOnHover: Bool = true           // populated shelf: rest at edge without dragging
    public var hoverDelay: Double = 0.6
    public var displayMode: DisplayMode = .allDisplays

    // Hiding
    public var emptyHideDelay: Double = 0.8
    public var collapseDelay: Double = 1.2

    // Look
    public var shelfSize: ShelfSize = .medium
    public var animationStyle: AnimationStyle = .full
    public var appearance: AppearanceMode = .system

    // Shortcuts
    public var toggleShortcut: KeyCombo? = .defaultToggle
    public var clipboardShortcut: KeyCombo? = .defaultClipboard

    // App
    public var showMenuBarIcon: Bool = true
    public var stackMultiItemDrops: Bool = true
    public var allowMovingOriginals: Bool = false
    public var removeAfterDragOut: Bool = false
    public var loadWebsiteIcons: Bool = false

    // Clipboard
    public var clipboardShortcutEnabled: Bool = true
    public var clipboardHistoryEnabled: Bool = false

    // Storage
    public var retention: RetentionPolicy = .untilRemoved
    public var retentionHours: Double = 24
    public var storageLimitMB: Double = 2048

    public init() {}

    public var activationConfig: ActivationConfig {
        ActivationConfig(edges: edges, corner: corner, sensitivity: CGFloat(edgeSensitivity),
                         delay: activationDelay, primaryDisplayOnly: displayMode == .primaryOnly)
    }

    public var hoverActivationConfig: ActivationConfig {
        var c = activationConfig
        c.delay = activationDelay + hoverDelay
        return c
    }

    /// Settings are clamped to sane ranges so a hand-edited or corrupt value can't break the app.
    public func clamped() -> DragShelfSettings {
        var s = self
        s.edgeSensitivity = min(max(s.edgeSensitivity, 1), 60)
        s.activationDelay = min(max(s.activationDelay, 0), 3)
        s.hoverDelay = min(max(s.hoverDelay, 0), 5)
        s.emptyHideDelay = min(max(s.emptyHideDelay, 0.2), 30)
        s.collapseDelay = min(max(s.collapseDelay, 0.2), 60)
        s.retentionHours = min(max(s.retentionHours, 0.25), 24 * 90)
        s.storageLimitMB = min(max(s.storageLimitMB, 50), 512 * 1024)
        if s.edges.isEmpty && s.corner == nil { s.edges = [.right] }
        return s
    }

    // Tolerant decoding: unknown/missing keys fall back to defaults, so adding settings in a
    // later version never resets the user's other choices.
    enum CodingKeys: String, CodingKey {
        case edges, corner, edgeSensitivity, activationDelay, revealOnHover, hoverDelay, displayMode
        case emptyHideDelay, collapseDelay, shelfSize, animationStyle, appearance
        case toggleShortcut, clipboardShortcut, showMenuBarIcon, stackMultiItemDrops
        case allowMovingOriginals, removeAfterDragOut, loadWebsiteIcons
        case clipboardShortcutEnabled, clipboardHistoryEnabled, retention, retentionHours, storageLimitMB
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = DragShelfSettings()
        func v<T: Decodable>(_ k: CodingKeys, _ def: T) -> T { ((try? c.decodeIfPresent(T.self, forKey: k)) ?? nil) ?? def }
        edges = v(.edges, d.edges)
        corner = (try? c.decodeIfPresent(ScreenCorner.self, forKey: .corner)) ?? nil
        edgeSensitivity = v(.edgeSensitivity, d.edgeSensitivity)
        activationDelay = v(.activationDelay, d.activationDelay)
        revealOnHover = v(.revealOnHover, d.revealOnHover)
        hoverDelay = v(.hoverDelay, d.hoverDelay)
        displayMode = v(.displayMode, d.displayMode)
        emptyHideDelay = v(.emptyHideDelay, d.emptyHideDelay)
        collapseDelay = v(.collapseDelay, d.collapseDelay)
        shelfSize = v(.shelfSize, d.shelfSize)
        animationStyle = v(.animationStyle, d.animationStyle)
        appearance = v(.appearance, d.appearance)
        // A shortcut explicitly cleared by the user is stored as null and must stay cleared.
        toggleShortcut = c.contains(.toggleShortcut) ? ((try? c.decodeIfPresent(KeyCombo.self, forKey: .toggleShortcut)) ?? nil) : d.toggleShortcut
        clipboardShortcut = c.contains(.clipboardShortcut) ? ((try? c.decodeIfPresent(KeyCombo.self, forKey: .clipboardShortcut)) ?? nil) : d.clipboardShortcut
        showMenuBarIcon = v(.showMenuBarIcon, d.showMenuBarIcon)
        stackMultiItemDrops = v(.stackMultiItemDrops, d.stackMultiItemDrops)
        allowMovingOriginals = v(.allowMovingOriginals, d.allowMovingOriginals)
        removeAfterDragOut = v(.removeAfterDragOut, d.removeAfterDragOut)
        loadWebsiteIcons = v(.loadWebsiteIcons, d.loadWebsiteIcons)
        clipboardShortcutEnabled = v(.clipboardShortcutEnabled, d.clipboardShortcutEnabled)
        clipboardHistoryEnabled = v(.clipboardHistoryEnabled, d.clipboardHistoryEnabled)
        retention = v(.retention, d.retention)
        retentionHours = v(.retentionHours, d.retentionHours)
        storageLimitMB = v(.storageLimitMB, d.storageLimitMB)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(edges, forKey: .edges)
        try c.encode(corner, forKey: .corner)
        try c.encode(edgeSensitivity, forKey: .edgeSensitivity)
        try c.encode(activationDelay, forKey: .activationDelay)
        try c.encode(revealOnHover, forKey: .revealOnHover)
        try c.encode(hoverDelay, forKey: .hoverDelay)
        try c.encode(displayMode, forKey: .displayMode)
        try c.encode(emptyHideDelay, forKey: .emptyHideDelay)
        try c.encode(collapseDelay, forKey: .collapseDelay)
        try c.encode(shelfSize, forKey: .shelfSize)
        try c.encode(animationStyle, forKey: .animationStyle)
        try c.encode(appearance, forKey: .appearance)
        try c.encode(toggleShortcut, forKey: .toggleShortcut)
        try c.encode(clipboardShortcut, forKey: .clipboardShortcut)
        try c.encode(showMenuBarIcon, forKey: .showMenuBarIcon)
        try c.encode(stackMultiItemDrops, forKey: .stackMultiItemDrops)
        try c.encode(allowMovingOriginals, forKey: .allowMovingOriginals)
        try c.encode(removeAfterDragOut, forKey: .removeAfterDragOut)
        try c.encode(loadWebsiteIcons, forKey: .loadWebsiteIcons)
        try c.encode(clipboardShortcutEnabled, forKey: .clipboardShortcutEnabled)
        try c.encode(clipboardHistoryEnabled, forKey: .clipboardHistoryEnabled)
        try c.encode(retention, forKey: .retention)
        try c.encode(retentionHours, forKey: .retentionHours)
        try c.encode(storageLimitMB, forKey: .storageLimitMB)
    }
}

// MARK: - Retention

public enum Retention {
    /// Items that have outlived the configured interval.
    public static func expiredItemIDs(in library: ShelfLibrary, policy: RetentionPolicy, hours: Double, now: Date) -> Set<UUID> {
        guard policy == .afterInterval else { return [] }
        let limit = hours * 3600
        return Set(library.allItems.filter { now.timeIntervalSince($0.addedAt) >= limit }.map { $0.id })
    }

    /// When the next item will expire (nil if nothing will). Used to arm a single one-shot timer.
    public static func nextExpiry(in library: ShelfLibrary, policy: RetentionPolicy, hours: Double) -> Date? {
        guard policy == .afterInterval else { return nil }
        return library.allItems.map { $0.addedAt.addingTimeInterval(hours * 3600) }.min()
    }

    /// Whether a saved session should be restored at launch.
    /// (`clearOnQuit` normally leaves nothing behind; after a crash it must not resurrect items.)
    public static func shouldRestore(policy: RetentionPolicy) -> Bool {
        policy != .clearOnQuit
    }
}
