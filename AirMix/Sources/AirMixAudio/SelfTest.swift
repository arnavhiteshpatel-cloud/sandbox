import AirMixCore
import AirMixDSP
import CoreAudio
import Foundation

/// End-to-end proof that two simultaneously playing processes get independent volume control.
///
/// 1. Two `/usr/bin/afplay` processes play a 440 Hz and a 660 Hz tone at the same level.
/// 2. AirMix taps each one with its own audio path (exactly the code the mixer uses) and applies
///    different gains: (25 %, 100 %), then (100 %, 25 %), then (muted, 100 %).
/// 3. A separate, un-muted measurement tap records everything the system plays *except* the two
///    tone processes' original (muted) audio — i.e. what AirMix actually delivered to the output.
/// 4. Each tone's level in that recording is measured (Goertzel) and compared with the expectation.
///
/// The tones are audible on your output device while the test runs (≈8 s).
@MainActor
public final class IndependenceTest {
    public struct Phase: Codable, Hashable {
        public var gainA: Double
        public var gainB: Double
        public var expectedDifferenceDB: Double?
        public var measured440: Double
        public var measured660: Double
        public var measuredDifferenceDB: Double
        public var meterPeakA: Double
        public var meterPeakB: Double
        public var passed: Bool
    }

    public struct Report: Codable {
        public var passed: Bool
        public var conclusive: Bool
        public var outputDevice: String
        public var sampleRate: Double
        public var phases: [Phase]
        public var notes: [String]
        public var json: String {
            let e = JSONEncoder()
            e.outputFormatting = [.prettyPrinted, .sortedKeys]
            return (try? e.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        }
    }

    private let engine: AudioEngine
    public init(engine: AudioEngine) { self.engine = engine }

    public func run() async -> Report {
        var notes: [String] = []
        let fail = { (msg: String) -> Report in
            Report(passed: false, conclusive: false, outputDevice: "", sampleRate: 0, phases: [], notes: notes + [msg])
        }
        guard let device = engine.devices.defaultOutput else { return fail("No output device.") }
        guard device.supportsPerAppPlayback else { return fail("The default output (\(device.name)) is an aggregate/Multi-Output device; choose a real device.") }

        // Tone files.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("AirMixSelfTest-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fileA = dir.appendingPathComponent("a440.wav"), fileB = dir.appendingPathComponent("b660.wav")
        do {
            try ToneAnalysis.writeToneWAV(to: fileA, frequency: 440, seconds: 14, amplitude: 0.3)
            try ToneAnalysis.writeToneWAV(to: fileB, frequency: 660, seconds: 14, amplitude: 0.3)
        } catch { return fail("Could not write test tones: \(error.localizedDescription)") }

        // Players.
        let players = [Process(), Process()]
        for (p, f) in zip(players, [fileA, fileB]) {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
            p.arguments = [f.path]
        }
        do { for p in players { try p.run() } } catch { return fail("Could not start afplay: \(error.localizedDescription)") }
        let pids = Set(players.map(\.processIdentifier))
        engine.processes.excludedPIDs.formUnion(pids)
        defer {
            for p in players where p.isRunning { p.terminate() }
            engine.processes.excludedPIDs.subtract(pids)
        }

        // Wait for both processes to appear as running audio output.
        var objA: AudioObjectID?, objB: AudioObjectID?
        for _ in 0..<60 {
            engine.processes.refresh()
            let entries = engine.processes.entries
            objA = entries.first { $0.pid == players[0].processIdentifier && $0.isRunningOutput }?.objectID
            objB = entries.first { $0.pid == players[1].processIdentifier && $0.isRunningOutput }?.objectID
            if objA != nil && objB != nil { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        guard let objA, let objB else { return fail("The test tones never appeared as audio processes.") }

        // AirMix paths for each player (same code path as the mixer).
        let pathA: AppAudioPath, pathB: AppAudioPath
        do {
            pathA = try AppAudioPath(appKey: "selftest.440", processObjectIDs: [objA], output: device)
            pathB = try AppAudioPath(appKey: "selftest.660", processObjectIDs: [objB], output: device)
        } catch { return fail("Could not create audio paths: \(error.localizedDescription)") }
        defer { pathA.stop(); pathB.stop() }

        // Measurement tap: everything except the two players' own (muted) streams.
        let measurement: Measurement
        do { measurement = try Measurement(excluding: [objA, objB], device: device) } catch {
            return fail("Could not create the measurement tap: \(error.localizedDescription)")
        }
        defer { measurement.stop() }

        let plan: [(Double, Double)] = [(0.25, 1.0), (1.0, 0.25), (0.0, 1.0)]
        var phases: [Phase] = []
        for (ga, gb) in plan {
            pathA.processor.setGain(ga, immediate: true)
            pathB.processor.setGain(gb, immediate: true)
            try? await Task.sleep(nanoseconds: 300_000_000)
            _ = pathA.processor.readMeters(); _ = pathB.processor.readMeters()
            guard let samples = await measurement.record(seconds: 1.5) else {
                notes.append("Measurement timed out (no audio callbacks).")
                break
            }
            let ma = pathA.processor.readMeters().peak, mb = pathB.processor.readMeters().peak
            let a = ToneAnalysis.amplitude(of: 440, in: samples, sampleRate: measurement.sampleRate)
            let b = ToneAnalysis.amplitude(of: 660, in: samples, sampleRate: measurement.sampleRate)
            let diff = 20 * log10(max(a, 1e-9) / max(b, 1e-9))
            let expected: Double? = ga > 0 && gb > 0 ? 20 * log10(ga / gb) : nil
            let passed: Bool
            if let expected {
                passed = abs(diff - expected) <= 1.5
            } else {
                passed = diff < -40   // muted tone at least 40 dB below the other
            }
            phases.append(Phase(gainA: ga, gainB: gb, expectedDifferenceDB: expected, measured440: a, measured660: b,
                                measuredDifferenceDB: diff, meterPeakA: ma, meterPeakB: mb, passed: passed))
        }

        let conclusive = phases.count == plan.count && phases.allSatisfy { max($0.measured440, $0.measured660) > 1e-3 }
        if !conclusive {
            notes.append("The system-output capture did not contain the processed tones (is System Audio Recording allowed for AirMix?). Meter values show what AirMix wrote to the device.")
        }
        // Meter cross-check: what AirMix wrote to the device must follow the gains (tone peak 0.3).
        for p in phases {
            let okA = abs(p.meterPeakA - 0.3 * p.gainA) < 0.03, okB = abs(p.meterPeakB - 0.3 * p.gainB) < 0.03
            if !(okA && okB) { notes.append(String(format: "Meter check off for gains %.2f/%.2f: %.3f/%.3f", p.gainA, p.gainB, p.meterPeakA, p.meterPeakB)) }
        }
        let passed = conclusive && phases.allSatisfy(\.passed)
        return Report(passed: passed, conclusive: conclusive, outputDevice: device.name, sampleRate: measurement.sampleRate,
                      phases: phases, notes: notes)
    }

    /// Un-muted global tap (minus excluded processes) recorded through a private aggregate.
    @MainActor
    final class Measurement {
        private var tapID = AudioObjectID(kAudioObjectUnknown)
        private var aggregateID = AudioObjectID(kAudioObjectUnknown)
        private var procID: AudioDeviceIOProcID?
        private var recorder: OpaquePointer?
        private(set) var sampleRate: Double
        private var running = false

        init(excluding processes: [AudioObjectID], device: OutputDevice) throws {
            sampleRate = device.sampleRate
            let d = CATapDescription(stereoGlobalTapButExcludeProcesses: processes)
            d.uuid = UUID()
            d.name = "AirMix self-test measurement"
            d.isPrivate = true
            d.muteBehavior = .unmuted
            var tap = AudioObjectID(kAudioObjectUnknown)
            try check(AudioHardwareCreateProcessTap(d, &tap), "Creating measurement tap")
            tapID = tap
            let tapUID = CA.string(tap, propertyAddress(kAudioTapPropertyUID)) ?? d.uuid.uuidString
            let composition: [String: Any] = [
                kAudioAggregateDeviceNameKey: "AirMix self-test",
                kAudioAggregateDeviceUIDKey: AppAudioPath.aggregateUIDPrefix + "selftest." + UUID().uuidString,
                kAudioAggregateDeviceMainSubDeviceKey: device.uid,
                kAudioAggregateDeviceIsPrivateKey: true,
                kAudioAggregateDeviceIsStackedKey: false,
                kAudioAggregateDeviceTapAutoStartKey: false,
                kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: device.uid]],
                kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: true]],
            ]
            var agg = AudioObjectID(kAudioObjectUnknown)
            do {
                try check(AudioHardwareCreateAggregateDevice(composition as CFDictionary, &agg), "Creating measurement device")
                aggregateID = agg
                if let r = try? CA.get(agg, propertyAddress(kAudioDevicePropertyNominalSampleRate), Float64(0)), r > 0 { sampleRate = r }
                recorder = amx_recorder_create(UInt32(sampleRate * 2))
                var proc: AudioDeviceIOProcID?
                try check(amx_create_recorder_ioproc(agg, recorder, &proc), "Creating measurement callback")
                procID = proc
            } catch {
                stop()
                throw error
            }
        }

        func record(seconds: Double) async -> [Float]? {
            guard let recorder, let procID else { return nil }
            if running { AudioDeviceStop(aggregateID, procID); running = false }
            amx_recorder_reset(recorder)
            guard AudioDeviceStart(aggregateID, procID) == noErr else { return nil }
            running = true
            let want = UInt32(min(seconds, 2) * sampleRate)
            for _ in 0..<60 {
                if amx_recorder_frames(recorder) >= want { break }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            AudioDeviceStop(aggregateID, procID)
            running = false
            let n = Int(amx_recorder_frames(recorder))
            guard n > Int(sampleRate * 0.25), let data = amx_recorder_data(recorder) else { return nil }
            return Array(UnsafeBufferPointer(start: data, count: n))
        }

        func stop() {
            if aggregateID != kAudioObjectUnknown {
                if let procID {
                    if running { AudioDeviceStop(aggregateID, procID) }
                    AudioDeviceDestroyIOProcID(aggregateID, procID)
                }
                AudioHardwareDestroyAggregateDevice(aggregateID)
            }
            if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
            if let recorder { amx_recorder_destroy(recorder) }
            recorder = nil
            procID = nil
            running = false
            aggregateID = AudioObjectID(kAudioObjectUnknown)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }
}
