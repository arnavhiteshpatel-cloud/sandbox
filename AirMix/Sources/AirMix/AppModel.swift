import AirMixAudio
import AirMixCore
import AppKit
import Combine
import ServiceManagement
import SwiftUI

/// One row in the mixer: a running audio app or a remembered one.
struct MixerRow: Identifiable, Hashable {
    let id: String
    let name: String
    let bundlePath: String?
    let category: AppCategory
    let isRunning: Bool
    let isPlaying: Bool
    let usesMicrophone: Bool
    let isPinned: Bool
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var settings: AirMixSettings
    @Published private(set) var rows: [MixerRow] = []
    @Published private(set) var focusedAppID: String?
    @Published var selectedAppID: String?
    @Published var selfTestReport: IndependenceTest.Report?
    @Published var selfTestRunning = false
    @Published var loadIssue: String?
    @Published private(set) var launchAtLoginError: String?
    /// Row under the pointer (not published: hover must not re-render the list). Used for ⌥-scroll.
    var hoveredRowID: String?

    let engine: AudioEngine
    let store: SettingsStore
    let hotKeys = HotKeyCenter()
    @Published private(set) var hotKeyFailures: [UUID: String] = [:]
    private var cancellables: Set<AnyCancellable> = []
    private var saveWork: DispatchWorkItem?
    private var lastAutoProfileContext: String?

    var devices: DeviceMonitor { engine.devices }

    init(store: SettingsStore = SettingsStore(fileURL: SettingsStore.defaultURL())) {
        self.store = store
        let loaded = store.load()
        self.settings = loaded
        self.loadIssue = store.lastLoadIssue
        self.engine = AudioEngine(settings: loaded)
    }

    func start() {
        hotKeys.onAction = { [weak self] action in self?.perform(action) }
        $settings.map(\.shortcuts).removeDuplicates()
            .sink { [weak self] bindings in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.hotKeys.register(bindings)
                    self.hotKeyFailures = self.hotKeys.failed
                }
            }
            .store(in: &cancellables)
        engine.$apps
            .sink { [weak self] apps in
                MainActor.assumeIsolated { self?.appsChanged(apps) }
            }
            .store(in: &cancellables)
        engine.devices.$defaultOutput
            .removeDuplicates { $0?.uid == $1?.uid }
            .sink { [weak self] _ in
                MainActor.assumeIsolated { self?.evaluateAutoProfile() }
            }
            .store(in: &cancellables)
        engine.$audioConfirmed
            .sink { [weak self] confirmed in
                MainActor.assumeIsolated {
                    guard let self, confirmed, !UserDefaults.standard.bool(forKey: "audioConfirmed") else { return }
                    UserDefaults.standard.set(true, forKey: "audioConfirmed")
                }
            }
            .store(in: &cancellables)

        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                          object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let id = app?.bundleIdentifier
            MainActor.assumeIsolated {
                guard let self, let id, id != Bundle.main.bundleIdentifier else { return }
                self.focusedAppID = id
                self.evaluateAutoProfile()
            }
        }
        if let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, front != Bundle.main.bundleIdentifier {
            focusedAppID = front
        }
        engine.start(audioPreviouslyConfirmed: UserDefaults.standard.bool(forKey: "audioConfirmed"))
        syncLaunchAtLogin()
        rebuildRows()
    }

    // MARK: Settings plumbing

    private func mutate(save: Bool = true, _ body: (inout AirMixSettings) -> Void) {
        var s = settings
        body(&s)
        guard s != settings else { return }
        settings = s
        engine.update(settings: s)
        rebuildRows()
        if save { scheduleSave() }
    }

    private func scheduleSave() {
        saveWork?.cancel()
        let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.saveNow() } }
        saveWork = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: item)
    }

    func saveNow() {
        saveWork?.cancel()
        saveWork = nil
        do { try store.save(settings) } catch { NSLog("AirMix: saving settings failed: %@", error.localizedDescription) }
    }

    func appSettings(_ id: String) -> AppAudioSettings { settings.settings(for: id) }
    var maxBoost: Double { settings.preferences.maxBoost }

    // MARK: Rows

    private func appsChanged(_ apps: [AudioApp]) {
        let now = Date()
        var changed = false
        var known = settings.knownApps
        for app in apps {
            let existing = known[app.id]
            let stale = existing.map { now.timeIntervalSince($0.lastSeen) > 3600 } ?? true
            if existing == nil || stale || existing?.displayName != app.name {
                known[app.id] = KnownApp(displayName: app.name, bundlePath: app.bundlePath, category: app.category, lastSeen: now)
                changed = true
            }
        }
        if changed { mutate { $0.knownApps = known } }
        rebuildRows()
    }

    private func rebuildRows() {
        let running = engine.apps
        let runningIDs = Set(running.map(\.id))
        var out: [MixerRow] = running.map { app in
            MixerRow(id: app.id, name: app.name, bundlePath: app.bundlePath, category: app.category, isRunning: true,
                     isPlaying: app.isPlaying, usesMicrophone: app.usesMicrophone,
                     isPinned: settings.settings(for: app.id).isPinned)
        }
        // Remembered apps that are pinned or have custom settings, so they can be set up while closed.
        for (id, k) in settings.knownApps where !runningIDs.contains(id) {
            let s = settings.settings(for: id)
            guard s.isPinned || !s.isNeutral else { continue }
            out.append(MixerRow(id: id, name: k.displayName, bundlePath: k.bundlePath, category: k.category,
                                isRunning: false, isPlaying: false, usesMicrophone: false, isPinned: s.isPinned))
        }
        out.sort { a, b in
            if a.isPinned != b.isPinned { return a.isPinned }
            if a.isPlaying != b.isPlaying { return a.isPlaying }
            if a.isRunning != b.isRunning { return a.isRunning }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
        if out != rows { rows = out }
    }

    var visibleRows: [MixerRow] {
        rows.filter { row in
            let s = settings.settings(for: row.id)
            if s.isHidden { return false }
            if row.isPinned || row.isPlaying { return true }
            return settings.preferences.showInactiveApps
        }
    }

    var hiddenRows: [MixerRow] { rows.filter { settings.settings(for: $0.id).isHidden } }

    func displayName(_ id: String) -> String {
        rows.first { $0.id == id }?.name ?? settings.knownApps[id]?.displayName ?? id
    }

    // MARK: Per-app controls

    func setVolume(_ id: String, _ value: Double) {
        guard value.isFinite else { return }
        mutate(save: true) {
            var s = $0.settings(for: id)
            s.volume = value.clamped(to: 0...$0.preferences.maxBoost)
            if s.volume > 0 && s.isMuted && value > 0.001 { s.isMuted = false }
            $0.apps[id] = s
            $0.activeProfileID = nil
        }
    }

    func nudgeVolume(_ id: String, by delta: Double) {
        setVolume(id, appSettings(id).volume + delta)
    }

    func toggleMute(_ id: String) {
        mutate {
            var s = $0.settings(for: id)
            s.isMuted.toggle()
            $0.apps[id] = s
        }
    }

    func setOutput(_ id: String, _ uid: String?) {
        mutate {
            var s = $0.settings(for: id)
            s.outputDeviceUID = uid
            $0.apps[id] = s
        }
    }

    func setEQ(_ id: String, _ eq: EQSettings) {
        mutate {
            var s = $0.settings(for: id)
            s.eq = eq
            $0.apps[id] = s
        }
    }

    func togglePin(_ id: String) {
        mutate {
            var s = $0.settings(for: id)
            s.isPinned.toggle()
            $0.apps[id] = s
        }
    }

    func setHidden(_ id: String, _ hidden: Bool) {
        mutate {
            var s = $0.settings(for: id)
            s.isHidden = hidden
            $0.apps[id] = s
        }
    }

    func resetApp(_ id: String) {
        mutate {
            var s = AppAudioSettings.default
            s.isPinned = $0.settings(for: id).isPinned
            $0.apps[id] = s
        }
    }

    func forgetApp(_ id: String) {
        mutate {
            $0.apps[id] = nil
            $0.knownApps[id] = nil
        }
    }

    // MARK: EQ presets

    var allPresets: [EQPreset] { settings.allPresets }

    func applyPreset(_ presetID: String, to id: String) {
        guard let preset = settings.preset(id: presetID) else { return }
        var eq = appSettings(id).eq
        eq.bands = preset.bands
        eq.presetID = preset.id
        eq.isEnabled = true
        setEQ(id, eq)
    }

    func saveCustomPreset(name: String, bands: [EQBand]) -> EQPreset {
        let preset = EQPreset(name: name, bands: bands)
        mutate { $0.customPresets.append(preset) }
        return preset
    }

    func deleteCustomPreset(_ presetID: String) {
        mutate { $0.customPresets.removeAll { $0.id == presetID } }
    }

    // MARK: Master

    var masterVolume: Double {
        if let v = devices.defaultVolume { return Double(v) }
        return settings.softwareMasterVolume
    }

    var masterIsHardware: Bool { devices.defaultVolume != nil }

    var masterMuted: Bool {
        if devices.defaultOutput?.hasMuteControl == true { return devices.defaultMuted }
        return engine.softwareMute
    }

    func setMasterVolume(_ v: Double) {
        guard v.isFinite else { return }
        if let d = devices.defaultOutput, d.hasVolumeControl {
            AudioDevices.setVolume(d.id, Float(v))
            devices.refreshVolume()
            if v > 0.001 && devices.defaultMuted { AudioDevices.setMuted(d.id, false) }
        } else {
            mutate { $0.softwareMasterVolume = v.clamped(to: 0...1) }
        }
        objectWillChange.send()
    }

    func toggleMasterMute() {
        if let d = devices.defaultOutput, d.hasMuteControl {
            AudioDevices.setMuted(d.id, !devices.defaultMuted)
            devices.refreshVolume()
        } else {
            engine.softwareMute.toggle()
        }
        objectWillChange.send()
    }

    /// User-initiated change of the macOS default output.
    func setDefaultOutput(_ uid: String) {
        guard let d = devices.device(uid: uid) else { return }
        try? AudioDevices.setDefaultOutput(d.id)
    }

    func cycleOutputDevice() {
        let outs = devices.outputs
        guard !outs.isEmpty else { return }
        let idx = outs.firstIndex { $0.uid == devices.defaultOutput?.uid } ?? -1
        setDefaultOutput(outs[(idx + 1) % outs.count].uid)
    }

    // MARK: Profiles

    var activeProfile: Profile? { settings.profiles.first { $0.id == settings.activeProfileID } }

    private var categoryMap: [String: AppCategory] {
        var m: [String: AppCategory] = [:]
        for (id, k) in settings.knownApps { m[id] = k.category }
        for app in engine.apps { m[app.id] = app.category }
        return m
    }

    func activateProfile(_ id: UUID) {
        guard let profile = settings.profiles.first(where: { $0.id == id }) else { return }
        let categories = categoryMap
        mutate { ProfileEngine.apply(profile, to: &$0, categories: categories) }
    }

    func cycleProfile() {
        let ps = settings.profiles
        guard !ps.isEmpty else { return }
        let idx = ps.firstIndex { $0.id == settings.activeProfileID } ?? -1
        activateProfile(ps[(idx + 1) % ps.count].id)
    }

    @discardableResult
    func createProfileFromCurrent(name: String) -> Profile {
        let ids = Set(engine.apps.map(\.id)).union(settings.apps.keys)
        let entries = ProfileEngine.capture(settings: settings, appIDs: Array(ids), includeRouting: true)
        let enabledRules = settings.duckingRules.filter(\.isEnabled).map(\.id)
        let p = Profile(name: name, symbolName: "star.fill", entries: entries, enabledDuckingRules: enabledRules)
        mutate {
            $0.profiles.append(p)
            $0.activeProfileID = p.id
        }
        return p
    }

    func updateProfile(_ p: Profile) {
        mutate { s in
            if let i = s.profiles.firstIndex(where: { $0.id == p.id }) { s.profiles[i] = p }
        }
    }

    func recaptureProfile(_ id: UUID) {
        guard var p = settings.profiles.first(where: { $0.id == id }) else { return }
        let ids = Set(engine.apps.map(\.id)).union(settings.apps.keys)
        p.entries = ProfileEngine.capture(settings: settings, appIDs: Array(ids), includeRouting: true)
        p.enabledDuckingRules = settings.duckingRules.filter(\.isEnabled).map(\.id)
        updateProfile(p)
    }

    func deleteProfile(_ id: UUID) {
        mutate {
            $0.profiles.removeAll { $0.id == id }
            if $0.activeProfileID == id { $0.activeProfileID = nil }
            $0.shortcuts.removeAll { if case .activateProfile(id) = $0.action { return true }; return false }
        }
    }

    private func evaluateAutoProfile() {
        guard settings.preferences.autoProfileSwitching else { return }
        let context = "\(focusedAppID ?? "")|\(devices.defaultOutput?.uid ?? "")"
        guard context != lastAutoProfileContext else { return }
        lastAutoProfileContext = context
        if let p = ProfileEngine.autoProfile(in: settings.profiles, frontmostBundleID: focusedAppID,
                                             defaultOutputUID: devices.defaultOutput?.uid),
           p.id != settings.activeProfileID {
            activateProfile(p.id)
        }
    }

    // MARK: Ducking

    func updateRule(_ rule: DuckingRule) {
        mutate { s in
            if let i = s.duckingRules.firstIndex(where: { $0.id == rule.id }) { s.duckingRules[i] = rule }
            else { s.duckingRules.append(rule) }
        }
    }

    func addRule() -> DuckingRule {
        let r = DuckingRule(name: "New ducking rule", triggers: AppSelector(categories: [.communication]),
                            targets: AppSelector(categories: [.music]))
        updateRule(r)
        return r
    }

    func deleteRule(_ id: UUID) {
        mutate { s in
            s.duckingRules.removeAll { $0.id == id }
            for i in s.profiles.indices { s.profiles[i].enabledDuckingRules?.removeAll { $0 == id } }
        }
    }

    // MARK: Shortcuts

    func setShortcut(_ bindingID: UUID, combo: KeyCombo?) {
        mutate { s in
            if let i = s.shortcuts.firstIndex(where: { $0.id == bindingID }) { s.shortcuts[i].combo = combo }
        }
    }

    func addShortcut(_ action: ShortcutAction) {
        mutate { $0.shortcuts.append(ShortcutBinding(action: action, combo: nil)) }
    }

    func removeShortcut(_ bindingID: UUID) {
        mutate { $0.shortcuts.removeAll { $0.id == bindingID } }
    }

    func perform(_ action: ShortcutAction) {
        switch action {
        case .toggleMixer: NotificationCenter.default.post(name: .airmixTogglePopover, object: nil)
        case .muteAll: toggleMasterMute()
        case .toggleMuteApp(let id): toggleMute(id)
        case .focusedAppVolumeUp: if let id = focusedTarget { nudgeVolume(id, by: settings.preferences.volumeStep) }
        case .focusedAppVolumeDown: if let id = focusedTarget { nudgeVolume(id, by: -settings.preferences.volumeStep) }
        case .toggleMuteFocusedApp: if let id = focusedTarget { toggleMute(id) }
        case .nextOutputDevice: cycleOutputDevice()
        case .activateProfile(let id): activateProfile(id)
        case .nextProfile: cycleProfile()
        }
    }

    /// The frontmost app if it is an audio app, else the selected/most recently playing one.
    var focusedTarget: String? {
        if let f = focusedAppID, rows.contains(where: { $0.id == f }) { return f }
        if let s = selectedAppID { return s }
        return rows.first { $0.isPlaying }?.id
    }

    // MARK: Preferences

    func updatePreferences(_ body: (inout Preferences) -> Void) {
        let before = settings.preferences.launchAtLogin
        mutate { body(&$0.preferences) }
        if settings.preferences.launchAtLogin != before { applyLaunchAtLogin() }
    }

    private func applyLaunchAtLogin() {
        do {
            if settings.preferences.launchAtLogin {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLoginError = nil
        } catch {
            launchAtLoginError = "Couldn’t update login item: \(error.localizedDescription). AirMix must be in /Applications."
        }
    }

    private func syncLaunchAtLogin() {
        let enabled = SMAppService.mainApp.status == .enabled
        if enabled != settings.preferences.launchAtLogin {
            mutate { $0.preferences.launchAtLogin = enabled }
        }
    }

    func completeOnboarding() { updatePreferences { $0.hasCompletedOnboarding = true } }

    // MARK: Maintenance

    func resetAudio() { engine.resetAudio() }

    func runSelfTest() {
        guard !selfTestRunning else { return }
        selfTestRunning = true
        selfTestReport = nil
        Task { @MainActor in
            let report = await IndependenceTest(engine: engine).run()
            selfTestReport = report
            selfTestRunning = false
        }
    }

    func exportSettingsURL() -> URL { store.fileURL }
}

extension Notification.Name {
    static let airmixTogglePopover = Notification.Name("AirMixTogglePopover")
    static let airmixOpenMixer = Notification.Name("AirMixOpenMixer")
}
