import AirMixDSP
import Foundation

public enum FilterType: String, Codable, CaseIterable, Hashable, Sendable {
    case peaking, lowShelf, highShelf, lowPass, highPass, notch

    public var displayName: String {
        switch self {
        case .peaking: return "Bell"
        case .lowShelf: return "Low Shelf"
        case .highShelf: return "High Shelf"
        case .lowPass: return "Low Pass"
        case .highPass: return "High Pass"
        case .notch: return "Notch"
        }
    }

    /// Whether the gain parameter affects this filter.
    public var usesGain: Bool { self == .peaking || self == .lowShelf || self == .highShelf }

    var cType: amx_filter_type {
        switch self {
        case .peaking: return AMX_PEAKING
        case .lowShelf: return AMX_LOW_SHELF
        case .highShelf: return AMX_HIGH_SHELF
        case .lowPass: return AMX_LOW_PASS
        case .highPass: return AMX_HIGH_PASS
        case .notch: return AMX_NOTCH
        }
    }
}

public struct EQBand: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var type: FilterType
    public var frequency: Double
    public var gainDB: Double
    public var q: Double
    public var isEnabled: Bool

    public init(id: UUID = UUID(), type: FilterType = .peaking, frequency: Double, gainDB: Double = 0,
                q: Double = 1.0, isEnabled: Bool = true) {
        self.id = id
        self.type = type
        self.frequency = frequency
        self.gainDB = gainDB
        self.q = q
        self.isEnabled = isEnabled
    }

    public static let gainRange: ClosedRange<Double> = -15...15
    public static let frequencyRange: ClosedRange<Double> = 20...20000
    public static let qRange: ClosedRange<Double> = 0.2...12
}

public struct EQSettings: Codable, Hashable, Sendable {
    public var isEnabled: Bool
    public var bands: [EQBand]
    /// Preset this EQ was loaded from (nil once edited away from it or never set).
    public var presetID: String?
    /// Lower the level by the curve's maximum boost so the EQ itself cannot clip.
    public var autoHeadroom: Bool

    public init(isEnabled: Bool = false, bands: [EQBand] = EQSettings.defaultBands(), presetID: String? = "flat",
                autoHeadroom: Bool = true) {
        self.isEnabled = isEnabled
        self.bands = bands
        self.presetID = presetID
        self.autoHeadroom = autoHeadroom
    }

    public static let flat = EQSettings()

    /// Eight-band layout: low shelf, six bells, high shelf.
    public static let defaultFrequencies: [Double] = [60, 150, 400, 1000, 2400, 5000, 9000, 14000]

    public static func defaultBands(gains: [Double] = Array(repeating: 0, count: 8)) -> [EQBand] {
        defaultFrequencies.enumerated().map { i, f in
            let type: FilterType = i == 0 ? .lowShelf : (i == defaultFrequencies.count - 1 ? .highShelf : .peaking)
            return EQBand(type: type, frequency: f, gainDB: i < gains.count ? gains[i] : 0,
                          q: type == .peaking ? 1.1 : 0.71)
        }
    }

    /// True when the EQ would not change the signal.
    public var isNeutral: Bool {
        !isEnabled || bands.allSatisfy { !$0.isEnabled || ($0.type.usesGain && abs($0.gainDB) < 0.05) }
    }
}

/// Filter design and response evaluation (wraps the C kernel so audio and UI agree exactly).
public enum EQDesigner {
    public struct Design {
        public var coefficients: [amx_biquad]
        public var preampLinear: Float
        public var peakGainDB: Double
    }

    public static func design(_ eq: EQSettings, sampleRate: Double) -> Design {
        let active = eq.bands.filter(\.isEnabled).prefix(Int(AMX_MAX_BANDS))
        let coeffs = active.map { band in
            amx_design(band.type.cType, sampleRate, band.frequency, band.q,
                       band.type.usesGain ? band.gainDB.clamped(to: EQBand.gainRange) : 0)
        }
        let peak = coeffs.isEmpty ? 0 : maxGainDB(coeffs, sampleRate: sampleRate)
        let preampDB = eq.autoHeadroom ? -max(0, peak) : 0
        return Design(coefficients: coeffs, preampLinear: Float(VolumeTaper.gain(forDecibels: preampDB)),
                      peakGainDB: peak)
    }

    /// Magnitude in dB of the whole EQ (including auto headroom) at each frequency.
    public static func response(_ eq: EQSettings, sampleRate: Double = 48000, frequencies: [Double]) -> [Double] {
        let d = design(eq, sampleRate: sampleRate)
        let pre = VolumeTaper.decibels(forGain: Double(d.preampLinear))
        return d.coefficients.withUnsafeBufferPointer { buf in
            frequencies.map { f in amx_cascade_magnitude_db(buf.baseAddress, Int32(buf.count), sampleRate, f) + pre }
        }
    }

    /// Response of a single band (for drawing individual band curves).
    public static func bandResponse(_ band: EQBand, sampleRate: Double = 48000, frequencies: [Double]) -> [Double] {
        var c = amx_design(band.type.cType, sampleRate, band.frequency, band.q, band.type.usesGain ? band.gainDB : 0)
        return frequencies.map { amx_cascade_magnitude_db(&c, 1, sampleRate, $0) }
    }

    /// Log-spaced frequencies between 20 Hz and 20 kHz.
    public static func logFrequencies(count: Int, from low: Double = 20, to high: Double = 20000) -> [Double] {
        guard count > 1 else { return [low] }
        let a = log10(low), b = log10(high)
        return (0..<count).map { pow(10, a + (b - a) * Double($0) / Double(count - 1)) }
    }

    static func maxGainDB(_ coeffs: [amx_biquad], sampleRate: Double) -> Double {
        let freqs = logFrequencies(count: 256, from: 20, to: min(20000, sampleRate * 0.45))
        return coeffs.withUnsafeBufferPointer { buf in
            freqs.map { amx_cascade_magnitude_db(buf.baseAddress, Int32(buf.count), sampleRate, $0) }.max() ?? 0
        }
    }
}

public struct EQPreset: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var bands: [EQBand]
    public var isBuiltIn: Bool

    public init(id: String = UUID().uuidString, name: String, bands: [EQBand], isBuiltIn: Bool = false) {
        self.id = id
        self.name = name
        self.bands = bands
        self.isBuiltIn = isBuiltIn
    }

    private static func make(_ id: String, _ name: String, _ gains: [Double]) -> EQPreset {
        EQPreset(id: id, name: name, bands: EQSettings.defaultBands(gains: gains), isBuiltIn: true)
    }

    //                                       60   150   400  1k   2.4k  5k   9k   14k
    public static let builtIn: [EQPreset] = [
        make("flat", "Neutral", [0, 0, 0, 0, 0, 0, 0, 0]),
        make("bass", "Bass Boost", [6, 3.5, 0.5, 0, 0, 0, 0, 0]),
        make("vocal", "Vocal Clarity", [-2, -1.5, -1, 1.5, 3.5, 2.5, 0.5, 0]),
        make("movie", "Movie", [4, 1, -1, 1, 2.5, 1.5, 1, 1.5]),
        make("music", "Music", [3, 1, -0.5, 0, 0.5, 1.5, 2, 2.5]),
        make("podcast", "Podcast", [-5, -1, -1.5, 1, 3, 2, 0, -1]),
        make("night", "Night Mode", [-6, -3, 0, 1, 2, 0.5, -2, -4]),
    ]

    public static func builtIn(id: String) -> EQPreset? { builtIn.first { $0.id == id } }
}
