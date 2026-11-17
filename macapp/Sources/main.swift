import AppKit

// JARVIS menu-bar app entry point. LSUIElement=YES in Info.plist: no Dock icon.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
