import XCTest
@testable import DragShelfCore

final class HideControllerTests: XCTestCase {
    func make() -> HideController { HideController(emptyHideDelay: 0.8, collapseDelay: 1.2) }

    func testHiddenShelfNeverSchedules() {
        var h = make()
        XCTAssertEqual(h.handle(.itemCount(3)), .stay)
    }

    func testEmptyShelfAutoHides() {
        var h = make()
        h.handle(.revealed(.drag))
        XCTAssertEqual(h.decision, .hideAfter(0.8))
    }

    func testDragHoverKeepsOpenThenDropCollapses() {
        var h = make()
        h.handle(.revealed(.drag))
        XCTAssertEqual(h.handle(.dragEntered), .stay)
        h.handle(.itemCount(1))
        XCTAssertEqual(h.handle(.dropPerformed), .hideAfter(1.2))
    }

    func testPointerInsideKeepsOpen() {
        var h = make()
        h.handle(.revealed(.hover))
        h.handle(.itemCount(2))
        XCTAssertEqual(h.handle(.pointerEntered), .stay)
        XCTAssertEqual(h.handle(.pointerExited), .hideAfter(1.2))
    }

    func testDragOutKeepsOpenUntilComplete() {
        var h = make()
        h.handle(.revealed(.hover))
        h.handle(.itemCount(1))
        h.handle(.pointerEntered)
        h.handle(.dragOutBegan)
        XCTAssertEqual(h.handle(.pointerExited), .stay)
        XCTAssertEqual(h.handle(.dragOutEnded), .hideAfter(1.2))
    }

    func testPinnedNeverHides() {
        var h = make()
        h.handle(.revealed(.drag))
        XCTAssertEqual(h.handle(.pinned(true)), .stay)
        XCTAssertEqual(h.handle(.pointerExited), .stay)
        XCTAssertEqual(h.handle(.pinned(false)), .hideAfter(0.8))
    }

    func testShortcutRevealWaitsForVisit() {
        var h = make()
        h.handle(.revealed(.shortcut))
        h.handle(.itemCount(4))
        XCTAssertEqual(h.decision, .stay)
        h.handle(.pointerEntered)
        XCTAssertEqual(h.handle(.pointerExited), .hideAfter(1.2))
    }

    func testShortcutRevealEndsOnFocusLoss() {
        var h = make()
        h.handle(.revealed(.shortcut))
        h.handle(.focusGained)
        XCTAssertEqual(h.handle(.focusLost), .hideAfter(0.8))
    }

    func testDragRevealDoesNotDowngradeShortcutReveal() {
        var h = make()
        h.handle(.revealed(.shortcut))
        h.handle(.revealed(.drag))
        XCTAssertEqual(h.reason, .shortcut)
        XCTAssertEqual(h.decision, .stay)
    }

    func testInteractionLocks() {
        var h = make()
        h.handle(.revealed(.drag))
        h.handle(.lock)
        h.handle(.lock)
        XCTAssertEqual(h.handle(.unlock), .stay)
        XCTAssertEqual(h.handle(.unlock), .hideAfter(0.8))
        XCTAssertEqual(h.handle(.unlock), .hideAfter(0.8)) // never negative
    }

    func testHiddenResetsTransientState() {
        var h = make()
        h.handle(.revealed(.drag))
        h.handle(.dragEntered)
        h.handle(.lock)
        h.handle(.hidden)
        XCTAssertFalse(h.isVisible)
        h.handle(.revealed(.drag))
        XCTAssertEqual(h.decision, .hideAfter(0.8))
    }

    func testItemsRetainedWhenHidden() {
        var h = make()
        h.handle(.itemCount(5))
        h.handle(.revealed(.drag))
        h.handle(.hidden)
        XCTAssertEqual(h.itemCount, 5)
    }
}
