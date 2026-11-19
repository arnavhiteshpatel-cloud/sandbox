import Foundation

/// Why the shelf became visible. Different reveal paths have different hiding rules.
public enum RevealReason: Equatable {
    /// An ongoing drag reached the activation edge/corner.
    case drag
    /// The cursor rested in the activation region (no drag) while the shelf holds items.
    case hover
    /// The global keyboard shortcut or the menu.
    case shortcut
}

public enum HideDecision: Equatable {
    /// Do nothing / cancel any pending hide.
    case stay
    /// Hide after the given delay unless another event arrives first.
    case hideAfter(TimeInterval)
}

/// Pure decision logic for the shelf's automatic hiding.
///
/// Rules (see docs/DESIGN.md):
///  • pinned → never auto-hide
///  • while a drag hovers the shelf, while items are being dragged out of it, while the
///    pointer is over it, or while a modal interaction (menu, editor, Quick Look) is open → stay
///  • empty shelf → hide after `emptyHideDelay`
///  • populated shelf → hide after `collapseDelay` (contents are retained)
///  • shortcut reveal → stays until the pointer has visited and left, or focus is lost
public struct HideController: Equatable {
    public var emptyHideDelay: TimeInterval
    public var collapseDelay: TimeInterval

    public private(set) var isVisible = false
    public private(set) var reason: RevealReason = .drag
    public private(set) var isPinned = false
    public private(set) var itemCount = 0
    public private(set) var dragInside = false
    public private(set) var dragOutInProgress = false
    public private(set) var pointerInside = false
    public private(set) var pointerHasVisited = false
    public private(set) var interactionLocks = 0
    public private(set) var hasFocus = false

    public init(emptyHideDelay: TimeInterval, collapseDelay: TimeInterval) {
        self.emptyHideDelay = emptyHideDelay
        self.collapseDelay = collapseDelay
    }

    public enum Event: Equatable {
        case revealed(RevealReason)
        case hidden
        case pointerEntered
        case pointerExited
        case dragEntered
        case dragExited
        case dropPerformed
        case dragOutBegan
        case dragOutEnded
        case pinned(Bool)
        case itemCount(Int)
        case lock
        case unlock
        case focusGained
        case focusLost
    }

    @discardableResult
    public mutating func handle(_ event: Event) -> HideDecision {
        switch event {
        case .revealed(let r):
            if isVisible {
                // A drag/hover reveal must not downgrade an explicit shortcut reveal.
                if !(reason == .shortcut && r != .shortcut) { reason = r }
            } else {
                pointerHasVisited = false
                pointerInside = false
                dragInside = false
                reason = r
            }
            isVisible = true
        case .hidden:
            isVisible = false
            dragInside = false
            pointerInside = false
            pointerHasVisited = false
            hasFocus = false
            interactionLocks = 0
        case .pointerEntered:
            pointerInside = true
            pointerHasVisited = true
        case .pointerExited:
            pointerInside = false
        case .dragEntered:
            dragInside = true
            pointerHasVisited = true
        case .dragExited:
            dragInside = false
        case .dropPerformed:
            dragInside = false
        case .dragOutBegan:
            dragOutInProgress = true
        case .dragOutEnded:
            dragOutInProgress = false
        case .pinned(let p):
            isPinned = p
        case .itemCount(let n):
            itemCount = max(0, n)
        case .lock:
            interactionLocks += 1
        case .unlock:
            interactionLocks = max(0, interactionLocks - 1)
        case .focusGained:
            hasFocus = true
        case .focusLost:
            hasFocus = false
            // Clicking elsewhere ends a shortcut reveal's grace period.
            if reason == .shortcut { pointerHasVisited = true }
        }
        return decision
    }

    /// The current decision without changing state.
    public var decision: HideDecision {
        guard isVisible else { return .stay }
        if isPinned || dragInside || dragOutInProgress || pointerInside || interactionLocks > 0 {
            return .stay
        }
        if reason == .shortcut && !pointerHasVisited {
            return .stay
        }
        return .hideAfter(itemCount == 0 ? emptyHideDelay : collapseDelay)
    }
}
