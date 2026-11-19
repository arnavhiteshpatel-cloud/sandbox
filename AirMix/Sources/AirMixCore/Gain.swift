import Foundation

/// Conversions between what the user sees (a 0…200 % slider) and the linear gain applied to audio.
///
/// The slider uses a square-law taper, which is close to perceived loudness and widely used by
/// mixers: 50 % ≈ −12 dB, 70 % ≈ −6 dB, 100 % = unity, 141 % ≈ +6 dB, 200 % = +12 dB.
public enum VolumeTaper {
    /// Slider position (1.0 == 100 %) → linear gain.
    public static func gain(forPosition position: Double) -> Double {
        let p = max(0, position)
        return p * p
    }

    /// Linear gain → slider position.
    public static func position(forGain gain: Double) -> Double {
        sqrt(max(0, gain))
    }

    public static func decibels(forGain gain: Double) -> Double {
        gain <= 0 ? -.infinity : 20 * log10(gain)
    }

    public static func gain(forDecibels db: Double) -> Double {
        db.isInfinite && db < 0 ? 0 : pow(10, db / 20)
    }

    /// Human-readable label for a slider position, e.g. "35%".
    public static func percentLabel(_ position: Double) -> String {
        "\(Int((position * 100).rounded()))%"
    }
}

/// Converts a linear meter value to a 0…1 display fraction on a dB scale (−60 dB … 0 dB).
public enum MeterScale {
    public static let floorDB: Double = -60

    public static func fraction(forLinear value: Double) -> Double {
        guard value > 0 else { return 0 }
        let db = 20 * log10(value)
        return min(1, max(0, (db - floorDB) / -floorDB))
    }
}

public extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self { min(max(self, range.lowerBound), range.upperBound) }
}
