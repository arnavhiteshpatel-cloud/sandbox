import AppKit
import UniformTypeIdentifiers
import DragShelfCore

/// Non-interactive checks against real AppKit, run with:
///
///     DragShelf.app/Contents/MacOS/DragShelf --selftest [--out results.json]
///     DragShelf.app/Contents/MacOS/DragShelf --measure-idle 30
///
/// The self-test drives the same code paths a drop and a drag-out use (pasteboard → items →
/// pasteboard writers) through private named pasteboards, so it never touches your clipboard.
/// It cannot replace an interactive drag between apps; see docs/TESTING.md for that checklist.
enum SelfTest {
    struct Check: Codable {
        var name: String
        var ok: Bool
        var detail: String
    }

    static func run(arguments: [String]) -> Int32 {
        if let i = arguments.firstIndex(of: "--measure-idle") {
            let seconds = (i + 1 < arguments.count ? Double(arguments[i + 1]) : nil) ?? 30
            return measureIdle(seconds: seconds)
        }

        _ = NSApplication.shared // connect to the window server (screens, pasteboards)
        var checks: [Check] = []
        func check(_ name: String, _ ok: Bool, _ detail: String = "") {
            checks.append(Check(name: name, ok: ok, detail: detail))
            print("\(ok ? "PASS" : "FAIL")  \(name)\(detail.isEmpty ? "" : " — \(detail)")")
        }

        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("DragShelf-SelfTest-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: root) }

        do {
            let originals = root.appendingPathComponent("Originals", isDirectory: true)
            try fm.createDirectory(at: originals, withIntermediateDirectories: true)

            // Fixtures: a text file, a PNG, a PDF, a folder and an executable script.
            let textURL = originals.appendingPathComponent("Notes.txt")
            try Data("original contents\n".utf8).write(to: textURL)
            let pngData = makePNG()
            let pngURL = originals.appendingPathComponent("Picture.png")
            try pngData.write(to: pngURL)
            let pdfURL = originals.appendingPathComponent("Doc.pdf")
            try makePDF().write(to: pdfURL)
            let folderURL = originals.appendingPathComponent("Folder", isDirectory: true)
            try fm.createDirectory(at: folderURL, withIntermediateDirectories: true)
            try Data("inside".utf8).write(to: folderURL.appendingPathComponent("inner.txt"))
            let scriptURL = originals.appendingPathComponent("run.command")
            try Data("#!/bin/sh\necho hi\n".utf8).write(to: scriptURL)
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scriptURL.path)

            let snapshot = try snapshotFiles(originals)

            let store = try ShelfStore(rootURL: root.appendingPathComponent("Store", isDirectory: true))
            let ingestor = PasteboardIngestor(store: store)
            let model = ShelfModel(store: store, library: ShelfLibrary())

            let pbIn = NSPasteboard(name: NSPasteboard.Name("app.dragshelf.selftest.in.\(UUID().uuidString)"))
            let pbOut = NSPasteboard(name: NSPasteboard.Name("app.dragshelf.selftest.out.\(UUID().uuidString)"))
            defer { pbIn.releaseGlobally(); pbOut.releaseGlobally() }

            // 1. Multiple files in one drag → references, stacked.
            pbIn.clearContents()
            pbIn.writeObjects([textURL as NSURL, pngURL as NSURL, pdfURL as NSURL, folderURL as NSURL])
            let files = ingestor.ingest(pbIn) { _ in }.items
            check("Ingest 4 files from one drag", files.count == 4, "\(files.count) items")
            check("Files are kept as references, not copies",
                  files.allSatisfy { $0.isReferenceToOriginal } && store.storageUsage() == 0)
            check("Kinds detected (file, image, pdf, folder)",
                  files.map(\.kind) == [.file, .image, .pdf, .folder], files.map(\.kind.rawValue).joined(separator: ","))
            model.add(files, stack: true)
            check("Multi-item drop becomes one stack", model.activeShelf.entries.count == 1 && model.activeShelf.entries[0].isStack)

            // 2. Drag the files back out.
            pbOut.clearContents()
            pbOut.writeObjects(DragOut.writers(for: files, model: model, forDrag: true))
            let outURLs = (pbOut.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
            check("Drag-out offers the original file URLs",
                  outURLs.map(realPath) == [textURL, pngURL, pdfURL, folderURL].map(realPath),
                  outURLs.map(\.lastPathComponent).joined(separator: ", "))

            // 3. Text
            pbIn.clearContents()
            pbIn.setString("Hello from DragShelf", forType: .string)
            let text = ingestor.ingest(pbIn) { _ in }.items
            check("Text becomes a text item", text.count == 1 && text.first?.kind == .text)
            model.add(text, stack: true)
            pbOut.clearContents()
            pbOut.writeObjects(DragOut.writers(for: text, model: model, forDrag: true))
            check("Text drags out as the same string", pbOut.string(forType: .string) == "Hello from DragShelf")

            // 4. Rich text keeps every flavour
            pbIn.clearContents()
            let rich = NSAttributedString(string: "Bold text", attributes: [.font: NSFont.boldSystemFont(ofSize: 14)])
            let rtf = try rich.data(from: NSRange(location: 0, length: rich.length),
                                    documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
            let item = NSPasteboardItem()
            item.setData(rtf, forType: .rtf)
            item.setString("Bold text", forType: .string)
            pbIn.writeObjects([item])
            let richItems = ingestor.ingest(pbIn) { _ in }.items
            model.add(richItems, stack: true)
            pbOut.clearContents()
            pbOut.writeObjects(DragOut.writers(for: richItems, model: model, forDrag: true))
            check("Rich text preserves RTF and plain flavours",
                  pbOut.data(forType: .rtf) == rtf && pbOut.string(forType: .string) == "Bold text")

            // 5. Link
            pbIn.clearContents()
            let link = NSPasteboardItem()
            link.setString("https://www.apple.com/mac/", forType: .URL)
            link.setString("Mac - Apple", forType: DataFlavors.urlName)
            link.setString("https://www.apple.com/mac/", forType: .string)
            pbIn.writeObjects([link])
            let links = ingestor.ingest(pbIn) { _ in }.items
            check("URL becomes a link item with its title",
                  links.first?.kind == .link && links.first?.displayName == "Mac - Apple")
            model.add(links, stack: true)
            pbOut.clearContents()
            pbOut.writeObjects(DragOut.writers(for: links, model: model, forDrag: true))
            check("Link drags out as a URL", pbOut.string(forType: .URL) == "https://www.apple.com/mac/")

            // 6. Image data (e.g. from a browser) → stored copy, offered back as PNG + file promise
            pbIn.clearContents()
            pbIn.setData(pngData, forType: .png)
            let images = ingestor.ingest(pbIn) { _ in }.items
            check("Image data becomes an image item", images.first?.kind == .image)
            model.add(images, stack: true)
            pbOut.clearContents()
            pbOut.writeObjects(DragOut.writers(for: images, model: model, forDrag: false))
            check("Image copies back as identical PNG data", pbOut.data(forType: .png) == pngData)
            if let w = DragOut.writer(for: images[0], model: model, forDrag: true) as? DataItemPromiseProvider {
                let types = w.writableTypes(for: pbOut).map(\.rawValue)
                check("Image drag offers a file promise and PNG data", types.contains("public.png") && types.count > 1,
                      types.joined(separator: ", "))
            } else {
                check("Image drag offers a file promise and PNG data", false, "no promise provider")
            }

            // 7. Persistence round trip
            model.flush()
            if case .loaded(let restored) = store.load() {
                check("Shelf restores after relaunch", restored == model.library, "\(restored.totalItemCount) items")
            } else {
                check("Shelf restores after relaunch", false, "state not loaded")
            }

            // 8. Moved / deleted / replaced originals
            let ref = FileResolver.makeReference(for: textURL)
            let movedURL = originals.appendingPathComponent("Notes renamed.txt")
            try fm.moveItem(at: textURL, to: movedURL)
            if case .moved(let u) = FileResolver.resolve(ref) {
                check("A renamed original is followed (same file)", realPath(u) == realPath(movedURL))
            } else {
                check("A renamed original is followed (same file)", false, "\(FileResolver.resolve(ref))")
            }
            try fm.moveItem(at: movedURL, to: textURL) // put it back for the integrity check below

            let victim = originals.appendingPathComponent("Victim.txt")
            try Data("a".utf8).write(to: victim)
            let victimRef = FileResolver.makeReference(for: victim)
            try fm.removeItem(at: victim)
            check("A deleted original shows as unavailable", FileResolver.resolve(victimRef) == .missing)
            try Data("impostor".utf8).write(to: victim)
            check("A different file at the old path is never substituted", FileResolver.resolve(victimRef) == .replaced,
                  "\(FileResolver.resolve(victimRef))")
            try fm.removeItem(at: victim)

            // 9. Untrusted content
            check("Scripts are flagged before opening", FileResolver.isPotentiallyExecutable(scriptURL))
            check("Documents are not flagged", !FileResolver.isPotentiallyExecutable(pdfURL))

            // 10. Clearing never touches originals; owned copies are deleted.
            check("Copies were stored for text/link/image", store.storageUsage() > 0)
            model.mutate { _ = $0.clearAll() }
            model.dropUndoHistory()
            model.collectGarbage()
            let remaining = (try? fm.contentsOfDirectory(atPath: store.blobsURL.path)) ?? ["?"]
            check("Clearing deletes DragShelf's own copies", remaining.isEmpty, "\(remaining.count) left")
            let after = try snapshotFiles(originals)
            check("Original files are byte-for-byte untouched", after == snapshot, "\(after.count) files")

            // 11. Activation geometry against the real display layout
            let monitor = DragMonitor(settings: DragShelfSettings())
            if let screen = NSScreen.screens.first {
                let p = CGPoint(x: screen.frame.maxX - 1, y: screen.frame.midY)
                let leadsElsewhere = monitor.screens.count > 1 &&
                    ActivationGeometry.edgeLeadsToAnotherScreen(.right, of: monitor.screens[0], at: p, screens: monitor.screens)
                let hit = monitor.isInActivationRegion(p)
                check("Right edge of the primary display activates (unless another display is to its right)",
                      leadsElsewhere ? !hit : hit, "\(monitor.screens.count) display(s)")
            } else {
                check("Display geometry available", false, "no screens (headless?)")
            }
        } catch {
            check("Self-test setup", false, "\(error)")
        }

        let failed = checks.filter { !$0.ok }.count
        print("\n\(checks.count - failed)/\(checks.count) checks passed")
        if let i = arguments.firstIndex(of: "--out"), i + 1 < arguments.count {
            let payload: [String: Any] = [
                "ok": failed == 0,
                "passed": checks.count - failed,
                "total": checks.count,
                "checks": checks.map { ["name": $0.name, "ok": $0.ok, "detail": $0.detail] },
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: URL(fileURLWithPath: arguments[i + 1]))
            }
        }
        return failed == 0 ? 0 : 1
    }

    // MARK: Idle measurement

    /// Starts the full app (monitors, hotkeys, status item) and reports the CPU time it uses
    /// while idle for `seconds`. Leave the mouse and keyboard alone while it runs.
    static func measureIdle(seconds: Double) -> Int32 {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let controller = AppController()
        controller.start()
        let warmup = 3.0
        final class Box { var startCPU: Double = 0 }
        let box = Box()
        DispatchQueue.main.asyncAfter(deadline: .now() + warmup) {
            box.startCPU = cpuSeconds()
            print("Measuring idle CPU for \(Int(seconds)) s — please don't move the mouse…")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + warmup + seconds) {
            let used = cpuSeconds() - box.startCPU
            let percent = used / seconds * 100
            let rss = residentMemoryMB()
            print(String(format: "Idle CPU: %.4f s over %.0f s = %.3f%% of one core; resident memory %.1f MB", used, seconds, percent, rss))
            exit(0)
        }
        app.run()
        return 0
    }

    static func cpuSeconds() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let u = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6
        let s = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6
        return u + s
    }

    static func residentMemoryMB() -> Double {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size) / 4
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return kr == KERN_SUCCESS ? Double(info.resident_size) / 1_048_576 : -1
    }

    // MARK: Fixtures

    static func makePNG() -> Data {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 32, pixelsHigh: 32, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.systemTeal.setFill()
        NSRect(x: 0, y: 0, width: 32, height: 32).fill()
        NSGraphicsContext.restoreGraphicsState()
        return rep.representation(using: .png, properties: [:])!
    }

    static func makePDF() -> Data {
        let data = NSMutableData()
        var box = CGRect(x: 0, y: 0, width: 200, height: 200)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return Data() }
        ctx.beginPDFPage(nil)
        ctx.setFillColor(NSColor.systemOrange.cgColor)
        ctx.fill(CGRect(x: 20, y: 20, width: 160, height: 160))
        ctx.endPDFPage()
        ctx.closePDF()
        return data as Data
    }

    static func realPath(_ url: URL) -> String {
        url.standardizedFileURL.resolvingSymlinksInPath().path
    }

    /// Relative path → contents for every regular file under `dir`.
    static func snapshotFiles(_ dir: URL) throws -> [String: Data] {
        var result: [String: Data] = [:]
        let fm = FileManager.default
        guard let e = fm.enumerator(atPath: dir.path) else { return result }
        while let rel = e.nextObject() as? String {
            let url = dir.appendingPathComponent(rel)
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: url.path, isDirectory: &isDir), !isDir.boolValue {
                result[rel] = try Data(contentsOf: url)
            }
        }
        return result
    }
}
