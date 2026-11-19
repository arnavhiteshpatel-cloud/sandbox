import Foundation

/// Measures the amplitude of individual sine tones in a recording (Goertzel algorithm with a Hann
/// window). Used by the end-to-end self test: two test processes play different tones, AirMix
/// processes them with different gains, and the mixed output is measured per tone.
public enum ToneAnalysis {
    /// Approximate peak amplitude of a sine at `frequency` in `samples`.
    public static func amplitude(of frequency: Double, in samples: UnsafeBufferPointer<Float>, sampleRate: Double) -> Double {
        let n = samples.count
        guard n > 16 else { return 0 }
        let w = 2 * Double.pi * frequency / sampleRate
        let coeff = 2 * cos(w)
        var s1 = 0.0, s2 = 0.0, windowSum = 0.0
        for i in 0..<n {
            let hann = 0.5 - 0.5 * cos(2 * Double.pi * Double(i) / Double(n - 1))
            windowSum += hann
            let s0 = Double(samples[i]) * hann + coeff * s1 - s2
            s2 = s1
            s1 = s0
        }
        let power = s1 * s1 + s2 * s2 - coeff * s1 * s2
        return 2 * sqrt(max(0, power)) / windowSum
    }

    public static func amplitude(of frequency: Double, in samples: [Float], sampleRate: Double) -> Double {
        samples.withUnsafeBufferPointer { amplitude(of: frequency, in: $0, sampleRate: sampleRate) }
    }

    /// Writes a 16-bit stereo PCM WAV file containing a sine tone.
    public static func writeToneWAV(to url: URL, frequency: Double, seconds: Double, amplitude: Double,
                                    sampleRate: Int = 48000) throws {
        let frames = Int(seconds * Double(sampleRate))
        var data = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let dataBytes = UInt32(frames * 4)
        data.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataBytes)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(2); u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 4)); u16(4); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(dataBytes)
        let fadeFrames = Double(sampleRate) * 0.02
        for i in 0..<frames {
            let fade = min(1, Double(i) / fadeFrames, Double(frames - 1 - i) / fadeFrames)
            let v = amplitude * fade * sin(2 * Double.pi * frequency * Double(i) / Double(sampleRate))
            let s = Int16(max(-32767, min(32767, (v * 32767).rounded())))
            let bits = UInt16(bitPattern: s)
            u16(bits); u16(bits)
        }
        try data.write(to: url, options: .atomic)
    }
}
