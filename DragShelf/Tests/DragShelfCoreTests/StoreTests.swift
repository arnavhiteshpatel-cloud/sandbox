import XCTest
@testable import DragShelfCore

final class StoreTests: XCTestCase {
    var tmp: URL!

    override func setUpWithError() throws {
        tmp = FileManager.default.temporaryDirectory.appendingPathComponent("dragshelf-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    func testSaveLoadRoundTrip() throws {
        let store = try ShelfStore(rootURL: tmp.appendingPathComponent("store"))
        var lib = ShelfLibrary()
        let blob = try store.writeBlob(Data("hello".utf8), fileName: "note.txt")
        lib.add([
            ShelfItem(content: .file(FileReference(bookmark: Data([1, 2, 3]), path: "/Users/x/a.pdf",
                                                   identity: FileIdentity(inode: 42, creationDate: Date(timeIntervalSince1970: 1000)), isDirectory: false)),
                      kind: .pdf, displayName: "a.pdf", typeIdentifier: "com.adobe.pdf"),
            ShelfItem(content: .data(DataItem(representations: [DataRepresentation(type: "public.utf8-plain-text", blob: blob, byteCount: 5)], text: "hello")),
                      kind: .text, displayName: "hello", storedBytes: 5),
        ], stack: true)
        lib.newShelf(name: "Second", activate: false)
        try store.save(lib)

        guard case .loaded(let loaded) = store.load() else { return XCTFail("not loaded") }
        XCTAssertEqual(loaded, lib)
    }

    func testMissingStateLoadsNone() throws {
        let store = try ShelfStore(rootURL: tmp.appendingPathComponent("s"))
        XCTAssertEqual(store.load(), .none)
    }

    func testCorruptStateIsMovedAsideNotDeleted() throws {
        let store = try ShelfStore(rootURL: tmp.appendingPathComponent("s"))
        try Data("{not json".utf8).write(to: store.stateURL)
        guard case .corrupt(let aside) = store.load(), let url = aside else { return XCTFail() }
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.stateURL.path))
    }

    func testBlobURLRejectsEscapes() throws {
        let store = try ShelfStore(rootURL: tmp.appendingPathComponent("s"))
        let id = UUID().uuidString
        XCTAssertNotNil(store.blobURL("\(id)/file.png"))
        XCTAssertNil(store.blobURL("../state.json"))
        XCTAssertNil(store.blobURL("\(id)/../../state.json"))
        XCTAssertNil(store.blobURL("/etc/passwd"))
        XCTAssertNil(store.blobURL("notauuid/file"))
        XCTAssertNil(store.blobURL(""))
    }

    func testGarbageCollectionOnlyTouchesOwnedUnreferencedBlobs() throws {
        let fm = FileManager.default
        let store = try ShelfStore(rootURL: tmp.appendingPathComponent("s"))

        // A user's original file outside storage, and a symlink to it inside blobs/.
        let original = tmp.appendingPathComponent("Original.txt")
        try Data("precious".utf8).write(to: original)
        let linkName = UUID().uuidString
        try fm.createSymbolicLink(at: store.blobsURL.appendingPathComponent(linkName), withDestinationURL: original)

        // A non-UUID file inside blobs/ must be left alone.
        let stray = store.blobsURL.appendingPathComponent("README")
        try Data("x".utf8).write(to: stray)

        let kept = try store.writeBlob(Data("keep".utf8), fileName: "keep.txt")
        let dropped = try store.writeBlob(Data("drop".utf8), fileName: "drop.txt")
        let keptDir = String(kept.split(separator: "/")[0])
        let droppedDir = String(dropped.split(separator: "/")[0])

        let removed = Set(store.collectGarbage(keeping: [keptDir]))
        XCTAssertEqual(removed, [droppedDir, linkName])

        XCTAssertTrue(fm.fileExists(atPath: original.path), "symlink target must survive")
        XCTAssertEqual(try String(contentsOf: original, encoding: .utf8), "precious")
        XCTAssertTrue(fm.fileExists(atPath: stray.path))
        XCTAssertNotNil(store.blobURL(kept).map { fm.fileExists(atPath: $0.path) })
        XCTAssertTrue(fm.fileExists(atPath: store.blobURL(kept)!.path))
    }

    func testDeleteBlobDirectoryRefusesNonUUID() throws {
        let store = try ShelfStore(rootURL: tmp.appendingPathComponent("s"))
        XCTAssertFalse(store.deleteBlobDirectory(".."))
        XCTAssertFalse(store.deleteBlobDirectory("../blobs"))
        XCTAssertFalse(store.deleteBlobDirectory("state.json"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.blobsURL.path))
    }

    func testStorageUsage() throws {
        let store = try ShelfStore(rootURL: tmp.appendingPathComponent("s"))
        _ = try store.writeBlob(Data(count: 1000), fileName: "a.bin")
        _ = try store.writeBlob(Data(count: 2500), fileName: "b.bin")
        XCTAssertEqual(store.storageUsage(), 3500)
    }

    func testFileNameSanitizing() {
        XCTAssertEqual(FileNames.sanitize("a/b:c.txt"), "a-b-c.txt")
        XCTAssertEqual(FileNames.sanitize("../../etc"), "-..-etc")
        XCTAssertEqual(FileNames.sanitize("...hidden"), "hidden")
        XCTAssertEqual(FileNames.sanitize("   "), "Item")
        XCTAssertEqual(FileNames.sanitize("line\nbreak"), "linebreak")
        let long = String(repeating: "x", count: 400) + ".png"
        let s = FileNames.sanitize(long)
        XCTAssertLessThanOrEqual(s.utf8.count, 200)
        XCTAssertTrue(s.hasSuffix(".png"))
    }

    func testKindForExtension() {
        XCTAssertEqual(FileNames.kind(forExtension: "PNG"), .image)
        XCTAssertEqual(FileNames.kind(forExtension: "pdf"), .pdf)
        XCTAssertEqual(FileNames.kind(forExtension: "", isDirectory: true), .folder)
        XCTAssertEqual(FileNames.kind(forExtension: "app", isDirectory: true), .application)
        XCTAssertEqual(FileNames.kind(forExtension: "xyz"), .file)
    }
}
