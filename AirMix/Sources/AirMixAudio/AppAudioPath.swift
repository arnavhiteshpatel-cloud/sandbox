import AirMixCore
import AirMixDSP
import CoreAudio
import Foundation

/// The live audio path for one app:
///
///     app processes ──▶ process tap (muted while tapped) ──▶ private aggregate device
///                                                             (output device as clock + sub-device)
///                                                                    │  I/O proc (C, real-time)
///                                                                    ▼  gain · EQ · limiter · meters
///                                                              output device
///
/// Because the tap uses `.mutedWhenTapped`, the app's own audio only stays silent while this I/O
/// proc is reading it. If AirMix stops, stalls or crashes, macOS plays the app normally again —
/// no audio is ever lost and nothing system-wide is reconfigured.
@MainActor
public final class AppAudioPath {
    nonisolated public static let aggregateUIDPrefix = "com.airmix.aggregate."

    public let appKey: String
    public let processor: AudioProcessor
    public let output: OutputDevice
    public private(set) var processObjectIDs: [AudioObjectID]
    public private(set) var tapID = AudioObjectID(kAudioObjectUnknown)
    public private(set) var aggregateID = AudioObjectID(kAudioObjectUnknown)
    public private(set) var isRunning = false
    public private(set) var sampleRate: Double
    public private(set) var tapFormat = AudioStreamBasicDescription()
    public let createdAt = Date()

    private var ioProcID: AudioDeviceIOProcID?
    private var tapDescription: CATapDescription?
    /// EQ last pushed to the processor (avoids redundant coefficient uploads).
    var appliedEQ: EQSettings?
    // Health monitoring
    var lastCallbackCount: UInt32 = 0
    var stalledChecks = 0

    public init(appKey: String, processObjectIDs: [AudioObjectID], output: OutputDevice) throws {
        self.appKey = appKey
        self.processObjectIDs = processObjectIDs
        self.output = output
        self.sampleRate = output.sampleRate > 0 ? output.sampleRate : 48000
        self.processor = AudioProcessor(sampleRate: sampleRate)
        processor.setGain(0, immediate: true)   // start silent; the engine ramps up to the target
        do {
            try build()
        } catch {
            stop()
            throw error
        }
    }

    private func build() throws {
        // 1. Tap: stereo mix of all of the app's processes, private to AirMix.
        let description = CATapDescription(stereoMixdownOfProcesses: processObjectIDs)
        description.uuid = UUID()
        description.name = "AirMix \(appKey)"
        description.isPrivate = true
        description.muteBehavior = .mutedWhenTapped
        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &tap), "Creating the audio tap for \(appKey)")
        tapID = tap
        tapDescription = description
        tapFormat = (try? CA.get(tap, propertyAddress(kAudioTapPropertyFormat), AudioStreamBasicDescription())) ?? tapFormat
        let tapUID = CA.string(tap, propertyAddress(kAudioTapPropertyUID)) ?? description.uuid.uuidString

        // 2. Private aggregate: the real output device (clock) + the tap as an input stream.
        //    Drift compensation is off on Bluetooth outputs, where it causes periodic crackles.
        let composition: [String: Any] = [
            kAudioAggregateDeviceNameKey: "AirMix \(appKey)",
            kAudioAggregateDeviceUIDKey: Self.aggregateUIDPrefix + UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: output.uid,
            kAudioAggregateDeviceClockDeviceKey: output.uid,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: output.uid,
                                                     kAudioSubDeviceDriftCompensationKey: false]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID,
                                               kAudioSubTapDriftCompensationKey: !output.transport.isBluetooth]],
        ]
        var aggregate = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggregate),
                  "Creating the playback device for \(appKey)")
        aggregateID = aggregate
        waitUntilAlive(aggregate)

        if let rate = try? CA.get(aggregate, propertyAddress(kAudioDevicePropertyNominalSampleRate), Float64(0)), rate > 0 {
            sampleRate = rate
            processor.setSampleRate(rate)
        }

        // 3. Real-time I/O proc (pure C) with the processor as client data.
        var proc: AudioDeviceIOProcID?
        try check(amx_create_ioproc(aggregate, processor.raw, &proc), "Creating the audio callback for \(appKey)")
        ioProcID = proc
        // A duplex output (e.g. USB headset) also exposes its microphone as aggregate input; switch
        // those streams off so AirMix never opens a microphone. The tap is the last input stream.
        let inputStreams = CA.objectIDs(aggregate, propertyAddress(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput))
        if inputStreams.count > 1, let proc {
            _ = amx_keep_trailing_input_streams(aggregate, proc, 1)
        }

        // 4. Go.
        try check(AudioDeviceStart(aggregate, proc), "Starting audio for \(appKey)")
        isRunning = true
        lastCallbackCount = processor.callbackCount
    }

    private func waitUntilAlive(_ device: AudioObjectID) {
        for _ in 0..<40 {
            if AudioDevices.isAlive(device) { return }
            usleep(5_000)
        }
    }

    /// Updates the tapped process set on the live tap (no rebuild, no gap). Returns false if
    /// Core Audio refused, in which case the caller rebuilds the path.
    public func updateProcesses(_ ids: [AudioObjectID]) -> Bool {
        guard let description = tapDescription, tapID != kAudioObjectUnknown else { return false }
        description.processes = ids
        var address = propertyAddress(kAudioTapPropertyDescription)
        var ref: CATapDescription = description
        let status = withUnsafeMutablePointer(to: &ref) { ptr in
            AudioObjectSetPropertyData(tapID, &address, 0, nil, UInt32(MemoryLayout<CATapDescription>.stride), ptr)
        }
        if status == noErr {
            processObjectIDs = ids
            return true
        }
        return false
    }

    /// Tears down in the order Core Audio expects: stop I/O, remove the callback (waits for any
    /// in-flight callback to finish), destroy the aggregate, destroy the tap.
    public func stop() {
        if aggregateID != kAudioObjectUnknown {
            if let proc = ioProcID {
                if isRunning { AudioDeviceStop(aggregateID, proc) }
                AudioDeviceDestroyIOProcID(aggregateID, proc)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
        }
        ioProcID = nil
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        tapID = AudioObjectID(kAudioObjectUnknown)
        tapDescription = nil
        isRunning = false
    }

    /// Additional output latency introduced by AirMix's path, in milliseconds (one I/O buffer of
    /// the aggregate plus its safety offset). Reported in diagnostics.
    public var addedLatencyMilliseconds: Double {
        guard aggregateID != kAudioObjectUnknown, sampleRate > 0 else { return 0 }
        let buffer = Double(CA.uint32(aggregateID, propertyAddress(kAudioDevicePropertyBufferFrameSize)) ?? 0)
        let safety = Double(CA.uint32(aggregateID, propertyAddress(kAudioDevicePropertySafetyOffset, kAudioObjectPropertyScopeInput)) ?? 0)
        return (buffer + safety) / sampleRate * 1000
    }

    /// Destroys aggregates left behind by an earlier AirMix process (e.g. after a crash), if any are
    /// visible. Private aggregates of a dead process are normally removed by macOS already.
    public static func cleanUpLeftovers() -> Int {
        var removed = 0
        for id in CA.objectIDs(systemAudioObject, propertyAddress(kAudioHardwarePropertyDevices)) {
            if let uid = CA.string(id, propertyAddress(kAudioDevicePropertyDeviceUID)), uid.hasPrefix(aggregateUIDPrefix) {
                if AudioHardwareDestroyAggregateDevice(id) == noErr { removed += 1 }
            }
        }
        return removed
    }
}
