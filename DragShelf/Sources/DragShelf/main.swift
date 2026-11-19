import AppKit
import DragShelfCore

// `DragShelf --selftest [--out file.json]` runs non-interactive checks of the pasteboard
// ingest / drag-out / storage paths against real AppKit and exits.
if CommandLine.arguments.contains("--selftest") {
    exit(SelfTest.run(arguments: CommandLine.arguments))
}

let app = NSApplication.shared
let appDelegate = AppDelegate()
app.delegate = appDelegate
// No Dock icon, no main menu bar takeover: DragShelf lives in the background.
app.setActivationPolicy(.accessory)
app.run()
