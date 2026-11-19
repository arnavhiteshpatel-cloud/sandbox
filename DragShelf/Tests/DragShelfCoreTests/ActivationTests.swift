import XCTest
@testable import DragShelfCore

final class ActivationTests: XCTestCase {
    // Primary 1440x900 at origin; a second 1920x1080 display to its right, offset upward.
    let primary = ScreenInfo(id: "A", frame: CGRect(x: 0, y: 0, width: 1440, height: 900), isPrimary: true)
    let secondary = ScreenInfo(id: "B", frame: CGRect(x: 1440, y: -90, width: 1920, height: 1080), isPrimary: false)

    func config(_ edges: Set<ScreenEdge> = [.right], corner: ScreenCorner? = nil, primaryOnly: Bool = false) -> ActivationConfig {
        ActivationConfig(edges: edges, corner: corner, sensitivity: 6, delay: 0.25, primaryDisplayOnly: primaryOnly)
    }

    func testRightEdgeHitOnSingleDisplay() {
        let hit = ActivationGeometry.hit(at: CGPoint(x: 1438, y: 400), screens: [primary], config: config())
        XCTAssertEqual(hit?.target, .edge(.right))
        XCTAssertEqual(hit?.screenID, "A")
    }

    func testNoHitAwayFromEdge() {
        XCTAssertNil(ActivationGeometry.hit(at: CGPoint(x: 1400, y: 400), screens: [primary], config: config()))
        XCTAssertNil(ActivationGeometry.hit(at: CGPoint(x: 720, y: 450), screens: [primary], config: config([.left, .right, .top, .bottom])))
    }

    func testDisabledEdgeDoesNotHit() {
        XCTAssertNil(ActivationGeometry.hit(at: CGPoint(x: 2, y: 400), screens: [primary], config: config([.right])))
        XCTAssertEqual(ActivationGeometry.hit(at: CGPoint(x: 2, y: 400), screens: [primary], config: config([.left]))?.target, .edge(.left))
    }

    func testTopEdgeInclusiveMaxY() {
        // NSEvent.mouseLocation reports y == maxY on the top row.
        let hit = ActivationGeometry.hit(at: CGPoint(x: 700, y: 900), screens: [primary], config: config([.top]))
        XCTAssertEqual(hit?.target, .edge(.top))
    }

    func testEdgeShaedWithNeighbourIsNotAnActivationEdge() {
        // The primary's right edge leads onto display B: not a physical edge.
        let hit = ActivationGeometry.hit(at: CGPoint(x: 1439, y: 400), screens: [primary, secondary], config: config())
        XCTAssertNil(hit)
        // ...but B's own right edge is.
        let hitB = ActivationGeometry.hit(at: CGPoint(x: 3358, y: 400), screens: [primary, secondary], config: config())
        XCTAssertEqual(hitB?.screenID, "B")
        XCTAssertEqual(hitB?.target, .edge(.right))
    }

    func testPartialNeighbourOverlap() {
        // B spans y -90...990. Above y=990 there is nothing to the right of... (A is only 900 tall)
        // Use a taller A to test the uncovered part of a shared edge.
        let tallA = ScreenInfo(id: "A", frame: CGRect(x: 0, y: 0, width: 1440, height: 1400), isPrimary: true)
        let hitCovered = ActivationGeometry.hit(at: CGPoint(x: 1439, y: 500), screens: [tallA, secondary], config: config())
        XCTAssertNil(hitCovered)
        let hitUncovered = ActivationGeometry.hit(at: CGPoint(x: 1439, y: 1200), screens: [tallA, secondary], config: config())
        XCTAssertEqual(hitUncovered?.target, .edge(.right))
    }

    func testPrimaryOnly() {
        let cfg = config([.right], primaryOnly: true)
        XCTAssertNil(ActivationGeometry.hit(at: CGPoint(x: 3358, y: 400), screens: [primary, secondary], config: cfg))
        XCTAssertEqual(ActivationGeometry.hit(at: CGPoint(x: 1438, y: 400), screens: [primary], config: cfg)?.screenID, "A")
    }

    func testCornerWinsOverEdge() {
        let cfg = config([.right, .top], corner: .topRight)
        let hit = ActivationGeometry.hit(at: CGPoint(x: 1435, y: 895), screens: [primary], config: cfg)
        XCTAssertEqual(hit?.target, .corner(.topRight))
        XCTAssertEqual(hit?.target.anchorEdge, .right)
    }

    func testCornerOnly() {
        let cfg = config([], corner: .bottomLeft)
        XCTAssertEqual(ActivationGeometry.hit(at: CGPoint(x: 3, y: 3), screens: [primary], config: cfg)?.target, .corner(.bottomLeft))
        XCTAssertNil(ActivationGeometry.hit(at: CGPoint(x: 3, y: 400), screens: [primary], config: cfg))
    }

    func testDwellRequiresDelay() {
        let d = ActivationDetector(config: config(), screens: [primary])
        XCTAssertEqual(d.update(point: CGPoint(x: 1000, y: 400), time: 0), .none)
        XCTAssertEqual(d.update(point: CGPoint(x: 1438, y: 400), time: 1.0), .pending(deadline: 1.25))
        XCTAssertEqual(d.update(point: CGPoint(x: 1439, y: 410), time: 1.1), .pending(deadline: 1.25))
        guard case .activate(let hit) = d.update(point: CGPoint(x: 1439, y: 420), time: 1.3) else { return XCTFail("expected activation") }
        XCTAssertEqual(hit.point, CGPoint(x: 1439, y: 420))
        // Fires once per dwell.
        XCTAssertEqual(d.update(point: CGPoint(x: 1439, y: 430), time: 1.5), .none)
    }

    func testPassingThroughEdgeDoesNotActivate() {
        let d = ActivationDetector(config: config(), screens: [primary])
        _ = d.update(point: CGPoint(x: 1438, y: 400), time: 0)
        XCTAssertEqual(d.update(point: CGPoint(x: 1300, y: 400), time: 0.1), .none)
        // Coming back restarts the dwell clock.
        XCTAssertEqual(d.update(point: CGPoint(x: 1438, y: 400), time: 0.2), .pending(deadline: 0.45))
    }

    func testRecheckAtDeadlineActivatesWhenCursorRests() {
        let d = ActivationDetector(config: config(), screens: [primary])
        _ = d.update(point: CGPoint(x: 1438, y: 400), time: 0)
        if case .activate = d.recheck(time: 0.3) {} else { XCTFail("expected activation on recheck") }
    }

    func testLeavingAndReenteringFiresAgain() {
        let d = ActivationDetector(config: config(), screens: [primary])
        _ = d.update(point: CGPoint(x: 1438, y: 400), time: 0)
        _ = d.update(point: CGPoint(x: 1438, y: 400), time: 0.3)
        _ = d.update(point: CGPoint(x: 1000, y: 400), time: 0.4)
        _ = d.update(point: CGPoint(x: 1438, y: 400), time: 0.5)
        if case .activate = d.update(point: CGPoint(x: 1438, y: 400), time: 0.8) {} else { XCTFail() }
    }

    func testZeroDelayActivatesImmediately() {
        var cfg = config()
        cfg.delay = 0
        let d = ActivationDetector(config: cfg, screens: [primary])
        if case .activate = d.update(point: CGPoint(x: 1439, y: 10), time: 5) {} else { XCTFail() }
    }

    func testPointOutsideAllScreens() {
        XCTAssertNil(ActivationGeometry.hit(at: CGPoint(x: -500, y: -500), screens: [primary], config: config([.left, .bottom])))
    }
}
