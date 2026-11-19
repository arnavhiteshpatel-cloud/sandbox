import AirMixCore
import AudioToolbox
import Combine
import CoreAudio
import Foundation

public enum DeviceTransport: String, Hashable, Sendable {
    case builtIn, usb, bluetooth, bluetoothLE, airPlay, hdmi, displayPort, thunderbolt, virtual, aggregate, pci,
         fireWire, avb, unknown

    init(raw: UInt32) {
        switch raw {
        case kAudioDeviceTransportTypeBuiltIn: self = .builtIn
        case kAudioDeviceTransportTypeUSB: self = .usb
        case kAudioDeviceTransportTypeBluetooth: self = .bluetooth
        case kAudioDeviceTransportTypeBluetoothLE: self = .bluetoothLE
        case kAudioDeviceTransportTypeAirPlay: self = .airPlay
        case kAudioDeviceTransportTypeHDMI: self = .hdmi
        case kAudioDeviceTransportTypeDisplayPort: self = .displayPort
        case kAudioDeviceTransportTypeThunderbolt: self = .thunderbolt
        case kAudioDeviceTransportTypeVirtual: self = .virtual
        case kAudioDeviceTransportTypeAggregate, 0x6667_7270 /* 'fgrp' auto-aggregate */: self = .aggregate
        case kAudioDeviceTransportTypePCI: self = .pci
        case kAudioDeviceTransportTypeFireWire: self = .fireWire
        case kAudioDeviceTransportTypeAVB: self = .avb
        default: self = .unknown
        }
    }

    public var isBluetooth: Bool { self == .bluetooth || self == .bluetoothLE }

    public var displayName: String {
        switch self {
        case .builtIn: return "Built-in"
        case .usb: return "USB"
        case .bluetooth, .bluetoothLE: return "Bluetooth"
        case .airPlay: return "AirPlay"
        case .hdmi: return "HDMI"
        case .displayPort: return "DisplayPort"
        case .thunderbolt: return "Thunderbolt"
        case .virtual: return "Virtual"
        case .aggregate: return "Aggregate"
        case .pci: return "PCI"
        case .fireWire: return "FireWire"
        case .avb: return "AVB"
        case .unknown: return "Audio device"
        }
    }
}

public struct OutputDevice: Identifiable, Hashable, Sendable {
    public let id: AudioObjectID
    public let uid: String
    public let name: String
    public let transport: DeviceTransport
    public let sampleRate: Double
    public let outputChannels: Int
    public let hasVolumeControl: Bool
    public let hasMuteControl: Bool
    /// Output latency in frames (device + safety offset + buffer), for diagnostics.
    public let latencyFrames: Int

    /// Process-tap playback needs a real device as the aggregate's sub-device. Aggregate and
    /// Multi-Output devices cannot be nested inside AirMix's private aggregates.
    public var supportsPerAppPlayback: Bool { transport != .aggregate }

    public var symbolName: String {
        let lower = name.lowercased()
        if lower.contains("airpods max") { return "airpodsmax" }
        if lower.contains("airpods pro") { return "airpodspro" }
        if lower.contains("airpods") { return "airpods" }
        if lower.contains("beats") || lower.contains("headphone") || lower.contains("headset") { return "headphones" }
        switch transport {
        case .builtIn: return lower.contains("headphone") ? "headphones" : "laptopcomputer"
        case .bluetooth, .bluetoothLE: return "hifispeaker.fill"
        case .airPlay: return "airplayaudio"
        case .hdmi, .displayPort, .thunderbolt: return "display"
        case .usb: return "cable.connector"
        case .virtual: return "waveform"
        case .aggregate: return "square.stack.3d.up.fill"
        default: return "hifispeaker.fill"
        }
    }

    public var latencyMilliseconds: Double { sampleRate > 0 ? Double(latencyFrames) / sampleRate * 1000 : 0 }
}

/// Stateless queries and commands for audio devices.
public enum AudioDevices {
    public static func outputDevices() -> [OutputDevice] {
        CA.objectIDs(systemAudioObject, propertyAddress(kAudioHardwarePropertyDevices)).compactMap(outputDevice(id:))
            .sorted { lhs, rhs in
                if lhs.transport == .builtIn, rhs.transport != .builtIn { return true }
                if rhs.transport == .builtIn, lhs.transport != .builtIn { return false }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
    }

    public static func outputDevice(id: AudioObjectID) -> OutputDevice? {
        guard id != kAudioObjectUnknown else { return nil }
        let channels = CA.channelCount(id, scope: kAudioObjectPropertyScopeOutput)
        guard channels > 0 else { return nil }
        guard let uid = CA.string(id, propertyAddress(kAudioDevicePropertyDeviceUID)) else { return nil }
        if uid.hasPrefix(AppAudioPath.aggregateUIDPrefix) { return nil }
        if (CA.uint32(id, propertyAddress(kAudioDevicePropertyIsHidden)) ?? 0) != 0 { return nil }
        let name = CA.string(id, propertyAddress(kAudioObjectPropertyName)) ?? "Audio Device"
        let transport = DeviceTransport(raw: CA.uint32(id, propertyAddress(kAudioDevicePropertyTransportType)) ?? 0)
        let rate = (try? CA.get(id, propertyAddress(kAudioDevicePropertyNominalSampleRate), Float64(0))) ?? 0
        let out = kAudioObjectPropertyScopeOutput
        let latency = Int(CA.uint32(id, propertyAddress(kAudioDevicePropertyLatency, out)) ?? 0)
            + Int(CA.uint32(id, propertyAddress(kAudioDevicePropertySafetyOffset, out)) ?? 0)
            + Int(CA.uint32(id, propertyAddress(kAudioDevicePropertyBufferFrameSize)) ?? 0)
        return OutputDevice(id: id, uid: uid, name: name, transport: transport, sampleRate: rate,
                            outputChannels: channels, hasVolumeControl: canSetVolume(id), hasMuteControl: canSetMute(id),
                            latencyFrames: latency)
    }

    public static func defaultOutputID() -> AudioObjectID {
        (try? CA.get(systemAudioObject, propertyAddress(kAudioHardwarePropertyDefaultOutputDevice),
                     AudioObjectID(kAudioObjectUnknown))) ?? AudioObjectID(kAudioObjectUnknown)
    }

    /// Changes the system default output device (user-initiated only).
    public static func setDefaultOutput(_ id: AudioObjectID) throws {
        try CA.set(systemAudioObject, propertyAddress(kAudioHardwarePropertyDefaultOutputDevice), id)
    }

    public static func deviceID(forUID uid: String) -> AudioObjectID? {
        var a = propertyAddress(kAudioHardwarePropertyTranslateUIDToDevice)
        var cfUID = uid as CFString
        var id = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafeMutablePointer(to: &cfUID) { q in
            AudioObjectGetPropertyData(systemAudioObject, &a, UInt32(MemoryLayout<CFString>.size), q, &size, &id)
        }
        return status == noErr && id != kAudioObjectUnknown ? id : nil
    }

    public static func isAlive(_ id: AudioObjectID) -> Bool {
        (CA.uint32(id, propertyAddress(kAudioDevicePropertyDeviceIsAlive)) ?? 0) != 0
    }

    // MARK: Volume

    private static let mainVolume = propertyAddress(kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
                                                    kAudioObjectPropertyScopeOutput)
    private static func scalar(_ channel: UInt32) -> AudioObjectPropertyAddress {
        propertyAddress(kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput, channel)
    }
    private static let muteAddress = propertyAddress(kAudioDevicePropertyMute, kAudioObjectPropertyScopeOutput)

    public static func canSetVolume(_ id: AudioObjectID) -> Bool {
        (CA.has(id, mainVolume) && CA.isSettable(id, mainVolume))
            || (CA.has(id, scalar(0)) && CA.isSettable(id, scalar(0)))
            || (CA.has(id, scalar(1)) && CA.isSettable(id, scalar(1)))
    }

    public static func canSetMute(_ id: AudioObjectID) -> Bool {
        CA.has(id, muteAddress) && CA.isSettable(id, muteAddress)
    }

    /// Hardware volume 0…1, or nil when the device has no volume control.
    public static func volume(_ id: AudioObjectID) -> Float? {
        if CA.has(id, mainVolume), let v = try? CA.get(id, mainVolume, Float32(0)) { return v }
        if CA.has(id, scalar(0)), let v = try? CA.get(id, scalar(0), Float32(0)) { return v }
        let channels = [UInt32(1), 2].filter { CA.has(id, scalar($0)) }
        let values = channels.compactMap { try? CA.get(id, scalar($0), Float32(0)) }
        return values.isEmpty ? nil : values.reduce(0, +) / Float(values.count)
    }

    @discardableResult
    public static func setVolume(_ id: AudioObjectID, _ value: Float) -> Bool {
        let v = max(0, min(1, value))
        if CA.has(id, mainVolume), CA.isSettable(id, mainVolume), (try? CA.set(id, mainVolume, Float32(v))) != nil {
            return true
        }
        if CA.has(id, scalar(0)), CA.isSettable(id, scalar(0)), (try? CA.set(id, scalar(0), Float32(v))) != nil {
            return true
        }
        var ok = false
        for ch in [UInt32(1), 2] where CA.has(id, scalar(ch)) && CA.isSettable(id, scalar(ch)) {
            ok = (try? CA.set(id, scalar(ch), Float32(v))) != nil || ok
        }
        return ok
    }

    public static func isMuted(_ id: AudioObjectID) -> Bool {
        (CA.uint32(id, muteAddress) ?? 0) != 0
    }

    @discardableResult
    public static func setMuted(_ id: AudioObjectID, _ muted: Bool) -> Bool {
        guard canSetMute(id) else { return false }
        return (try? CA.set(id, muteAddress, UInt32(muted ? 1 : 0))) != nil
    }

    static var volumeAddresses: [AudioObjectPropertyAddress] { [mainVolume, scalar(0), scalar(1), muteAddress] }
}

/// Observes devices and the default output, event-driven (Core Audio property listeners).
@MainActor
public final class DeviceMonitor: ObservableObject {
    @Published public private(set) var outputs: [OutputDevice] = []
    @Published public private(set) var defaultOutput: OutputDevice?
    /// Hardware volume of the default output (nil if it has none).
    @Published public private(set) var defaultVolume: Float?
    @Published public private(set) var defaultMuted = false

    /// Called after any change (devices added/removed, default changed, sample rate changed).
    public var onChange: ((DeviceChange) -> Void)?

    public enum DeviceChange {
        case devicesChanged(removed: Set<String>, added: Set<String>)
        case defaultOutputChanged
        case formatChanged(uid: String)
        case serviceRestarted
    }

    private var systemListeners: [PropertyListener] = []
    private var deviceListeners: [AudioObjectID: [PropertyListener]] = [:]
    private var volumeListeners: [PropertyListener] = []
    private var pendingRefresh: DispatchWorkItem?

    public init() {}

    public func start() {
        stop()
        let handler: () -> Void = { [weak self] in MainActor.assumeIsolated { self?.scheduleRefresh() } }
        systemListeners = [
            PropertyListener(systemAudioObject, propertyAddress(kAudioHardwarePropertyDevices), handler: handler),
            PropertyListener(systemAudioObject, propertyAddress(kAudioHardwarePropertyDefaultOutputDevice), handler: handler),
            PropertyListener(systemAudioObject, propertyAddress(kAudioHardwarePropertyServiceRestarted)) { [weak self] in
                MainActor.assumeIsolated {
                    self?.start()
                    self?.onChange?(.serviceRestarted)
                }
            },
        ].compactMap { $0 }
        refresh(notify: false)
    }

    public func stop() {
        systemListeners.forEach { $0.invalidate() }
        systemListeners = []
        deviceListeners.values.flatMap { $0 }.forEach { $0.invalidate() }
        deviceListeners = [:]
        volumeListeners.forEach { $0.invalidate() }
        volumeListeners = []
    }

    public func device(uid: String?) -> OutputDevice? {
        guard let uid else { return nil }
        return outputs.first { $0.uid == uid }
    }

    private func scheduleRefresh() {
        pendingRefresh?.cancel()
        let item = DispatchWorkItem { [weak self] in MainActor.assumeIsolated { self?.refresh(notify: true) } }
        pendingRefresh = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: item)
    }

    public func refresh(notify: Bool) {
        let old = outputs
        let oldDefault = defaultOutput?.uid
        let new = AudioDevices.outputDevices()
        outputs = new
        defaultOutput = AudioDevices.outputDevice(id: AudioDevices.defaultOutputID())
        refreshVolume()
        updateDeviceListeners()
        rebindVolumeListeners()

        guard notify else { return }
        let oldUIDs = Set(old.map(\.uid)), newUIDs = Set(new.map(\.uid))
        if oldUIDs != newUIDs {
            onChange?(.devicesChanged(removed: oldUIDs.subtracting(newUIDs), added: newUIDs.subtracting(oldUIDs)))
        }
        for device in new {
            if let previous = old.first(where: { $0.uid == device.uid }), previous.sampleRate != device.sampleRate {
                onChange?(.formatChanged(uid: device.uid))
            }
        }
        if oldDefault != defaultOutput?.uid { onChange?(.defaultOutputChanged) }
    }

    public func refreshVolume() {
        guard let d = defaultOutput else {
            defaultVolume = nil
            defaultMuted = false
            return
        }
        let v = AudioDevices.volume(d.id)
        if v != defaultVolume { defaultVolume = v }
        let m = AudioDevices.isMuted(d.id)
        if m != defaultMuted { defaultMuted = m }
    }

    private func updateDeviceListeners() {
        let ids = Set(outputs.map(\.id))
        for (id, listeners) in deviceListeners where !ids.contains(id) {
            listeners.forEach { $0.invalidate() }
            deviceListeners[id] = nil
        }
        for id in ids where deviceListeners[id] == nil {
            let handler: () -> Void = { [weak self] in MainActor.assumeIsolated { self?.scheduleRefresh() } }
            deviceListeners[id] = [
                PropertyListener(id, propertyAddress(kAudioDevicePropertyNominalSampleRate), handler: handler),
                PropertyListener(id, propertyAddress(kAudioDevicePropertyDeviceIsAlive), handler: handler),
                PropertyListener(id, propertyAddress(kAudioObjectPropertyName), handler: handler),
            ].compactMap { $0 }
        }
    }

    private func rebindVolumeListeners() {
        volumeListeners.forEach { $0.invalidate() }
        volumeListeners = []
        guard let id = defaultOutput?.id else { return }
        for address in AudioDevices.volumeAddresses where CA.has(id, address) {
            if let l = PropertyListener(id, address, handler: { [weak self] in
                MainActor.assumeIsolated { self?.refreshVolume() }
            }) {
                volumeListeners.append(l)
            }
        }
    }
}
