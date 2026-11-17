import AppKit
import AVFoundation
import ApplicationServices
import ServiceManagement
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let daemon = Daemon()
    lazy var web = WebFactory(daemon: daemon)
    let hotkeys = HotKeys()
    let system = SystemEvents()
    var statusItem: NSStatusItem!
    var popover: NSPopover?
    var hudPanel: NSPanel?
    var center: NSWindow?
    var pttDown = false
    var statusText = "Starting…"

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        setIcon("circle.dotted")
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        daemon.onStatus = { [weak self] s in self?.statusText = "Service: \(s)" }
        daemon.onReady = { [weak self] in self?.serviceReady() }
        daemon.start()

        hotkeys.onPress = { [weak self] id in self?.hotkeyPressed(id) }
        hotkeys.onRelease = { [weak self] id in self?.hotkeyReleased(id) }
        hotkeys.start()

        system.send = { [weak self] ev in self?.daemon.post("api/system/event", ["event": ev]) }
        system.start()

        web.onMessage = { [weak self] msg in self?.handle(msg) }
    }

    func applicationWillTerminate(_ note: Notification) {
        hotkeys.unregister()
        daemon.stop()
    }

    private func serviceReady() {
        setIcon("smallcircle.filled.circle")
        hotkeys.retryTapIfNeeded()          // Accessibility may have been granted since launch
        if hudPanel == nil { buildHUD() }   // onReady fires again after a service restart
        if !UserDefaults.standard.bool(forKey: "onboarded") {
            onboard()
        }
    }

    // MARK: First run: ask for permissions with context, then show Settings.

    private func onboard() {
        AVCaptureDevice.requestAccess(for: .audio) { _ in }
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        UserDefaults.standard.set(true, forKey: "onboarded")
        openCenter(hash: "settings")
    }

    // MARK: Hot keys

    private func hotkeyPressed(_ id: UInt32) {
        if id == HotKeys.pushToTalk, !pttDown {
            pttDown = true
            showHUD(true)
            daemon.post("api/ptt/down")
        } else if id == HotKeys.emergencyStop {
            daemon.post("api/stop", ["source": "hotkey"])
        }
    }

    private func hotkeyReleased(_ id: UInt32) {
        if id == HotKeys.pushToTalk, pttDown {
            pttDown = false
            daemon.post("api/ptt/up")
        }
    }

    // MARK: Messages from the web UI

    private func handle(_ msg: [String: Any]) {
        switch msg["type"] as? String {
        case "hud":
            showHUD((msg["visible"] as? Bool) ?? false)
        case "openCenter":
            popover?.performClose(nil)
            openCenter(hash: (msg["hash"] as? String) ?? "live")
        case "openURL":
            if let s = msg["url"] as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
        case "status":
            if let s = msg["status"] as? String { updateIcon(status: s) }
        default: break
        }
    }

    private func setIcon(_ symbol: String) {
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "JARVIS")
        img?.isTemplate = true
        statusItem.button?.image = img
    }

    private func updateIcon(status: String) {
        switch status {
        case "listening": setIcon("waveform.circle.fill")
        case "thinking", "acting", "transcribing": setIcon("ellipsis.circle.fill")
        case "speaking": setIcon("speaker.wave.2.circle.fill")
        default: setIcon("smallcircle.filled.circle")
        }
    }

    // MARK: Menu-bar item

    @objc private func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = buildMenu()
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
            return
        }
        togglePopover()
    }

    private func togglePopover() {
        if let p = popover, p.isShown { p.performClose(nil); return }
        let p = popover ?? {
            let p = NSPopover()
            p.behavior = .transient
            p.contentSize = NSSize(width: 380, height: 520)
            let vc = NSViewController()
            vc.view = web.make(view: "compact")
            p.contentViewController = vc
            popover = p
            return p
        }()
        NSApp.activate(ignoringOtherApps: true)  // lets a .transient popover close on outside clicks
        if let b = statusItem.button { p.show(relativeTo: b.bounds, of: b, preferredEdge: .minY) }
    }

    private func buildMenu() -> NSMenu {
        let m = NSMenu()
        let header = NSMenuItem(title: "\(statusText) · talk: hold \(hotkeys.pttDescription)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        m.addItem(header)
        m.addItem(.separator())
        m.addItem(withTitle: "Open Command Center", action: #selector(menuOpenCenter), keyEquivalent: "").target = self
        let modes = NSMenu()
        for (title, key) in [("Battery Saver", "battery_saver"), ("Balanced", "balanced"), ("Maximum Performance", "max_performance")] {
            let it = NSMenuItem(title: title, action: #selector(menuMode(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = key
            modes.addItem(it)
        }
        let modeItem = NSMenuItem(title: "Power Mode", action: nil, keyEquivalent: "")
        modeItem.submenu = modes
        m.addItem(modeItem)
        m.addItem(withTitle: "Mute / Unmute Microphone", action: #selector(menuMute), keyEquivalent: "").target = self
        m.addItem(withTitle: "Emergency Stop  ⌃⌥⌘.", action: #selector(menuStop), keyEquivalent: "").target = self
        m.addItem(.separator())
        let login = NSMenuItem(title: "Launch at Login", action: #selector(menuLogin), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        m.addItem(login)
        m.addItem(withTitle: "Restart JARVIS Service", action: #selector(menuRestart), keyEquivalent: "").target = self
        m.addItem(withTitle: "Quit JARVIS", action: #selector(menuQuit), keyEquivalent: "q").target = self
        return m
    }

    @objc private func menuOpenCenter() { openCenter(hash: "live") }
    @objc private func menuMode(_ sender: NSMenuItem) { daemon.post("api/power", ["mode": sender.representedObject as? String ?? "balanced"]) }
    @objc private func menuMute() { muted.toggle(); daemon.post("api/mute", ["muted": muted]) }
    @objc private func menuStop() { daemon.post("api/stop", ["source": "menu"]) }
    @objc private func menuRestart() { daemon.stop(); daemon.start() }
    @objc private func menuQuit() { NSApp.terminate(nil) }
    private var muted = false

    @objc private func menuLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() }
            else { try SMAppService.mainApp.register() }
        } catch {
            let a = NSAlert()
            a.messageText = "Couldn't change the login item"
            a.informativeText = "\(error.localizedDescription)\nMove JARVIS.app to /Applications and try again."
            a.runModal()
        }
    }

    // MARK: Windows

    private func openCenter(hash: String) {
        if center == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.title = "JARVIS"
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.backgroundColor = NSColor(red: 0.02, green: 0.027, blue: 0.035, alpha: 1)
            w.isReleasedWhenClosed = false
            w.minSize = NSSize(width: 760, height: 520)
            w.contentView = web.make(view: "center", hash: hash)
            w.center()
            w.setFrameAutosaveName("JARVISCommandCenter")
            center = w
        } else if let wv = center?.contentView as? WKWebView {
            wv.evaluateJavaScript("location.hash = '#\(hash)'")
        }
        NSApp.activate(ignoringOtherApps: true)
        center?.makeKeyAndOrderFront(nil)
    }

    /// The floating pill. Hidden (and its animations paused) whenever JARVIS is idle.
    private func buildHUD() {
        let size = NSSize(width: 700, height: 90)
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.contentView = web.make(view: "hud", transparent: true)
        panel.alphaValue = 0
        hudPanel = panel
    }

    private func showHUD(_ visible: Bool) {
        guard let panel = hudPanel else { return }
        if visible {
            if let screen = NSScreen.main {
                let f = screen.visibleFrame
                panel.setFrameOrigin(NSPoint(x: f.midX - panel.frame.width / 2, y: f.maxY - panel.frame.height - 6))
            }
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in ctx.duration = 0.18; panel.animator().alphaValue = 1 }
        } else {
            NSAnimationContext.runAnimationGroup({ ctx in ctx.duration = 0.25; panel.animator().alphaValue = 0 },
                                                 completionHandler: { if panel.alphaValue == 0 { panel.orderOut(nil) } })
        }
    }
}
