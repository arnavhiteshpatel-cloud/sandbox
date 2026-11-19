import Foundation

/// Live signal information about one app, measured by the audio engine.
public struct AppSignal: Hashable, Sendable {
    /// Pre-volume RMS level (linear).
    public var rms: Double
    /// Share of energy in the voice band (0…1); 0 when voice detection is off.
    public var voiceRatio: Double
    /// The app is currently capturing audio input (microphone).
    public var usesMicrophone: Bool

    public init(rms: Double = 0, voiceRatio: Double = 0, usesMicrophone: Bool = false) {
        self.rms = rms
        self.voiceRatio = voiceRatio
        self.usesMicrophone = usesMicrophone
    }
}

/// One app the ducking engine can see.
public struct DuckingParticipant: Hashable, Sendable {
    public var bundleID: String
    public var category: AppCategory
    public var signal: AppSignal

    public init(bundleID: String, category: AppCategory, signal: AppSignal) {
        self.bundleID = bundleID
        self.category = category
        self.signal = signal
    }
}

/// How strongly one app is currently being ducked by one rule.
public struct DuckInfluence: Hashable, Sendable {
    /// 0 = not ducked, 1 = fully ducked.
    public var amount: Double
    /// Slider position the rule ducks to.
    public var duckVolume: Double
    public var ruleID: UUID
}

/// Time-stepped ducking state machine. Pure and deterministic so it can be unit tested; the app
/// calls `step` at control rate (≈20 Hz) only while at least one rule is enabled.
///
/// Behaviour per rule:
///   * A trigger is "active" when its signal satisfies the rule's mode (level above threshold,
///     voice-band ratio, and/or microphone use).
///   * Activity is integrated with a leaky accumulator; ducking engages once it exceeds
///     `minimumActivity`, so isolated blips are ignored.
///   * Once engaged, ducking holds until the triggers have been silent for `hold` seconds, which
///     bridges pauses between words and sentences.
///   * The duck amount ramps linearly over `attack` / `release` seconds.
public final class DuckingEngine {
    struct RuleState {
        var activity: Double = 0
        var silence: Double = .infinity
        var engaged = false
        var amount: Double = 0
    }

    private var states: [UUID: RuleState] = [:]

    public init() {}

    /// Advances all rules by `dt` seconds and returns current influences per affected bundle ID.
    public func step(dt: Double, rules: [DuckingRule], participants: [DuckingParticipant]) -> [String: [DuckInfluence]] {
        let dt = max(0, min(dt, 0.5))
        var result: [String: [DuckInfluence]] = [:]
        var liveRules = Set<UUID>()

        for rule in rules where rule.isEnabled {
            liveRules.insert(rule.id)
            var s = states[rule.id] ?? RuleState()
            let threshold = VolumeTaper.gain(forDecibels: rule.thresholdDB)

            let triggers = participants.filter { rule.triggers.matches(bundleID: $0.bundleID, category: $0.category) }
            let active = triggers.contains { Self.isActive($0.signal, rule: rule, threshold: threshold) }

            if active {
                s.activity = min(s.activity + dt, rule.minimumActivity + 1)
                s.silence = 0
            } else {
                s.activity = max(0, s.activity - dt)
                s.silence = s.silence.isInfinite ? .infinity : s.silence + dt
            }
            if !s.engaged && active && s.activity >= rule.minimumActivity { s.engaged = true }
            if s.engaged && !active && s.silence >= rule.hold { s.engaged = false }

            if s.engaged {
                s.amount = rule.attack <= 0 ? 1 : min(1, s.amount + dt / rule.attack)
            } else {
                s.amount = rule.release <= 0 ? 0 : max(0, s.amount - dt / rule.release)
            }
            states[rule.id] = s

            guard s.amount > 0 else { continue }
            let triggerIDs = Set(triggers.map(\.bundleID))
            for p in participants where rule.targets.matches(bundleID: p.bundleID, category: p.category) {
                // An app never ducks itself (e.g. a browser that is both trigger and target category).
                if triggerIDs.contains(p.bundleID) { continue }
                result[p.bundleID, default: []].append(
                    DuckInfluence(amount: s.amount, duckVolume: rule.duckVolume, ruleID: rule.id))
            }
        }
        states = states.filter { liveRules.contains($0.key) }
        return result
    }

    /// Whether a rule is currently engaged (for UI status).
    public func isEngaged(_ ruleID: UUID) -> Bool { states[ruleID]?.engaged ?? false }
    public func amount(_ ruleID: UUID) -> Double { states[ruleID]?.amount ?? 0 }

    public func reset() { states.removeAll() }

    public var isIdle: Bool { states.values.allSatisfy { !$0.engaged && $0.amount == 0 } }

    static func isActive(_ sig: AppSignal, rule: DuckingRule, threshold: Double) -> Bool {
        let loud = sig.rms >= threshold
        let voiceLike = loud && sig.voiceRatio >= rule.voiceRatio
        switch rule.mode {
        case .activity: return loud
        case .voice: return voiceLike
        case .microphone: return sig.usesMicrophone
        case .voiceOrMicrophone: return voiceLike || sig.usesMicrophone
        }
    }
}

public enum DuckingMath {
    /// Gain after ducking. Interpolates in decibels between the app's own gain and the duck gain,
    /// so fades sound even. Ducking never raises an app that is already quieter than the target.
    public static func duckedGain(baseGain: Double, influences: [DuckInfluence]) -> Double {
        var g = baseGain
        for inf in influences {
            let target = min(baseGain, VolumeTaper.gain(forPosition: inf.duckVolume))
            let a = inf.amount.clamped(to: 0...1)
            let candidate: Double
            if baseGain <= 0 {
                candidate = 0
            } else if target <= 0 {
                // Fade towards silence in dB down to −60 dB (inaudible), then exactly zero.
                candidate = a >= 1 ? 0 : baseGain * pow(0.001, a)
            } else {
                candidate = baseGain * pow(target / baseGain, a)
            }
            g = min(g, candidate)
        }
        return g
    }
}
