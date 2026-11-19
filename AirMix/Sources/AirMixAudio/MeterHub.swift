import AirMixCore
import Combine
import Foundation

/// Live meter state for one app. Each row observes only its own model, and values are only
/// published when they visibly change, so silent apps cause no redraws.
@MainActor
public final class MeterModel: ObservableObject {
    @Published public private(set) var left: Double = 0
    @Published public private(set) var right: Double = 0
    @Published public private(set) var peakHold: Double = 0
    @Published public private(set) var limiting = false
    /// Last raw reading (not published; used for diagnostics).
    public private(set) var raw = MeterReading.silent
    private var holdTicks = 0

    public init() {}

    public var level: Double { max(left, right) }

    func update(_ reading: MeterReading, decay: Double) {
        raw = reading
        let l = max(MeterScale.fraction(forLinear: reading.peakLeft), left - decay)
        let r = max(MeterScale.fraction(forLinear: reading.peakRight), right - decay)
        if abs(l - left) > 0.004 || (l == 0 && left != 0) { left = l < 0.002 ? 0 : l }
        if abs(r - right) > 0.004 || (r == 0 && right != 0) { right = r < 0.002 ? 0 : r }
        let peak = max(l, r)
        if peak >= peakHold {
            if peak != peakHold { peakHold = peak }
            holdTicks = 30
        } else if holdTicks > 0 {
            holdTicks -= 1
        } else {
            let p = max(0, peakHold - decay * 0.5)
            if abs(p - peakHold) > 0.004 || (p == 0 && peakHold != 0) { peakHold = p < 0.002 ? 0 : p }
        }
        if reading.limiting != limiting { limiting = reading.limiting }
    }

    func reset() {
        raw = .silent
        if left != 0 { left = 0 }
        if right != 0 { right = 0 }
        if peakHold != 0 { peakHold = 0 }
        if limiting { limiting = false }
    }
}

@MainActor
public final class MeterHub {
    private var models: [String: MeterModel] = [:]

    public init() {}

    public func model(for key: String) -> MeterModel {
        if let m = models[key] { return m }
        let m = MeterModel()
        models[key] = m
        return m
    }

    func update(_ key: String, _ reading: MeterReading, decay: Double) {
        model(for: key).update(reading, decay: decay)
    }

    func resetAll(except keep: Set<String> = []) {
        for (k, m) in models where !keep.contains(k) { m.reset() }
    }
}
