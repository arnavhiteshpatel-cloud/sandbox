import AirMixDSP
import Foundation
import XCTest

private let fs = 48000.0

private func sine(_ freq: Double, amp: Float = 0.5, frames: Int, phase: Double = 0) -> [Float] {
    (0..<frames).map { Float(Double(amp) * sin(2 * .pi * freq * Double($0) / fs + phase)) }
}

private func peak(_ x: ArraySlice<Float>) -> Float { x.map(abs).max() ?? 0 }

/// Processes planar stereo in blocks of 512 like a real I/O cycle.
private func process(_ p: OpaquePointer, _ l: [Float], _ r: [Float], block: Int = 512) -> ([Float], [Float]) {
    var ol = [Float](repeating: 0, count: l.count), or = ol
    var i = 0
    while i < l.count {
        let n = min(block, l.count - i)
        l.withUnsafeBufferPointer { lb in r.withUnsafeBufferPointer { rb in
            ol.withUnsafeMutableBufferPointer { olb in or.withUnsafeMutableBufferPointer { orb in
                amx_process_stereo(p, lb.baseAddress! + i, rb.baseAddress! + i, olb.baseAddress! + i, orb.baseAddress! + i, UInt32(n))
            } }
        } }
        i += n
    }
    return (ol, or)
}

final class DSPKernelTests: XCTestCase {
    func testUnityGainIsBitTransparentWhenLimiterIdle() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        let x = sine(440, amp: 0.5, frames: 4800)
        let (l, r) = process(p, x, x)
        XCTAssertEqual(l, x)
        XCTAssertEqual(r, x)
    }

    func testGainScalesSignal() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        amx_set_gain_immediate(p, 0.25)
        let x = sine(440, amp: 0.8, frames: 9600)
        let (l, _) = process(p, x, x)
        XCTAssertEqual(peak(l[4800...]), 0.2, accuracy: 0.001)
    }

    /// The core claim of AirMix: two apps' streams are processed by independent processors, so
    /// changing one gain never affects the other stream.
    func testTwoStreamsAreIndependent() {
        let a = amx_processor_create(fs)!, b = amx_processor_create(fs)!
        defer { amx_processor_destroy(a); amx_processor_destroy(b) }
        let xa = sine(440, amp: 0.5, frames: 9600), xb = sine(660, amp: 0.5, frames: 9600)
        amx_set_gain_immediate(a, 0.1)
        amx_set_gain_immediate(b, 1.0)
        let (la, _) = process(a, xa, xa), (lb, _) = process(b, xb, xb)
        XCTAssertEqual(peak(la[4800...]), 0.05, accuracy: 0.001)
        XCTAssertEqual(peak(lb[4800...]), 0.5, accuracy: 0.001)
        // Mute A only.
        amx_set_gain(a, 0)
        let (la2, _) = process(a, xa, xa), (lb2, _) = process(b, xb, xb)
        XCTAssertEqual(peak(la2[7200...]), 0, "muted app is fully silent after 150 ms")
        XCTAssertEqual(peak(lb2[4800...]), 0.5, accuracy: 0.001)
    }

    func testGainChangesAreSmoothNoClicks() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        let dc = [Float](repeating: 0.5, count: 9600)
        _ = process(p, dc, dc)
        amx_set_gain(p, 0)   // mute while "playing" a constant signal
        let (l, _) = process(p, dc, dc)
        var maxStep: Float = 0
        for i in 1..<l.count { maxStep = max(maxStep, abs(l[i] - l[i - 1])) }
        // A hard switch would step by 0.5; the 12 ms ramp moves < 0.2 % per sample.
        XCTAssertLessThan(maxStep, 0.001)
        XCTAssertLessThan(abs(l[l.count - 1]), 1e-4, "should reach silence within 200 ms")
        XCTAssertGreaterThan(l[100], 0.3, "should not jump instantly")
    }

    func testPeakingEQMatchesDesignedResponse() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        var band = amx_design(AMX_PEAKING, fs, 1000, 1.0, 6.0)
        amx_set_eq(p, &band, 1, 1.0)
        amx_set_eq_enabled(p, true)
        amx_set_limiter(p, false, 1)
        let x = sine(1000, amp: 0.25, frames: 48000)
        let (l, _) = process(p, x, x)
        let measuredDB = 20 * log10(Double(peak(l[24000...])) / 0.25)
        XCTAssertEqual(measuredDB, 6.0, accuracy: 0.1)
        XCTAssertEqual(amx_cascade_magnitude_db(&band, 1, fs, 1000), 6.0, accuracy: 0.001)
        // Far from the centre the bell is ~flat.
        XCTAssertEqual(amx_cascade_magnitude_db(&band, 1, fs, 50), 0.0, accuracy: 0.2)
    }

    func testShelvesAndPassFilters() {
        var ls = amx_design(AMX_LOW_SHELF, fs, 100, 0.71, 6)
        XCTAssertEqual(amx_cascade_magnitude_db(&ls, 1, fs, 20), 6, accuracy: 0.3)
        XCTAssertEqual(amx_cascade_magnitude_db(&ls, 1, fs, 5000), 0, accuracy: 0.1)
        var hs = amx_design(AMX_HIGH_SHELF, fs, 8000, 0.71, -6)
        XCTAssertEqual(amx_cascade_magnitude_db(&hs, 1, fs, 20000), -6, accuracy: 0.5)
        var lp = amx_design(AMX_LOW_PASS, fs, 1000, 0.7071, 0)
        XCTAssertEqual(amx_cascade_magnitude_db(&lp, 1, fs, 1000), -3.01, accuracy: 0.05)
        XCTAssertLessThan(amx_cascade_magnitude_db(&lp, 1, fs, 10000), -35)
        var hp = amx_design(AMX_HIGH_PASS, fs, 1000, 0.7071, 0)
        XCTAssertLessThan(amx_cascade_magnitude_db(&hp, 1, fs, 100), -35)
    }

    func testEQBypassCrossfadeHasNoDiscontinuity() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        var band = amx_design(AMX_PEAKING, fs, 200, 1.0, 12.0)
        amx_set_eq(p, &band, 1, 1.0)
        amx_set_limiter(p, false, 1)
        let x = sine(200, amp: 0.1, frames: 4800)
        _ = process(p, x, x)
        amx_set_eq_enabled(p, true)
        let (on, _) = process(p, x, x)
        var maxStep: Float = 0
        for i in 1..<on.count { maxStep = max(maxStep, abs(on[i] - on[i - 1])) }
        // A 200 Hz sine at +12 dB (amp ≈ 0.4) moves at most 0.4·2π·200/48000 ≈ 0.0105 per sample.
        XCTAssertLessThan(maxStep, 0.0125)
    }

    func testLimiterPreventsClippingWhenBoosted() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        amx_set_gain_immediate(p, 4.0)   // +12 dB boost on a −6 dBFS signal → would hit 2.0
        let x = sine(440, amp: 0.5, frames: 9600)
        let (l, r) = process(p, x, x)
        XCTAssertLessThanOrEqual(peak(l[...]), 0.98 + 1e-6)
        XCTAssertLessThanOrEqual(peak(r[...]), 0.98 + 1e-6)
        XCTAssertGreaterThan(peak(l[4800...]), 0.9, "boost should still be loud")
        var m = amx_meters()
        amx_read_meters(p, &m)
        XCTAssertGreaterThan(m.clip_events, 0)
        amx_read_meters(p, &m)
        XCTAssertEqual(m.clip_events, 0, "clip counter resets after reading")
    }

    func testStereoSeparationPreserved() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        var band = amx_design(AMX_PEAKING, fs, 1000, 1.0, 3.0)
        amx_set_eq(p, &band, 1, 1.0)
        amx_set_eq_enabled(p, true)
        let l = sine(440, amp: 0.5, frames: 4800), r = [Float](repeating: 0, count: 4800)
        let (_, outR) = process(p, l, r)
        XCTAssertEqual(peak(outR[...]), 0, "nothing may leak from left into right")
    }

    func testBufferListInterleavedTapAfterDeviceInput() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        amx_set_gain_immediate(p, 0.5)
        let frames = 256
        // Buffer 0: a sub-device's own input (e.g. headset mic, 1 ch). Buffer 1: the tap, stereo interleaved.
        var mic = [Float](repeating: 0.9, count: frames)
        var tap = [Float](repeating: 0, count: frames * 2)
        for f in 0..<frames { tap[2 * f] = 0.4; tap[2 * f + 1] = -0.2 }
        var out = [Float](repeating: 7, count: frames * 4)  // 4-channel interleaved device, garbage-filled
        mic.withUnsafeMutableBytes { micB in tap.withUnsafeMutableBytes { tapB in out.withUnsafeMutableBytes { outB in
            var ins = [amx_buffer(channels: 1, byte_size: UInt32(micB.count), data: micB.baseAddress),
                       amx_buffer(channels: 2, byte_size: UInt32(tapB.count), data: tapB.baseAddress)]
            var outs = [amx_buffer(channels: 4, byte_size: UInt32(outB.count), data: outB.baseAddress)]
            amx_process_buffers(p, &ins, 2, &outs, 1)
        } } }
        for f in 0..<frames {
            XCTAssertEqual(out[4 * f], 0.2, accuracy: 1e-6)
            XCTAssertEqual(out[4 * f + 1], -0.1, accuracy: 1e-6)
            XCTAssertEqual(out[4 * f + 2], 0)
            XCTAssertEqual(out[4 * f + 3], 0)
        }
    }

    func testBufferListSplitMonoOutputsAndMonoDevice() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        let frames = 128
        var tap = [Float](repeating: 0, count: frames * 2)
        for f in 0..<frames { tap[2 * f] = 0.3; tap[2 * f + 1] = 0.1 }
        var o1 = [Float](repeating: 9, count: frames), o2 = [Float](repeating: 9, count: frames)
        tap.withUnsafeMutableBytes { t in o1.withUnsafeMutableBytes { a in o2.withUnsafeMutableBytes { b in
            var ins = [amx_buffer(channels: 2, byte_size: UInt32(t.count), data: t.baseAddress)]
            var outs = [amx_buffer(channels: 1, byte_size: UInt32(a.count), data: a.baseAddress),
                        amx_buffer(channels: 1, byte_size: UInt32(b.count), data: b.baseAddress)]
            amx_process_buffers(p, &ins, 1, &outs, 2)
        } } }
        XCTAssertEqual(o1[10], 0.3, accuracy: 1e-6)
        XCTAssertEqual(o2[10], 0.1, accuracy: 1e-6)

        var mono = [Float](repeating: 9, count: frames)
        tap.withUnsafeMutableBytes { t in mono.withUnsafeMutableBytes { m in
            var ins = [amx_buffer(channels: 2, byte_size: UInt32(t.count), data: t.baseAddress)]
            var outs = [amx_buffer(channels: 1, byte_size: UInt32(m.count), data: m.baseAddress)]
            amx_process_buffers(p, &ins, 1, &outs, 1)
        } }
        XCTAssertEqual(mono[10], 0.2, accuracy: 1e-6)
    }

    func testMissingInputProducesSilenceNotGarbage() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        var out = [Float](repeating: 5, count: 512)
        out.withUnsafeMutableBytes { o in
            var outs = [amx_buffer(channels: 2, byte_size: UInt32(o.count), data: o.baseAddress)]
            amx_process_buffers(p, nil, 0, &outs, 1)
        }
        XCTAssertTrue(out.allSatisfy { $0 == 0 })
    }

    func testConcurrentEQUpdatesWhileProcessing() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        amx_set_eq_enabled(p, true)
        let done = DispatchSemaphore(value: 0)
        let pp = UnsafeMutableRawPointer(p)
        var bad = false
        Thread {
            let p = OpaquePointer(pp)
            var l = sine(1000, amp: 0.5, frames: 512), r = l
            for _ in 0..<4000 {
                amx_process_stereo(p, l, r, &l, &r, 512)
                if l.contains(where: { !$0.isFinite }) { bad = true }
                l = sine(1000, amp: 0.5, frames: 512); r = l
            }
            done.signal()
        }.start()
        for i in 0..<20000 {
            var bands = (0..<8).map { k in amx_design(AMX_PEAKING, fs, 100 * Double(k + 1), 1, Double(i % 13) - 6) }
            amx_set_eq(p, &bands, Int32(i % 9), 0.7)
            amx_set_gain(p, Float(i % 10) / 10)
        }
        done.wait()
        XCTAssertFalse(bad)
    }

    func testLowFrequencyShelfStableAtHighSampleRate() {
        let rate = 192000.0
        let p = amx_processor_create(rate)!; defer { amx_processor_destroy(p) }
        var band = amx_design(AMX_LOW_SHELF, rate, 20, 0.71, 12)
        amx_set_eq(p, &band, 1, 0.25)
        amx_set_eq_enabled(p, true)
        var x = [Float](repeating: 0, count: 192000)
        x[0] = 1  // impulse
        let (l, _) = process(p, x, x)
        XCTAssertTrue(l.allSatisfy { $0.isFinite })
        XCTAssertLessThan(abs(l[l.count - 1]), 1e-3, "impulse response must decay")
    }

    func testVoiceBandDetector() {
        func ratio(_ x: [Float]) -> Float {
            let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
            amx_set_voice_detection(p, true)
            _ = process(p, x, x)
            var m = amx_meters(); amx_read_meters(p, &m)
            return m.voice_ratio
        }
        XCTAssertGreaterThan(ratio(sine(1000, frames: 24000)), 0.8)
        XCTAssertLessThan(ratio(sine(60, frames: 24000)), 0.1)
        XCTAssertLessThan(ratio(sine(9000, frames: 24000)), 0.2)
    }

    func testMetersReportPostGainPeakAndPreGainRMS() {
        let p = amx_processor_create(fs)!; defer { amx_processor_destroy(p) }
        amx_set_gain_immediate(p, 0.1)
        let x = sine(1000, amp: 0.5, frames: 9600)
        _ = process(p, x, x)
        var m = amx_meters(); amx_read_meters(p, &m)
        XCTAssertEqual(m.peak_left, 0.05, accuracy: 0.001)
        XCTAssertEqual(m.input_rms, 0.5 / sqrt(2), accuracy: 0.01, "trigger level ignores the app's own volume")
        XCTAssertEqual(m.frames, 9600)
        amx_read_meters(p, &m)
        XCTAssertEqual(m.peak_left, 0, "peak resets after read")
    }
}
