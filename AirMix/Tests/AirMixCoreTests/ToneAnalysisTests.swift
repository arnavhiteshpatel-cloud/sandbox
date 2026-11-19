@testable import AirMixCore
import AirMixDSP
import Foundation
import XCTest

final class ToneAnalysisTests: XCTestCase {
    func testSeparatesTwoTonesAtDifferentLevels() {
        let fs = 48000.0
        let x: [Float] = (0..<48000).map { i in
            let t = Double(i) / fs
            return Float(0.25 * sin(2 * .pi * 440 * t) + 0.05 * sin(2 * .pi * 660 * t))
        }
        XCTAssertEqual(ToneAnalysis.amplitude(of: 440, in: x, sampleRate: fs), 0.25, accuracy: 0.005)
        XCTAssertEqual(ToneAnalysis.amplitude(of: 660, in: x, sampleRate: fs), 0.05, accuracy: 0.005)
        XCTAssertLessThan(ToneAnalysis.amplitude(of: 1000, in: x, sampleRate: fs), 0.002)
    }

    func testWAVWriter() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("airmix-tone-\(UUID()).wav")
        defer { try? FileManager.default.removeItem(at: url) }
        try ToneAnalysis.writeToneWAV(to: url, frequency: 440, seconds: 0.5, amplitude: 0.25)
        let d = try Data(contentsOf: url)
        XCTAssertEqual(d.count, 44 + 24000 * 4)
        XCTAssertEqual(String(decoding: d.prefix(4), as: UTF8.self), "RIFF")
    }

    /// Simulates the self-test signal chain: two "apps" (tones) each go through their own
    /// processor with a different gain, the device mixes them, and the recorder captures the mix.
    func testIndependentGainsSurviveMixingAndRecording() {
        let fs = 48000.0, frames = 512
        let a = AudioProcessor(sampleRate: fs), b = AudioProcessor(sampleRate: fs)
        a.setGain(0.25, immediate: true)
        b.setGain(1.0, immediate: true)
        guard let rec = amx_recorder_create(48000) else { return XCTFail() }
        defer { amx_recorder_destroy(rec) }
        var phase = 0
        while amx_recorder_frames(rec) < 48000 {
            var ta = [Float](repeating: 0, count: frames * 2), tb = ta
            for f in 0..<frames {
                let t = Double(phase + f) / fs
                ta[2 * f] = Float(0.4 * sin(2 * .pi * 440 * t)); ta[2 * f + 1] = ta[2 * f]
                tb[2 * f] = Float(0.4 * sin(2 * .pi * 660 * t)); tb[2 * f + 1] = tb[2 * f]
            }
            phase += frames
            func render(_ proc: AudioProcessor, _ tap: [Float]) -> [Float] {
                var input = tap, output = [Float](repeating: 0, count: tap.count)
                input.withUnsafeMutableBytes { ib in output.withUnsafeMutableBytes { ob in
                    var ins = [amx_buffer(channels: 2, byte_size: UInt32(ib.count), data: ib.baseAddress)]
                    var outs = [amx_buffer(channels: 2, byte_size: UInt32(ob.count), data: ob.baseAddress)]
                    amx_process_buffers(proc.raw, &ins, 1, &outs, 1)
                } }
                return output
            }
            var mix = zip(render(a, ta), render(b, tb)).map { $0 + $1 }
            mix.withUnsafeMutableBytes { m in
                var ins = [amx_buffer(channels: 2, byte_size: UInt32(m.count), data: m.baseAddress)]
                amx_recorder_write(rec, &ins, 1)
            }
        }
        let rec440 = UnsafeBufferPointer(start: amx_recorder_data(rec), count: Int(amx_recorder_frames(rec)))
        let a440 = ToneAnalysis.amplitude(of: 440, in: rec440, sampleRate: fs)
        let a660 = ToneAnalysis.amplitude(of: 660, in: rec440, sampleRate: fs)
        XCTAssertEqual(a440, 0.1, accuracy: 0.003)
        XCTAssertEqual(a660, 0.4, accuracy: 0.01)
        XCTAssertEqual(20 * log10(a440 / a660), -12.04, accuracy: 0.3)
    }
}
