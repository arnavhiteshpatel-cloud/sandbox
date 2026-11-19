import AirMixCore
import AppKit
import CoreAudio
import Darwin
import Foundation

/// One Core Audio client process.
public struct AudioProcessEntry: Hashable, Sendable {
    public let objectID: AudioObjectID
    public let pid: pid_t
    public let bundleID: String?
    public let isRunningOutput: Bool
    public let isRunningInput: Bool
}

/// A user-facing app that owns one or more audio processes (e.g. Chrome + its audio helper).
public struct AudioApp: Identifiable, Hashable, Sendable {
    /// Stable key (bundle identifier of the owning app).
    public let id: String
    public let name: String
    public let bundlePath: String?
    public let category: AppCategory
    public let processObjectIDs: [AudioObjectID]
    public let pids: [pid_t]
    /// At least one process is currently sending audio to an output.
    public let isPlaying: Bool
    /// At least one process is currently capturing input (microphone).
    public let usesMicrophone: Bool
    /// Processes that are currently producing output (the ones worth tapping).
    public let playingProcessObjectIDs: [AudioObjectID]
}

/// Resolves processes to their owning app. Results are cached per PID.
struct AppResolver {
    struct Resolved: Hashable {
        let key: String
        let name: String
        let bundlePath: String?
        let lsCategory: String?
    }

    private var cache: [pid_t: Resolved?] = [:]

    mutating func forget(except live: Set<pid_t>) {
        cache = cache.filter { live.contains($0.key) }
    }

    mutating func resolve(pid: pid_t, bundleID: String?) -> Resolved? {
        if let hit = cache[pid] { return hit }
        let r = compute(pid: pid, bundleID: bundleID)
        cache[pid] = r
        return r
    }

    private func compute(pid: pid_t, bundleID: String?) -> Resolved? {
        if pid == getpid() { return nil }
        if let b = bundleID, AppCatalog.excludedBundleIDs.contains(b) { return nil }
        let execName = Self.executablePath(pid).map { ($0 as NSString).lastPathComponent }
        if let b = bundleID, AppCatalog.systemSoundBundleIDs.contains(b) { return Self.systemSounds }
        if let n = execName, ["systemsoundserverd", "SystemSoundServer-macOS", "coreaudiod"].contains(n) {
            return n == "coreaudiod" ? nil : Self.systemSounds
        }

        // 1. The process itself is (inside) an app bundle.
        if let r = Self.appForPID(pid) { return r }
        // 2. The process that macOS holds responsible (XPC services such as WebKit's GPU process).
        if let owner = Self.responsiblePID(pid), owner != pid, owner > 1, let r = Self.appForPID(owner) { return r }
        // 3. Walk parent processes (helper processes launched by the app).
        var current = pid
        for _ in 0..<6 {
            guard let parent = Self.parentPID(current), parent > 1, parent != current else { break }
            if let r = Self.appForPID(parent) { return r }
            current = parent
        }
        // 4. Known shared services.
        if let b = bundleID, let owner = AppCatalog.sharedServiceOwners[b] {
            let path = NSWorkspace.shared.urlForApplication(withBundleIdentifier: owner.bundleID)?.path
            return Resolved(key: owner.bundleID, name: owner.name, bundlePath: path, lsCategory: nil)
        }
        // 5. Bare process (command-line tools such as afplay).
        let name = execName ?? bundleID ?? "PID \(pid)"
        let key = bundleID.map(AppCatalog.parentBundleID(forHelper:)) ?? "process:\(name)"
        return Resolved(key: key, name: AppCatalog.cleanDisplayName(name), bundlePath: nil, lsCategory: nil)
    }

    static let systemSounds = Resolved(key: AppCatalog.systemSoundsKey, name: "System Sounds", bundlePath: nil,
                                       lsCategory: nil)

    /// Outermost `.app` containing the process's executable.
    static func appForPID(_ pid: pid_t) -> Resolved? {
        if let app = NSRunningApplication(processIdentifier: pid), let url = app.bundleURL,
           url.pathExtension == "app",
           AppCatalog.outermostAppBundlePath(forExecutablePath: url.path + "/x") == url.path,
           let id = app.bundleIdentifier {
            let info = Bundle(url: url)?.infoDictionary
            return Resolved(key: id, name: app.localizedName ?? AppCatalog.cleanDisplayName(url.lastPathComponent),
                            bundlePath: url.path, lsCategory: info?["LSApplicationCategoryType"] as? String)
        }
        guard let exe = executablePath(pid),
              let appPath = AppCatalog.outermostAppBundlePath(forExecutablePath: exe),
              let bundle = Bundle(path: appPath), let id = bundle.bundleIdentifier else { return nil }
        let info = bundle.infoDictionary
        let name = (info?["CFBundleDisplayName"] as? String) ?? (info?["CFBundleName"] as? String)
            ?? AppCatalog.cleanDisplayName((appPath as NSString).lastPathComponent)
        return Resolved(key: id, name: name, bundlePath: appPath, lsCategory: info?["LSApplicationCategoryType"] as? String)
    }

    static func executablePath(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard n > 0 else { return nil }
        return buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) }
    }

    static func parentPID(_ pid: pid_t) -> pid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        let ppid = info.kp_eproc.e_ppid
        return ppid > 0 ? ppid : nil
    }

    /// macOS's "responsible process" for a PID (e.g. Safari for its WebKit GPU process).
    /// This uses a read-only libsystem function that Apple does not document publicly; it is looked
    /// up dynamically and AirMix falls back to parent-process / known-service attribution when it is
    /// unavailable. It changes nothing on the system.
    static func responsiblePID(_ pid: pid_t) -> pid_t? {
        typealias Fn = @convention(c) (pid_t) -> pid_t
        guard let handle = dlopen(nil, RTLD_NOW),
              let sym = dlsym(handle, "responsibility_get_pid_responsible_for_pid") else { return nil }
        let fn = unsafeBitCast(sym, to: Fn.self)
        let r = fn(pid)
        return r > 0 ? r : nil
    }
}

/// Watches Core Audio's process list and each process's input/output state (event-driven).
@MainActor
public final class ProcessMonitor {
    public private(set) var apps: [AudioApp] = []
    public private(set) var entries: [AudioProcessEntry] = []
    public var onChange: (() -> Void)?
    /// PIDs that must not appear (used by the self test to keep its tone players private).
    public var excludedPIDs: Set<pid_t> = [] { didSet { scheduleRefresh() } }

    private var listListener: PropertyListener?
    private var processListeners: [AudioObjectID: [PropertyListener]] = [:]
    private var resolver = AppResolver()
    private var pending: DispatchWorkItem?

    public init() {}

    public func start() {
        stop()
        listListener = PropertyListener(systemAudioObject, propertyAddress(kAudioHardwarePropertyProcessObjectList)) { [weak self] in
            MainActor.assumeIsolated { self?.scheduleRefresh() }
        }
        refresh()
    }

    public func stop() {
        listListener?.invalidate()
        listListener = nil
        processListeners.values.flatMap { $0 }.forEach { $0.invalidate() }
        processListeners = [:]
    }

    func scheduleRefresh() {
        pending?.cancel()
        let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.refresh() } }
        pending = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05, execute: item)
    }

    public func refresh() {
        let ids = CA.objectIDs(systemAudioObject, propertyAddress(kAudioHardwarePropertyProcessObjectList))
        let idSet = Set(ids)
        for (id, ls) in processListeners where !idSet.contains(id) {
            ls.forEach { $0.invalidate() }
            processListeners[id] = nil
        }
        for id in ids where processListeners[id] == nil {
            let handler: () -> Void = { [weak self] in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            processListeners[id] = [
                PropertyListener(id, propertyAddress(kAudioProcessPropertyIsRunningOutput), handler: handler),
                PropertyListener(id, propertyAddress(kAudioProcessPropertyIsRunningInput), handler: handler),
            ].compactMap { $0 }
        }

        let newEntries: [AudioProcessEntry] = ids.compactMap { id in
            guard let pid = try? CA.get(id, propertyAddress(kAudioProcessPropertyPID), pid_t(0)), pid > 0 else { return nil }
            return AudioProcessEntry(
                objectID: id, pid: pid,
                bundleID: CA.string(id, propertyAddress(kAudioProcessPropertyBundleID)),
                isRunningOutput: (CA.uint32(id, propertyAddress(kAudioProcessPropertyIsRunningOutput)) ?? 0) != 0,
                isRunningInput: (CA.uint32(id, propertyAddress(kAudioProcessPropertyIsRunningInput)) ?? 0) != 0)
        }
        resolver.forget(except: Set(newEntries.map(\.pid)))

        var groups: [String: (AppResolver.Resolved, [AudioProcessEntry])] = [:]
        for e in newEntries where !excludedPIDs.contains(e.pid) {
            guard let r = resolver.resolve(pid: e.pid, bundleID: e.bundleID) else { continue }
            groups[r.key, default: (r, [])].1.append(e)
        }
        let newApps = groups.map { key, value -> AudioApp in
            let (r, es) = value
            let playing = es.filter(\.isRunningOutput)
            return AudioApp(id: key, name: r.name, bundlePath: r.bundlePath,
                            category: AppCatalog.category(bundleID: key, lsApplicationCategory: r.lsCategory),
                            processObjectIDs: es.map(\.objectID).sorted(), pids: es.map(\.pid).sorted(),
                            isPlaying: !playing.isEmpty, usesMicrophone: es.contains(where: \.isRunningInput),
                            playingProcessObjectIDs: playing.map(\.objectID).sorted())
        }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        entries = newEntries
        if newApps != apps {
            apps = newApps
            onChange?()
        }
    }

    /// Process object IDs for given PIDs (used by the self test).
    public func processObjectIDs(forPIDs pids: Set<pid_t>) -> [AudioObjectID] {
        entries.filter { pids.contains($0.pid) }.map(\.objectID)
    }
}
