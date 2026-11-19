import AirMixDSP
import Foundation

/// Snapshot of an app's live meters.
public struct MeterReading: Hashable, Sendable {
    public var peakLeft: Double
    public var peakRight: Double
    public var inputRMS: Double
    public var voiceRatio: Double
    public var limiting: Bool
    public var appliedGain: Double
    public var callbacks: UInt32

    public init(peakLeft: Double = 0, peakRight: Double = 0, inputRMS: Double = 0, voiceRatio: Double = 0,
                limiting: Bool = false, appliedGain: Double = 1, callbacks: UInt32 = 0) {
        self.peakLeft = peakLeft
        self.peakRight = peakRight
        self.inputRMS = inputRMS
        self.voiceRatio = voiceRatio
        self.limiting = limiting
        self.appliedGain = appliedGain
        self.callbacks = callbacks
    }

    public static let silent = MeterReading()
    public var peak: Double { max(peakLeft, peakRight) }
}

/// Owns one C `amx_processor`. All methods must be called from one control thread (the main thread);
/// the raw pointer is handed to the Core Audio I/O proc, which only touches it in a real-time-safe way.
public final class AudioProcessor {
    public let raw: OpaquePointer
    public private(set) var sampleRate: Double
    private var eq: EQSettings = .flat
    private var lastGain: Float = 1

    public init(sampleRate: Double) {
        guard let p = amx_processor_create(sampleRate) else { fatalError("AirMix: out of memory creating processor") }
        raw = p
        self.sampleRate = sampleRate
    }

    deinit { amx_processor_destroy(raw) }

    /// Only while the I/O proc is stopped.
    public func setSampleRate(_ rate: Double) {
        guard rate != sampleRate, rate > 1000 else { return }
        sampleRate = rate
        amx_processor_set_sample_rate(raw, rate)
        setEQ(eq)
    }

    public func setGain(_ gain: Double, immediate: Bool = false) {
        let g = Float(gain.isFinite ? max(0, gain) : 0)
        lastGain = g
        if immediate { amx_set_gain_immediate(raw, g) } else { amx_set_gain(raw, g) }
    }

    public var gain: Double { Double(lastGain) }

    public func setEQ(_ settings: EQSettings) {
        eq = settings
        let d = EQDesigner.design(settings, sampleRate: sampleRate)
        d.coefficients.withUnsafeBufferPointer { buf in
            amx_set_eq(raw, buf.baseAddress, Int32(buf.count), d.preampLinear)
        }
        amx_set_eq_enabled(raw, settings.isEnabled && !d.coefficients.isEmpty)
    }

    public func setLimiter(enabled: Bool, ceiling: Float = 0.98) { amx_set_limiter(raw, enabled, ceiling) }
    public func setVoiceDetection(_ on: Bool) { amx_set_voice_detection(raw, on) }
    public func setInputLayout(bufferIndex: Int, channelOffset: Int) {
        amx_set_input_layout(raw, Int32(bufferIndex), Int32(channelOffset))
    }

    public func readMeters() -> MeterReading {
        var m = amx_meters()
        amx_read_meters(raw, &m)
        return MeterReading(peakLeft: Double(m.peak_left), peakRight: Double(m.peak_right),
                            inputRMS: Double(m.input_rms), voiceRatio: Double(m.voice_ratio),
                            limiting: m.clip_events > 0, appliedGain: Double(m.current_gain),
                            callbacks: m.callbacks)
    }

    /// Monotonic count of I/O callbacks (health monitoring; does not reset meters).
    public var callbackCount: UInt32 { amx_callback_count(raw) }
    /// Smoothed pre-gain RMS (does not reset meters).
    public var inputRMS: Double { Double(amx_input_rms(raw)) }

    /// Opaque client-data pointer for `amx_core_audio_ioproc`.
    public var clientData: UnsafeMutableRawPointer { UnsafeMutableRawPointer(raw) }
}
