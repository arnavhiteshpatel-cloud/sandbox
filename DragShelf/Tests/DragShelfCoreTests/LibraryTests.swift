import XCTest
@testable import DragShelfCore

final class LibraryTests: XCTestCase {
    func item(_ name: String) -> ShelfItem {
        ShelfItem(content: .file(FileReference(bookmark: nil, path: "/tmp/\(name)", identity: nil, isDirectory: false)),
                  kind: .file, displayName: name)
    }

    func names(_ s: Shelf) -> [String] { s.entries.map { $0.items.map(\.displayName).joined(separator: "+") } }

    func testNewLibraryHasOneEmptyShelf() {
        let lib = ShelfLibrary()
        XCTAssertEqual(lib.shelves.count, 1)
        XCTAssertTrue(lib.activeShelf.isEmpty)
        XCTAssertEqual(lib.displayName(of: lib.activeShelf), "Shelf")
    }

    func testMultiItemDropStacks() {
        var lib = ShelfLibrary()
        lib.add([item("a"), item("b"), item("c")], stack: true)
        XCTAssertEqual(lib.activeShelf.entries.count, 1)
        XCTAssertTrue(lib.activeShelf.entries[0].isStack)
        XCTAssertEqual(lib.totalItemCount, 3)
    }

    func testMultiItemDropWithoutStacking() {
        var lib = ShelfLibrary()
        lib.add([item("a"), item("b")], stack: false)
        XCTAssertEqual(names(lib.activeShelf), ["a", "b"])
    }

    func testInsertAtIndex() {
        var lib = ShelfLibrary()
        lib.add([item("a"), item("c")], stack: false)
        lib.add([item("b")], at: 1, stack: false)
        XCTAssertEqual(names(lib.activeShelf), ["a", "b", "c"])
    }

    func testReorder() {
        var lib = ShelfLibrary()
        lib.add(["a", "b", "c", "d"].map(item), stack: false)
        let ids = lib.activeShelf.entries.map(\.id)
        // Move "a" before "d"
        lib.moveEntries([ids[0]], toIndex: 3, in: lib.activeShelfID)
        XCTAssertEqual(names(lib.activeShelf), ["b", "c", "a", "d"])
        // Move "d" to the front
        lib.moveEntries([ids[3]], toIndex: 0, in: lib.activeShelfID)
        XCTAssertEqual(names(lib.activeShelf), ["d", "b", "c", "a"])
        // Move two to the end
        let ids2 = lib.activeShelf.entries.map(\.id)
        lib.moveEntries([ids2[0], ids2[1]], toIndex: 99, in: lib.activeShelfID)
        XCTAssertEqual(names(lib.activeShelf), ["c", "a", "d", "b"])
    }

    func testRemoveItemFromStackKeepsRest() {
        var lib = ShelfLibrary()
        lib.add(["a", "b", "c"].map(item), stack: true)
        let b = lib.activeShelf.entries[0].items[1].id
        lib.removeItems([b])
        XCTAssertEqual(names(lib.activeShelf), ["a+c"])
        let rest = Set(lib.activeShelf.entries[0].items.map(\.id))
        lib.removeItems(rest)
        XCTAssertTrue(lib.activeShelf.isEmpty)
    }

    func testUnstackAndStack() {
        var lib = ShelfLibrary()
        lib.add([item("x")], stack: false)
        lib.add(["a", "b"].map(item), stack: true)
        lib.add([item("y")], stack: false)
        lib.unstack(lib.activeShelf.entries[1].id)
        XCTAssertEqual(names(lib.activeShelf), ["x", "a", "b", "y"])
        let ids = lib.activeShelf.entries.map(\.id)
        lib.stack([ids[1], ids[3]])
        XCTAssertEqual(names(lib.activeShelf), ["x", "a+y", "b"])
    }

    func testMultipleShelvesMoveMergeDelete() {
        var lib = ShelfLibrary()
        let first = lib.activeShelfID
        lib.add(["a", "b"].map(item), stack: false)
        let second = lib.newShelf(name: "Images")
        XCTAssertEqual(lib.activeShelfID, second)
        lib.add([item("c")], stack: false)
        XCTAssertEqual(lib.displayName(of: lib.shelves[0]), "Shelf 1")
        XCTAssertEqual(lib.displayName(of: lib.shelves[1]), "Images")

        let aID = lib.shelves[0].entries[0].id
        lib.moveEntries([aID], toShelf: second)
        XCTAssertEqual(names(lib.shelves[0]), ["b"])
        XCTAssertEqual(names(lib.shelves[1]), ["c", "a"])

        lib.merge(second, into: first)
        XCTAssertEqual(lib.shelves.count, 1)
        XCTAssertEqual(lib.activeShelfID, first)
        XCTAssertEqual(names(lib.activeShelf), ["b", "c", "a"])

        // Deleting the last shelf only clears it.
        let removed = lib.deleteShelf(first)
        XCTAssertEqual(removed.count, 3)
        XCTAssertEqual(lib.shelves.count, 1)
    }

    func testMoveItemsOutOfStackToOtherShelf() {
        var lib = ShelfLibrary()
        lib.add(["a", "b", "c"].map(item), stack: true)
        let src = lib.activeShelfID
        let dst = lib.newShelf(activate: false)
        let bID = lib.shelves[0].entries[0].items[1].id
        lib.moveItems([bID], toShelf: dst)
        XCTAssertEqual(names(lib.shelves[0]), ["a+c"])
        XCTAssertEqual(names(lib.shelves[1]), ["b"])
        XCTAssertEqual(lib.activeShelfID, src)
    }

    func testRenameAndPrune() {
        var lib = ShelfLibrary()
        let a = lib.activeShelfID
        lib.rename(a, to: "  ")
        XCTAssertNil(lib.activeShelf.name)
        _ = lib.newShelf(activate: false)
        _ = lib.newShelf(name: "Keep", activate: false)
        lib.pruneEmptyUnnamedShelves()
        XCTAssertEqual(lib.shelves.count, 2)
        XCTAssertEqual(lib.shelves[1].name, "Keep")
    }

    func testNormalizeRepairsDanglingActiveShelf() {
        var lib = ShelfLibrary()
        lib.activeShelfID = UUID()
        lib.normalize()
        XCTAssertEqual(lib.activeShelfID, lib.shelves[0].id)
    }

    func testReferencedBlobs() {
        var lib = ShelfLibrary()
        let d1 = UUID().uuidString, d2 = UUID().uuidString
        lib.add([
            ShelfItem(content: .storedFile(StoredFile(relativePath: "\(d1)/a.png", originalName: "a.png")), kind: .image, displayName: "a"),
            ShelfItem(content: .data(DataItem(representations: [DataRepresentation(type: "public.utf8-plain-text", blob: "\(d2)/text", byteCount: 3)], text: "abc")), kind: .text, displayName: "abc"),
            item("ref"),
        ], stack: false)
        XCTAssertEqual(lib.referencedBlobDirectories, [d1, d2])
    }
}
