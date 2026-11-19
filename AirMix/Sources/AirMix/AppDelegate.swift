import AirMixAudio
import AirMixCore
import AppKit
import Combine
import SwiftUI

@main
@MainActor
struct AirMixMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()
    private var status: StatusItemController?
    private var mixer: MixerWindowController?
    private var cancellables: Set<AnyCancellable> = []
    private var signalSources: [DispatchSourceSignal] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        model.start()
        let mixer = MixerWindowController(model: model)
        self.mixer = mixer
        let status = StatusItemController(model: model) { [weak self] in self?.updateMeterVisibility() }
        self.status = status
        mixer.onVisibilityChange = { [weak self] in self?.updateMeterVisibility() }

        let center = NotificationCenter.default
        center.addObserver(forName: .airmixTogglePopover, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.status?.toggle() }
        }
        center.addObserver(forName: .airmixOpenMixer, object: nil, queue: .main) { [weak self] note in
            let section = note.object as? String
            MainActor.assumeIsolated {
                self?.status?.close()
                self?.mixer?.show(section: section.flatMap(MixerSection.init(rawValue:)))
            }
        }
        installSignalHandlers()

        if CommandLine.arguments.contains("--selftest") {
            runSelfTestAndExit()
        } else if !model.settings.preferences.hasCompletedOnboarding {
            onMainAfter(0.6) { [weak self] in self?.status?.show() }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.saveNow()
        model.engine.shutdown()   // every app plays normally again
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mixer?.show(section: nil)
        return false
    }

    private func updateMeterVisibility() {
        model.engine.metersVisible = (status?.isShown ?? false) || (mixer?.isVisible ?? false)
    }

    /// SIGTERM / SIGINT / SIGHUP (e.g. `killall AirMix`, logout) go through normal termination so
    /// all taps are removed cleanly.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler {
                MainActor.assumeIsolated { NSApp.terminate(nil) }
            }
            src.resume()
            signalSources.append(src)
        }
    }

    private func runSelfTestAndExit() {
        onMainAfter(1.5) { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                let report = await IndependenceTest(engine: self.model.engine).run()
                let json = report.json
                print(json)
                let url = SettingsStore.defaultURL().deletingLastPathComponent().appendingPathComponent("selftest.json")
                try? json.data(using: .utf8)?.write(to: url, options: .atomic)
                self.model.engine.shutdown()
                exit(report.passed ? 0 : 1)
            }
        }
    }
}

func onMainAfter(_ delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { MainActor.assumeIsolated { work() } }
}

// MARK: - Status item + popover

@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
    private let model: AppModel
    private let statusItem: NSStatusItem
    private let popover = NSPopover()
    private var scrollMonitor: Any?
    private var cancellables: Set<AnyCancellable> = []
    private let onVisibilityChange: () -> Void
    private(set) var isShown = false

    init(model: AppModel, onVisibilityChange: @escaping () -> Void) {
        self.model = model
        self.onVisibilityChange = onVisibilityChange
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        super.init()

        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "slider.vertical.3", accessibilityDescription: "AirMix")
            image?.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeading
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.toolTip = "AirMix"
        }

        let root = PopoverView(engine: model.engine, devices: model.devices).environmentObject(model)
        let hosting = NSHostingController(rootView: root)
        hosting.sizingOptions = [.preferredContentSize]
        popover.contentViewController = hosting
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self

        // Optional volume % next to the icon.
        model.$settings.map(\.preferences.showVolumeInMenuBar).removeDuplicates()
            .combineLatest(model.devices.$defaultVolume, model.devices.$defaultMuted)
            .sink { [weak self] show, volume, muted in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let v = volume.map(Double.init) ?? self.model.settings.softwareMasterVolume
                    self.statusItem.button?.title = show ? (muted ? " –" : " \(Int((v * 100).rounded()))%") : ""
                }
            }
            .store(in: &cancellables)

        // ⌥ + scroll over an app row adjusts that app.
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, self.isShown, self.model.settings.preferences.scrollToAdjust,
                      event.modifierFlags.contains(.option), let id = self.model.hoveredRowID else { return event }
                let raw = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY / 300 : event.scrollingDeltaY * 0.02
                let delta = event.isDirectionInvertedFromDevice ? -raw : raw
                self.model.nudgeVolume(id, by: Double(-delta))
                return nil
            }
        }
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else {
            toggle()
        }
    }

    func toggle() { isShown ? close() : show() }

    func show() {
        guard let button = statusItem.button else { return }
        NSApp.activate()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    func close() { popover.performClose(nil) }

    nonisolated func popoverDidShow(_ notification: Notification) {
        MainActor.assumeIsolated {
            isShown = true
            onVisibilityChange()
        }
    }

    nonisolated func popoverDidClose(_ notification: Notification) {
        MainActor.assumeIsolated {
            isShown = false
            onVisibilityChange()
        }
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Mixer…", action: #selector(openMixer), keyEquivalent: "").target = self
        let profiles = NSMenuItem(title: "Profile", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        for p in model.settings.profiles {
            let item = NSMenuItem(title: p.name, action: #selector(activateProfile(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = p.id
            item.state = model.settings.activeProfileID == p.id ? .on : .off
            sub.addItem(item)
        }
        profiles.submenu = sub
        menu.addItem(profiles)
        menu.addItem(.separator())
        menu.addItem(withTitle: model.engine.isPaused ? "Resume AirMix" : "Pause AirMix", action: #selector(togglePause),
                     keyEquivalent: "").target = self
        menu.addItem(withTitle: "Reset Audio", action: #selector(resetAudio), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit AirMix", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func openMixer() { NotificationCenter.default.post(name: .airmixOpenMixer, object: nil) }
    @objc private func activateProfile(_ sender: NSMenuItem) {
        if let id = sender.representedObject as? UUID { model.activateProfile(id) }
    }
    @objc private func togglePause() { model.engine.setPaused(!model.engine.isPaused) }
    @objc private func resetAudio() { model.resetAudio() }
    @objc private func quit() { NSApp.terminate(nil) }
}

// MARK: - Mixer window

@MainActor
final class MixerWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private var window: NSWindow?
    let navigation = MixerNavigation()
    var onVisibilityChange: (() -> Void)?

    init(model: AppModel) {
        self.model = model
    }

    var isVisible: Bool { window?.isVisible ?? false }

    func show(section: MixerSection?) {
        if let section { navigation.section = section }
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 680),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.title = "AirMix"
            w.isReleasedWhenClosed = false
            w.minSize = NSSize(width: 860, height: 560)
            w.isMovableByWindowBackground = true
            w.setFrameAutosaveName("AirMixMixerWindow")
            w.contentView = NSHostingView(rootView: MixerWindowView(engine: model.engine, devices: model.devices,
                                                                    navigation: navigation)
                .environmentObject(model))
            w.delegate = self
            if !w.setFrameUsingName("AirMixMixerWindow") { w.center() }
            window = w
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
        onVisibilityChange?()
    }

    nonisolated func windowWillClose(_ notification: Notification) {
        MainActor.assumeIsolated {
            onMainAfter(0.05) { [weak self] in self?.onVisibilityChange?() }
        }
    }

    nonisolated func windowDidMiniaturize(_ notification: Notification) {
        MainActor.assumeIsolated { onVisibilityChange?() }
    }

    nonisolated func windowDidDeminiaturize(_ notification: Notification) {
        MainActor.assumeIsolated { onVisibilityChange?() }
    }
}
