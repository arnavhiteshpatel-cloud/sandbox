import XCTest
@testable import DragShelfCore

final class SettingsTests: XCTestCase {
    func testDefaultsNeedNoConfiguration() {
        let s = DragShelfSettings()
        XCTAssertEqual(s.edges, [.right])
        XCTAssertEqual(s.toggleShortcut?.displayString, "⌃⌥Space")
        XCTAssertEqual(s.clipboardShortcut?.displayString, "⌃⌥V")
        XCTAssertFalse(s.clipboardHistoryEnabled, "clipboard history must be opt-in")
        XCTAssertFalse(s.allowMovingOriginals, "originals must be copied, not moved, by default")
        XCTAssertFalse(s.loadWebsiteIcons, "no network requests by default")
        XCTAssertEqual(s.retention, .untilRemoved)
    }

    func testRoundTrip() throws {
        var s = DragShelfSettings()
        s.edges = [.left, .bottom]
        s.corner = .topRight
        s.toggleShortcut = nil
        s.shelfSize = .large
        let data = try JSONEncoder().encode(s)
        let back = try JSONDecoder().decode(DragShelfSettings.self, from: data)
        XCTAssertEqual(back, s)
        XCTAssertNil(back.toggleShortcut, "a cleared shortcut stays cleared")
    }

    func testMissingKeysFallBackToDefaults() throws {
        let json = #"{"edges":["left"],"shelfSize":"small","someFutureKey":true,"retention":"bogus"}"#
        let s = try JSONDecoder().decode(DragShelfSettings.self, from: Data(json.utf8))
        XCTAssertEqual(s.edges, [.left])
        XCTAssertEqual(s.shelfSize, .small)
        XCTAssertEqual(s.retention, .untilRemoved)
        XCTAssertEqual(s.toggleShortcut, .defaultToggle)
    }

    func testClamping() {
        var s = DragShelfSettings()
        s.edgeSensitivity = 1000
        s.activationDelay = -1
        s.edges = []
        let c = s.clamped()
        XCTAssertEqual(c.edgeSensitivity, 60)
        XCTAssertEqual(c.activationDelay, 0)
        XCTAssertEqual(c.edges, [.right])
    }

    func testShortcutValidity() {
        XCTAssertTrue(KeyCombo.defaultToggle.isValidGlobalShortcut)
        XCTAssertFalse(KeyCombo(keyCode: 0, modifiers: KeyCombo.carbonShift, keyName: "A").isValidGlobalShortcut)
        XCTAssertFalse(KeyCombo(keyCode: 0, modifiers: 0, keyName: "A").isValidGlobalShortcut)
    }

    func testHoverConfigIsSlowerThanDragConfig() {
        let s = DragShelfSettings()
        XCTAssertGreaterThan(s.hoverActivationConfig.delay, s.activationConfig.delay)
        XCTAssertTrue(DragShelfSettings().activationConfig.primaryDisplayOnly == false)
    }
}

final class RetentionTests: XCTestCase {
    func lib(addedAt dates: [Date]) -> ShelfLibrary {
        var l = ShelfLibrary()
        l.add(dates.map { ShelfItem(content: .data(DataItem(representations: [], text: "t")), kind: .text, displayName: "t", addedAt: $0) }, stack: false)
        return l
    }

    func testIntervalExpiry() {
        let now = Date(timeIntervalSince1970: 100_000)
        let l = lib(addedAt: [now.addingTimeInterval(-7200), now.addingTimeInterval(-60)])
        let expired = Retention.expiredItemIDs(in: l, policy: .afterInterval, hours: 1, now: now)
        XCTAssertEqual(expired, [l.allItems[0].id])
        XCTAssertEqual(Retention.nextExpiry(in: l, policy: .afterInterval, hours: 1), now.addingTimeInterval(-7200 + 3600))
    }

    func testOtherPoliciesNeverExpire() {
        let l = lib(addedAt: [Date.distantPast])
        XCTAssertTrue(Retention.expiredItemIDs(in: l, policy: .untilRemoved, hours: 1, now: Date()).isEmpty)
        XCTAssertNil(Retention.nextExpiry(in: l, policy: .clearOnQuit, hours: 1))
    }

    func testRestorePolicy() {
        XCTAssertTrue(Retention.shouldRestore(policy: .untilRemoved))
        XCTAssertTrue(Retention.shouldRestore(policy: .afterInterval))
        XCTAssertFalse(Retention.shouldRestore(policy: .clearOnQuit))
    }
}

final class LayoutTests: XCTestCase {
    let vf = CGRect(x: 0, y: 0, width: 1440, height: 875)

    func testEmptyShelfIsCompact() {
        let l = ShelfLayout.compute(count: 0, orientation: .vertical, tile: 76, maxLength: 600)
        XCTAssertEqual(l.columns, 0)
        XCTAssertLessThan(l.contentSize.height, 200)
        XCTAssertLessThan(l.contentSize.width, 200)
    }

    func testVerticalGrowsThenScrolls() {
        let one = ShelfLayout.compute(count: 1, orientation: .vertical, tile: 76, maxLength: 600)
        let three = ShelfLayout.compute(count: 3, orientation: .vertical, tile: 76, maxLength: 600)
        let four = ShelfLayout.compute(count: 4, orientation: .vertical, tile: 76, maxLength: 600)
        XCTAssertEqual(one.columns, 1)
        XCTAssertGreaterThan(three.contentSize.height, one.contentSize.height)
        XCTAssertEqual(four.columns, 2)
        let many = ShelfLayout.compute(count: 40, orientation: .vertical, tile: 76, maxLength: 600)
        XCTAssertTrue(many.scrolls)
        XCTAssertEqual(many.contentSize.height, 600)
    }

    func testHorizontalStrip() {
        let l = ShelfLayout.compute(count: 5, orientation: .horizontal, tile: 76, maxLength: 1200)
        XCTAssertEqual(l.rows, 1)
        XCTAssertEqual(l.columns, 5)
        XCTAssertGreaterThan(l.contentSize.width, l.contentSize.height)
        let wide = ShelfLayout.compute(count: 60, orientation: .horizontal, tile: 76, maxLength: 1200)
        XCTAssertEqual(wide.rows, 2)
        XCTAssertTrue(wide.scrolls)
    }

    func testPanelStaysInsideVisibleFrame() {
        let size = CGSize(width: 180, height: 300)
        for edge in ScreenEdge.allCases {
            for anchor in [CGPoint(x: 0, y: 0), CGPoint(x: 1440, y: 900), CGPoint(x: 720, y: 450)] {
                let f = ShelfLayout.panelFrame(size: size, edge: edge, anchor: anchor, visibleFrame: vf)
                XCTAssertTrue(vf.contains(f), "\(edge) \(anchor) -> \(f)")
            }
        }
        let right = ShelfLayout.panelFrame(size: size, edge: .right, anchor: CGPoint(x: 1439, y: 450), visibleFrame: vf)
        XCTAssertEqual(right.maxX, vf.maxX - 10)
        XCTAssertEqual(right.midY, 450)
    }

    func testHiddenFrameSlidesTowardEdge() {
        let f = CGRect(x: 100, y: 100, width: 10, height: 10)
        XCTAssertGreaterThan(ShelfLayout.hiddenFrame(for: f, edge: .right).minX, f.minX)
        XCTAssertLessThan(ShelfLayout.hiddenFrame(for: f, edge: .bottom).minY, f.minY)
    }
}

final class TextAnalysisTests: XCTestCase {
    func testLinks() {
        XCTAssertEqual(TextAnalysis.link(in: "https://example.com/a?b=c")?.absoluteString, "https://example.com/a?b=c")
        XCTAssertEqual(TextAnalysis.link(in: "  example.com/path \n")?.absoluteString, "https://example.com/path")
        XCTAssertEqual(TextAnalysis.link(in: "mailto:a@b.co")?.scheme, "mailto")
        XCTAssertNil(TextAnalysis.link(in: "file:///etc/passwd"))
        XCTAssertNil(TextAnalysis.link(in: "javascript:alert(1)"))
        XCTAssertNil(TextAnalysis.link(in: "hello world"))
        XCTAssertNil(TextAnalysis.link(in: "version 1.2"))
        XCTAssertNil(TextAnalysis.link(in: "1.5"))
        XCTAssertNil(TextAnalysis.link(in: "https://"))
    }

    func testSnippetAndTitle() {
        XCTAssertEqual(TextAnalysis.snippet("a\n\n b \nc"), "a b c")
        XCTAssertEqual(TextAnalysis.snippet(String(repeating: "x", count: 300), maxCharacters: 10).count, 10)
        XCTAssertEqual(TextAnalysis.title(forText: "   "), "Text")
        XCTAssertEqual(TextAnalysis.displayHost(URL(string: "https://www.apple.com/mac")!), "apple.com")
    }
}
