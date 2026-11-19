import AirMixCore
import AppKit
import Combine
import CoreAudio
import Foundation

/// Orchestrates per-app audio paths. Everything here runs on the main thread; the only work on
/// Core Audio's real-time threads happens inside the C kernel.
@MainActor
public final class AudioEngine: ObservableObject {
    public enum Status: Equatable {
        case starting
        case running
        case paused
        case noOutput
        /// The default output can't host per-app playback (e.g. a Multi-Output device).
        case unsupportedOutput(String)
    }

    public struct PathInfo: Hashable {
        public var deviceName: String
        public var deviceUID: String
        public var sampleRate: Double
        public var addedLatencyMs: Double
        public var usingFallbackDevice: Bool
        public var processCount: Int
    }

    @Published public private(set) var apps: [AudioApp] = []
    @Published public private(set) var status: Status = .starting
    @Published public private(set) var pathInfo: [String: PathInfo] = [:]
    /// Last error per app (shown in the UI instead of pretending control works).
    @Published public private(set) var appErrors: [String: String] = [:]
    /// Audio has been received through a tap at least once (proves capture permission).
    @Published public private(set) var audioConfirmed = false
    /// Apps are playing but no audio reaches AirMix — capture permission was probably denied.
    @Published public private(set) var permissionSuspected = false
    @Published public private(set) var duckingAmounts: [UUID: Double] = [:]
    @Published public private(set) var recoveryLog: [String] = []

    public let devices: DeviceMonitor
    public let processes: ProcessMonitor
    public let meters = MeterHub()

    /// Set while the mixer UI is visible; meters are only read then (or while ducking needs them).
    public var metersVisible = false { didSet { if metersVisible != oldValue { updateTimers() } } }
    /// Mutes every processed app (used when the output device has no hardware mute).
    public var softwareMute = false { didSet { applyParameters() } }

    private var settings: AirMixSettings
    private var paths: [String: AppAudioPath] = [:]
    private var retiring: [ObjectIdentifier: AppAudioPath] = [:]
    private var lastActive: [String: Date] = [:]
    private var failures: [String: (count: Int, last: Date)] = [:]
    private var recoveries: [String: [Date]] = [:]
    private let ducking = DuckingEngine()
    private var duckInfluences: [String: [DuckInfluence]] = [:]
    private var tickTimer: Timer?
    private var tickInterval: TimeInterval = 0
    private var healthTimer: Timer?
    private var lastTick = Date()
    private var observers: [NSObjectProtocol] = []
    private var paused = false
    private var reconcileScheduled = false
    private var started = false
    private var silentPlayingSince: Date?

    public init(settings: AirMixSettings) {
        self.settings = settings
        self.devices = DeviceMonitor()
        self.processes = ProcessMonitor()
        self.audioConfirmed = false
    }

    // MARK: Lifecycle

    public func start(audioPreviouslyConfirmed: Bool) {
        guard !started else { return }
        started = true
        audioConfirmed = audioPreviouslyConfirmed
        let leftovers = AppAudioPath.cleanUpLeftovers()
        if leftovers > 0 { log("Removed \(leftovers) leftover AirMix device(s) from an earlier session.") }

        devices.onChange = { [weak self] change in self?.handle(change) }
        processes.onChange = { [weak self] in
            guard let self else { return }
            self.apps = self.processes.apps
            self.reconcile()
        }
        devices.start()
        processes.start()
        apps = processes.apps

        let ws = NSWorkspace.shared.notificationCenter
        observers.append(ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.log("Woke from sleep — rebuilding audio paths.")
                onMain(after: 1.5) { self?.rebuildAll(reason: nil) }
            }
        })
        reconcile()
    }

    /// Stops all processing synchronously. Every app immediately plays normally again.
    public func shutdown() {
        tickTimer?.invalidate(); tickTimer = nil
        healthTimer?.invalidate(); healthTimer = nil
        for p in paths.values { p.stop() }
        for p in retiring.values { p.stop() }
        paths.removeAll()
        retiring.removeAll()
        observers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        observers.removeAll()
        processes.stop()
        devices.stop()
        started = false
    }

    public var isPaused: Bool { paused }

    /// Pauses AirMix: all taps are removed, apps play exactly as without AirMix.
    public func setPaused(_ p: Bool) {
        paused = p
        if p {
            for key in Array(paths.keys) { removePath(key, fade: false) }
        }
        reconcile()
    }

    /// One-click recovery: tear everything down, re-read the system state, rebuild.
    public func resetAudio() {
        for key in Array(paths.keys) { removePath(key, fade: false) }
        for p in retiring.values { p.stop() }
        retiring.removeAll()
        failures.removeAll()
        recoveries.removeAll()
        appErrors.removeAll()
        ducking.reset()
        duckInfluences.removeAll()
        permissionSuspected = false
        silentPlayingSince = nil
        _ = AppAudioPath.cleanUpLeftovers()
        devices.start()
        processes.start()
        apps = processes.apps
        log("Audio reset by user.")
        reconcile()
    }

    public func update(settings new: AirMixSettings) {
        let routingChanged = new.apps.mapValues(\.outputDeviceUID) != settings.apps.mapValues(\.outputDeviceUID)
            || new.preferences.processOnlyAdjustedApps != settings.preferences.processOnlyAdjustedApps
            || new.duckingRules != settings.duckingRules
            || new.apps.mapValues(\.isNeutral) != settings.apps.mapValues(\.isNeutral)
        settings = new
        if routingChanged { reconcile() } else { applyParameters() }
        updateTimers()
    }

    // MARK: Queries

    public func isProcessing(_ key: String) -> Bool { paths[key]?.isRunning ?? false }
    public func path(for key: String) -> AppAudioPath? { paths[key] }
    public var activePathCount: Int { paths.count }

    // MARK: Reconciliation

    private func scheduleReconcile(after delay: TimeInterval) {
        guard !reconcileScheduled else { return }
        reconcileScheduled = true
        onMain(after: delay) { [weak self] in
            self?.reconcileScheduled = false
            self?.reconcile()
        }
    }

    /// Makes the set of live audio paths match the apps and settings. Idempotent.
    public func reconcile() {
        guard started else { return }
        let def = devices.defaultOutput
        if paused {
            status = .paused
        } else if let def {
            status = def.supportsPerAppPlayback ? .running : .unsupportedOutput(def.name)
        } else {
            status = .noOutput
        }
        if paused {
            updateTimers()
            return
        }

        let now = Date()
        let prefs = settings.preferences
        var desired: [String: (app: AudioApp, device: OutputDevice, fallback: Bool)] = [:]
        var nextExpiry: TimeInterval?

        for app in apps {
            if app.isPlaying { lastActive[app.id] = now }
            let s = settings.settings(for: app.id)
            let recentlyActive = lastActive[app.id].map { now.timeIntervalSince($0) < prefs.inactiveGracePeriod } ?? false
            if !app.isPlaying, recentlyActive, let last = lastActive[app.id] {
                let remaining = prefs.inactiveGracePeriod - now.timeIntervalSince(last)
                nextExpiry = min(nextExpiry ?? remaining, remaining)
            }
            let involvedInDucking = isDuckingParticipant(app)
            let needsProcessing = !prefs.processOnlyAdjustedApps || !s.isNeutral || involvedInDucking
                || settings.softwareMasterVolume < 0.999 || softwareMute
            // Paths exist while an app plays and for a grace period afterwards, so pausing and
            // resuming stays seamless. (A brand-new playback start can be heard unprocessed for the
            // few milliseconds it takes to build the path.)
            let wanted = needsProcessing && (app.isPlaying || recentlyActive)
            guard wanted, !app.processObjectIDs.isEmpty else { continue }

            var device: OutputDevice?
            var fallback = false
            if let uid = s.outputDeviceUID {
                if let d = devices.device(uid: uid), d.supportsPerAppPlayback {
                    device = d
                } else {
                    fallback = true
                }
            }
            if device == nil, let def, def.supportsPerAppPlayback { device = def }
            guard let device else { continue }

            if let f = failures[app.id], now.timeIntervalSince(f.last) < min(60, 3 * Double(f.count)) {
                let wait = min(60, 3 * Double(f.count)) - now.timeIntervalSince(f.last)
                nextExpiry = min(nextExpiry ?? wait, wait)
                continue
            }
            desired[app.id] = (app, device, fallback)
        }

        for key in paths.keys where desired[key] == nil { removePath(key, fade: true) }

        for (key, d) in desired {
            if let path = paths[key] {
                if path.output.uid != d.device.uid || abs(path.sampleRate - d.device.sampleRate) > 0.5 {
                    replacePath(key, app: d.app, device: d.device, fallback: d.fallback, crossfade: true)
                } else if path.processObjectIDs != d.app.processObjectIDs {
                    if !path.updateProcesses(d.app.processObjectIDs) {
                        replacePath(key, app: d.app, device: d.device, fallback: d.fallback, crossfade: true)
                    } else {
                        pathInfo[key]?.processCount = d.app.processObjectIDs.count
                    }
                }
                pathInfo[key]?.usingFallbackDevice = d.fallback
            } else {
                replacePath(key, app: d.app, device: d.device, fallback: d.fallback, crossfade: false)
            }
        }

        // Forget activity of apps that are gone.
        let live = Set(apps.map(\.id))
        lastActive = lastActive.filter { live.contains($0.key) }
        if let next = nextExpiry { scheduleReconcile(after: max(0.5, next + 0.25)) }
        applyParameters()
        updateTimers()
    }

    private func replacePath(_ key: String, app: AudioApp, device: OutputDevice, fallback: Bool, crossfade: Bool) {
        let old = paths[key]
        do {
            let path = try AppAudioPath(appKey: key, processObjectIDs: app.processObjectIDs, output: device)
            paths[key] = path
            failures[key] = nil
            appErrors[key] = nil
            pathInfo[key] = PathInfo(deviceName: device.name, deviceUID: device.uid, sampleRate: path.sampleRate,
                                     addedLatencyMs: path.addedLatencyMilliseconds, usingFallbackDevice: fallback,
                                     processCount: app.processObjectIDs.count)
            applyParameters(only: key)
            if let old { retire(old, fade: crossfade) }
        } catch {
            let f = failures[key].map { ($0.count + 1, Date()) } ?? (1, Date())
            failures[key] = f
            appErrors[key] = error.localizedDescription
            log("\(app.name): \(error.localizedDescription)")
            if let old, !AudioDevices.isAlive(old.output.id) {
                retire(old, fade: false)
                paths[key] = nil
                pathInfo[key] = nil
            }
        }
    }

    private func removePath(_ key: String, fade: Bool) {
        guard let path = paths.removeValue(forKey: key) else { return }
        pathInfo[key] = nil
        meters.model(for: key).reset()
        retire(path, fade: fade)
    }

    private func retire(_ path: AppAudioPath, fade: Bool) {
        guard fade else {
            path.stop()
            return
        }
        path.processor.setGain(0)
        let id = ObjectIdentifier(path)
        retiring[id] = path
        onMain(after: 0.12) { [weak self] in
            path.stop()
            self?.retiring[id] = nil
        }
    }

    private func rebuildAll(reason: String?) {
        if let reason { log(reason) }
        for key in Array(paths.keys) { removePath(key, fade: false) }
        reconcile()
    }

    private func handle(_ change: DeviceMonitor.DeviceChange) {
        switch change {
        case .devicesChanged(let removed, let added):
            if !removed.isEmpty {
                // The device is gone: its paths can't fade; stop them now and rebuild on the fallback.
                for (key, path) in paths where removed.contains(path.output.uid) {
                    path.stop()
                    paths[key] = nil
                    pathInfo[key] = nil
                }
                log("Output disconnected: \(removed.count) device(s). Apps moved to the fallback output.")
            }
            if !added.isEmpty { log("Output connected: \(added.count) device(s).") }
            reconcile()
        case .defaultOutputChanged:
            reconcile()
        case .formatChanged(let uid):
            for (key, path) in paths where path.output.uid == uid {
                if let app = apps.first(where: { $0.id == key }), let device = devices.device(uid: uid) {
                    replacePath(key, app: app, device: device, fallback: pathInfo[key]?.usingFallbackDevice ?? false,
                                crossfade: true)
                }
            }
            reconcile()
        case .serviceRestarted:
            processes.start()
            rebuildAll(reason: "The audio system restarted — rebuilding audio paths.")
        }
    }

    // MARK: Parameters

    private func applyParameters(only onlyKey: String? = nil) {
        let prefs = settings.preferences
        let master = VolumeTaper.gain(forPosition: settings.softwareMasterVolume)
        for (key, path) in paths where onlyKey == nil || key == onlyKey {
            let s = settings.settings(for: key)
            var base = VolumeTaper.gain(forPosition: min(s.volume, prefs.maxBoost)) * master
            if s.isMuted || softwareMute { base = 0 }
            let gain = DuckingMath.duckedGain(baseGain: base, influences: duckInfluences[key] ?? [])
            path.processor.setGain(gain)
            if path.appliedEQ != s.eq {
                path.processor.setEQ(s.eq)
                path.appliedEQ = s.eq
            }
            // Boost above unity always keeps the limiter on, whatever the preference.
            path.processor.setLimiter(enabled: prefs.limiterEnabled || gain > 1.0)
            path.processor.setVoiceDetection(needsVoiceDetection(key))
        }
    }

    // MARK: Ducking & meters

    private var enabledRules: [DuckingRule] { settings.duckingRules.filter(\.isEnabled) }

    private func isDuckingParticipant(_ app: AudioApp) -> Bool {
        enabledRules.contains {
            ($0.triggers.matches(bundleID: app.id, category: app.category) && $0.mode != .microphone)
                || $0.targets.matches(bundleID: app.id, category: app.category)
        }
    }

    private func needsVoiceDetection(_ key: String) -> Bool {
        guard let app = apps.first(where: { $0.id == key }) else { return false }
        return enabledRules.contains {
            ($0.mode == .voice || $0.mode == .voiceOrMicrophone) && $0.triggers.matches(bundleID: app.id, category: app.category)
        }
    }

    private func updateTimers() {
        let duckingActive = !enabledRules.isEmpty && !apps.isEmpty
        let wantMeters = metersVisible && !paths.isEmpty
        let interval: TimeInterval = wantMeters ? 1.0 / 30.0 : (duckingActive ? 1.0 / 20.0 : 0)
        if interval == 0 {
            tickTimer?.invalidate()
            tickTimer = nil
            tickInterval = 0
            meters.resetAll()
            if !ducking.isIdle || !duckInfluences.isEmpty {
                ducking.reset()
                duckInfluences.removeAll()
                duckingAmounts.removeAll()
                applyParameters()
            }
        } else if interval != tickInterval || tickTimer == nil {
            tickTimer?.invalidate()
            tickInterval = interval
            lastTick = Date()
            let t = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            t.tolerance = interval * 0.2
            RunLoop.main.add(t, forMode: .common)
            tickTimer = t
        }

        if paths.isEmpty {
            healthTimer?.invalidate()
            healthTimer = nil
        } else if healthTimer == nil {
            let t = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.checkHealth() }
            }
            t.tolerance = 0.5
            RunLoop.main.add(t, forMode: .common)
            healthTimer = t
        }
    }

    private func tick() {
        let now = Date()
        let dt = now.timeIntervalSince(lastTick)
        lastTick = now
        var readings: [String: MeterReading] = [:]
        for (key, path) in paths { readings[key] = path.processor.readMeters() }

        if metersVisible {
            let decay = dt * 1.6   // full-scale fall in ~0.6 s
            for (key, r) in readings { meters.update(key, r, decay: decay) }
        }

        let rules = enabledRules
        if !rules.isEmpty {
            let participants = apps.map { app -> DuckingParticipant in
                let r = readings[app.id]
                return DuckingParticipant(bundleID: app.id, category: app.category,
                                          signal: AppSignal(rms: r?.inputRMS ?? 0, voiceRatio: r?.voiceRatio ?? 0,
                                                            usesMicrophone: app.usesMicrophone))
            }
            let influences = ducking.step(dt: dt, rules: rules, participants: participants)
            if influences != duckInfluences {
                duckInfluences = influences
                applyParameters()
            }
            var amounts: [UUID: Double] = [:]
            for rule in rules { amounts[rule.id] = ducking.amount(rule.id) }
            if amounts != duckingAmounts { duckingAmounts = amounts }
        }
    }

    private func checkHealth() {
        let now = Date()
        var anyAudio = false
        var playingButSilent = false
        for (key, path) in paths {
            guard let app = apps.first(where: { $0.id == key }), app.isPlaying else {
                path.stalledChecks = 0
                continue
            }
            let count = path.processor.callbackCount
            if count == path.lastCallbackCount {
                path.stalledChecks += 1
            } else {
                path.stalledChecks = 0
                path.lastCallbackCount = count
            }
            let rms = path.processor.inputRMS
            if rms > 1e-5 { anyAudio = true }
            if count > 0 && rms == 0 && now.timeIntervalSince(path.createdAt) > 3 { playingButSilent = true }

            if path.stalledChecks >= 2 {
                var recent = (recoveries[key] ?? []).filter { now.timeIntervalSince($0) < 60 }
                if recent.count < 3 {
                    recent.append(now)
                    recoveries[key] = recent
                    log("\(app.name): audio callback stalled — rebuilding its audio path.")
                    if let device = devices.device(uid: path.output.uid) ?? devices.defaultOutput, device.supportsPerAppPlayback {
                        replacePath(key, app: app, device: device, fallback: pathInfo[key]?.usingFallbackDevice ?? false,
                                    crossfade: false)
                    }
                } else if appErrors[key] == nil {
                    appErrors[key] = "Audio isn’t reaching AirMix from this app. Try Reset Audio, or check the System Audio Recording permission."
                }
            }
        }
        if anyAudio {
            if !audioConfirmed { audioConfirmed = true }
            if permissionSuspected { permissionSuspected = false }
            silentPlayingSince = nil
        } else if playingButSilent && !audioConfirmed {
            if silentPlayingSince == nil { silentPlayingSince = now }
            if let since = silentPlayingSince, now.timeIntervalSince(since) > 4, !permissionSuspected {
                permissionSuspected = true
            }
        }
    }

    private func log(_ message: String) {
        let stamp = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        recoveryLog.append("\(stamp)  \(message)")
        if recoveryLog.count > 200 { recoveryLog.removeFirst(recoveryLog.count - 200) }
        NSLog("AirMix: %@", message)
    }
}
