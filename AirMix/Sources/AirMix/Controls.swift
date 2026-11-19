import AirMixAudio
import AirMixCore
import SwiftUI

/// The AirMix fader: a slim track whose fill is the volume, with the app's live output level
/// glowing inside it. Supports boost above 100 % (amber zone) with a magnetic detent at 100 %,
/// double-click to reset, keyboard arrows when focused, and smooth animation.
struct VolumeFader: View {
    @Binding var value: Double
    var maxValue: Double = 1
    var muted = false
    var meter: MeterModel?
    var height: CGFloat = 20
    var onEditingChanged: (Bool) -> Void = { _ in }

    @State var dragging = false
    @State var hovering = false

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let unityX = w * CGFloat(1 / maxValue)
            let fraction = CGFloat((value / maxValue).clamped(to: 0...1))
            let knob: CGFloat = dragging ? 15 : (hovering ? 14 : 12)
            ZStack(alignment: .leading) {
                // Track
                Capsule().fill(Theme.track).frame(height: 5)
                if maxValue > 1 {
                    Capsule().fill(Theme.boost.opacity(0.14))
                        .frame(width: w - unityX, height: 5)
                        .offset(x: unityX)
                }
                // Fill
                Capsule()
                    .fill(muted ? AnyShapeStyle(Color.secondary.opacity(0.35)) : AnyShapeStyle(fillStyle(boosted: value > 1.0001)))
                    .frame(width: max(5, w * fraction), height: 5)
                // Live level inside the fill
                if let meter, !muted {
                    MeterGlow(meter: meter, width: max(5, w * fraction))
                }
                if maxValue > 1 {
                    Rectangle().fill(Color.primary.opacity(0.25)).frame(width: 1, height: 9).offset(x: unityX - 0.5)
                }
                // Knob
                Circle()
                    .fill(Color.white)
                    .shadow(color: .black.opacity(0.35), radius: dragging ? 3 : 1.5, y: 0.5)
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.08), lineWidth: 0.5))
                    .frame(width: knob, height: knob)
                    .offset(x: (w * fraction - knob / 2).clamped(to: -knob / 2...(w - knob / 2)))
            }
            .frame(height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { g in
                        guard w > 0 else { return }
                        if !dragging { dragging = true; onEditingChanged(true) }
                        var v = Double((g.location.x / w).clamped(to: 0...1)) * maxValue
                        if maxValue > 1, abs(v - 1) < 0.025 * maxValue { v = 1 }  // detent at 100 %
                        value = (v * 100).rounded() / 100
                    }
                    .onEnded { _ in dragging = false; onEditingChanged(false) }
            )
            .simultaneousGesture(TapGesture(count: 2).onEnded { value = 1 })
            .onHover { hovering = $0 }
            .animation(.spring(response: 0.25, dampingFraction: 0.8), value: dragging)
            .animation(.easeOut(duration: 0.12), value: hovering)
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityLabel("Volume")
        .accessibilityValue(VolumeTaper.percentLabel(value))
        .accessibilityAdjustableAction { dir in
            switch dir {
            case .increment: value = min(maxValue, value + 0.05)
            case .decrement: value = max(0, value - 0.05)
            @unknown default: break
            }
        }
    }

    private func fillStyle(boosted: Bool) -> LinearGradient {
        boosted
            ? LinearGradient(colors: [Theme.accent, Theme.accent2, Theme.boost], startPoint: .leading, endPoint: .trailing)
            : Theme.fillGradient
    }
}

/// Bright overlay inside the fader fill showing the live output level.
private struct MeterGlow: View {
    @ObservedObject var meter: MeterModel
    let width: CGFloat

    var body: some View {
        Capsule()
            .fill(Color.white.opacity(0.55))
            .frame(width: max(0, width * CGFloat(meter.level)), height: 5)
            .blendMode(.plusLighter)
            .opacity(meter.level > 0 ? 1 : 0)
            .animation(.linear(duration: 0.05), value: meter.level)
    }
}

/// Compact level meter (mono or stereo) with peak hold and limiter indicator.
struct LevelMeter: View {
    @ObservedObject var meter: MeterModel
    var stereo = false
    var vertical = false
    var thickness: CGFloat = 3

    var body: some View {
        Group {
            if vertical {
                HStack(spacing: 2) {
                    bar(meter.left, peak: meter.peakHold)
                    if stereo { bar(meter.right, peak: meter.peakHold) }
                }
            } else {
                VStack(spacing: 2) {
                    bar(meter.left, peak: meter.peakHold)
                    if stereo { bar(meter.right, peak: meter.peakHold) }
                }
            }
        }
    }

    private func bar(_ level: Double, peak: Double) -> some View {
        GeometryReader { g in
            let length = vertical ? g.size.height : g.size.width
            ZStack(alignment: vertical ? .bottom : .leading) {
                RoundedRectangle(cornerRadius: thickness / 2).fill(Theme.track)
                RoundedRectangle(cornerRadius: thickness / 2)
                    .fill(LinearGradient(stops: [
                        .init(color: Theme.meterLow, location: 0),
                        .init(color: Theme.meterLow, location: 0.72),
                        .init(color: Theme.meterMid, location: 0.88),
                        .init(color: meter.limiting ? Theme.danger : Theme.meterMid, location: 1),
                    ], startPoint: vertical ? .bottom : .leading, endPoint: vertical ? .top : .trailing))
                    .mask(alignment: vertical ? .bottom : .leading) {
                        Rectangle().frame(width: vertical ? nil : length * CGFloat(level),
                                          height: vertical ? length * CGFloat(level) : nil)
                    }
                if peak > 0.01 {
                    Rectangle()
                        .fill(peak > 0.97 ? Theme.danger : Color.primary.opacity(0.6))
                        .frame(width: vertical ? nil : 1.5, height: vertical ? 1.5 : nil)
                        .offset(x: vertical ? 0 : length * CGFloat(peak) - 1.5, y: vertical ? -length * CGFloat(peak) + 1.5 : 0)
                }
            }
        }
        .frame(width: vertical ? thickness : nil, height: vertical ? nil : thickness)
    }
}

/// Animated "playing" indicator: three bars driven by the real meter level (static when silent).
struct ActivityBars: View {
    @ObservedObject var meter: MeterModel
    var color: Color = Theme.accent

    var body: some View {
        HStack(alignment: .bottom, spacing: 1.5) {
            ForEach(0..<3, id: \.self) { i in
                let factors: [Double] = [0.75, 1.0, 0.6]
                let source = i == 1 ? meter.peakHold : (i == 0 ? meter.left : meter.right)
                Capsule()
                    .fill(color)
                    .frame(width: 2, height: 3 + 7 * CGFloat(min(1, source * factors[i] * 1.2)))
            }
        }
        .frame(width: 10, height: 10, alignment: .bottom)
        .animation(.linear(duration: 0.06), value: meter.left)
    }
}

/// Pill-styled segmented choice.
struct PillPicker<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { opt in
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { selection = opt.0 }
                } label: {
                    Text(opt.1)
                        .font(.system(size: 11, weight: .medium))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 4)
                        .background(Capsule().fill(selection == opt.0 ? Theme.accent.opacity(0.22) : .clear))
                        .foregroundStyle(selection == opt.0 ? Theme.accent : .secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Capsule().fill(Theme.track.opacity(0.6)))
    }
}

/// Output device menu used on every app row (nil = follow the system default).
struct OutputMenu: View {
    @ObservedObject var devices: DeviceMonitor
    let current: String?
    var compact = true
    let onSelect: (String?) -> Void

    var body: some View {
        Menu {
            Button {
                onSelect(nil)
            } label: {
                Label("System Default\(devices.defaultOutput.map { " (\($0.name))" } ?? "")",
                      systemImage: current == nil ? "checkmark" : "arrow.triangle.branch")
            }
            Divider()
            ForEach(devices.outputs) { d in
                Button {
                    onSelect(d.uid)
                } label: {
                    Label(d.name, systemImage: current == d.uid ? "checkmark" : d.symbolName)
                }
                .disabled(!d.supportsPerAppPlayback)
            }
            if devices.outputs.contains(where: { !$0.supportsPerAppPlayback }) {
                Divider()
                Text("Aggregate / Multi-Output devices can’t be used for per-app routing.")
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: currentSymbol).font(.system(size: 10, weight: .semibold))
                if !compact { Text(currentName).font(.system(size: 11)).lineLimit(1) }
            }
            .foregroundStyle(current == nil ? Color.secondary : Theme.accent)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(compact ? .hidden : .visible)
        .fixedSize()
        .help("Output: \(currentName)")
    }

    private var currentDevice: OutputDevice? { devices.device(uid: current) }
    private var currentName: String {
        if let current {
            return currentDevice?.name ?? "Unavailable device (\(current.prefix(12))…)"
        }
        return "System Default"
    }
    private var currentSymbol: String {
        if current == nil { return "arrow.triangle.branch" }
        return currentDevice?.symbolName ?? "exclamationmark.triangle"
    }
}
