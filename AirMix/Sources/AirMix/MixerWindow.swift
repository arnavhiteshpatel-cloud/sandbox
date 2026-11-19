import AirMixAudio
import AirMixCore
import SwiftUI

enum MixerSection: String, CaseIterable, Identifiable {
    case mixer, eq, devices, ducking, profiles, shortcuts, settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .mixer: return "Mixer"
        case .eq: return "Equalizer"
        case .devices: return "Devices & Routing"
        case .ducking: return "Ducking"
        case .profiles: return "Profiles"
        case .shortcuts: return "Shortcuts"
        case .settings: return "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .mixer: return "slider.vertical.3"
        case .eq: return "waveform.path.ecg"
        case .devices: return "hifispeaker.2.fill"
        case .ducking: return "arrow.down.right.and.arrow.up.left"
        case .profiles: return "rectangle.stack.fill"
        case .shortcuts: return "command"
        case .settings: return "gearshape.fill"
        }
    }
}

@MainActor
final class MixerNavigation: ObservableObject {
    @Published var section: MixerSection = .mixer
}

struct MixerWindowView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine
    @ObservedObject var devices: DeviceMonitor
    @ObservedObject var navigation: MixerNavigation

    var body: some View {
        HStack(spacing: 0) {
            sidebar
                .frame(width: 210)
                .background(VisualEffect(material: .sidebar).ignoresSafeArea())
            Divider().opacity(0.4)
            ZStack {
                VisualEffect(material: .underWindowBackground).ignoresSafeArea()
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(minWidth: 860, minHeight: 560)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.fillGradient).frame(width: 28, height: 28)
                    Image(systemName: "slider.vertical.3").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text("AirMix").font(.system(size: 15, weight: .semibold, design: .rounded))
                    Text(statusText).font(.system(size: 10)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 38)
            .padding(.bottom, 18)

            ForEach(MixerSection.allCases) { s in
                SidebarItem(section: s, selected: navigation.section == s) {
                    withAnimation(.easeOut(duration: 0.15)) { navigation.section = s }
                }
            }
            Spacer()
            VStack(alignment: .leading, spacing: 6) {
                Text("PROFILE").font(Theme.sectionTitle()).kerning(0.6).foregroundStyle(.tertiary)
                ProfileMenu()
            }
            .padding(14)
        }
    }

    private var statusText: String {
        switch engine.status {
        case .running: return "\(engine.activePathCount) app\(engine.activePathCount == 1 ? "" : "s") processed"
        case .paused: return "Paused"
        case .starting: return "Starting…"
        case .noOutput: return "No output device"
        case .unsupportedOutput: return "Output not supported"
        }
    }

    @ViewBuilder private var content: some View {
        switch navigation.section {
        case .mixer: ConsoleView(engine: engine, devices: devices)
        case .eq: EQSectionView(engine: engine)
        case .devices: DevicesView(engine: engine, devices: devices)
        case .ducking: DuckingView(engine: engine)
        case .profiles: ProfilesView(devices: devices)
        case .shortcuts: ShortcutsView()
        case .settings: SettingsView(engine: engine)
        }
    }
}

private struct SidebarItem: View {
    let section: MixerSection
    let selected: Bool
    let action: () -> Void
    @State var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: section.symbol)
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 18)
                    .foregroundStyle(selected ? Theme.accent : .secondary)
                Text(section.title).font(.system(size: 13, weight: selected ? .semibold : .regular))
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(selected ? Theme.accent.opacity(0.14) : Color.primary.opacity(hovering ? 0.05 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .onHover { hovering = $0 }
    }
}

/// Standard page scaffold for the window sections.
struct Page<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    var trailing: AnyView? = nil
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 22, weight: .semibold, design: .rounded))
                    if let subtitle { Text(subtitle).font(.system(size: 12)).foregroundStyle(.secondary) }
                }
                Spacer()
                if let trailing { trailing }
            }
            .padding(.horizontal, 28)
            .padding(.top, 34)
            .padding(.bottom, 16)
            content
        }
    }
}

// MARK: - Console

struct ConsoleView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine
    @ObservedObject var devices: DeviceMonitor

    var body: some View {
        Page(title: "Mixer", subtitle: "Every app on its own channel. Changes apply to the real audio instantly.") {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 10) {
                    MasterStrip(devices: devices)
                    Rectangle().fill(Theme.hairline).frame(width: 1).padding(.vertical, 8)
                    if model.visibleRows.isEmpty {
                        EmptyMixer().frame(width: 280)
                    }
                    ForEach(model.visibleRows) { row in
                        ChannelStrip(row: row, engine: engine, devices: devices)
                    }
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
            }
            .frame(maxHeight: .infinity)
        }
    }
}

struct VerticalFader: View {
    @Binding var value: Double
    var maxValue: Double = 1
    var muted = false
    @State var dragging = false

    var body: some View {
        GeometryReader { geo in
            let h = geo.size.height
            let fraction = CGFloat((value / maxValue).clamped(to: 0...1))
            let unityY = h * (1 - CGFloat(1 / maxValue))
            ZStack(alignment: .bottom) {
                Capsule().fill(Theme.track).frame(width: 6)
                if maxValue > 1 {
                    Capsule().fill(Theme.boost.opacity(0.15)).frame(width: 6, height: h - (h - unityY))
                        .frame(maxHeight: .infinity, alignment: .top)
                }
                Capsule()
                    .fill(muted ? AnyShapeStyle(Color.secondary.opacity(0.35)) : AnyShapeStyle(Theme.verticalFill))
                    .frame(width: 6, height: max(6, h * fraction))
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.white)
                    .shadow(color: .black.opacity(0.35), radius: dragging ? 4 : 2, y: 1)
                    .overlay(Rectangle().fill(Color.black.opacity(0.25)).frame(height: 1))
                    .frame(width: 30, height: 14)
                    .offset(y: -(h * fraction - 7).clamped(to: -7...(h - 7)))
                if maxValue > 1 {
                    Rectangle().fill(Color.primary.opacity(0.3)).frame(width: 14, height: 1)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .offset(y: unityY)
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { g in
                    guard h > 0 else { return }
                    dragging = true
                    var v = Double((1 - g.location.y / h).clamped(to: 0...1)) * maxValue
                    if maxValue > 1, abs(v - 1) < 0.025 * maxValue { v = 1 }
                    value = (v * 100).rounded() / 100
                }
                .onEnded { _ in dragging = false })
            .simultaneousGesture(TapGesture(count: 2).onEnded { value = 1 })
        }
    }
}

struct MasterStrip: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var devices: DeviceMonitor

    var body: some View {
        VStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.fillGradient).frame(width: 36, height: 36)
                Image(systemName: devices.defaultOutput?.symbolName ?? "speaker.slash").foregroundStyle(.white)
                    .font(.system(size: 15, weight: .semibold))
            }
            Text("Master").font(.system(size: 12, weight: .semibold))
            Text(devices.defaultOutput?.name ?? "No output").font(.system(size: 10)).foregroundStyle(.secondary)
                .lineLimit(2).multilineTextAlignment(.center).frame(height: 26)
            VerticalFader(value: Binding(get: { model.masterVolume }, set: { model.setMasterVolume($0) }), muted: model.masterMuted)
                .frame(height: 280)
            Text(VolumeTaper.percentLabel(model.masterVolume)).font(Theme.mono(12))
            IconButton(symbol: model.masterMuted ? "speaker.slash.fill" : "speaker.wave.2.fill", help: "Mute all",
                       active: model.masterMuted, tint: Theme.danger, size: 28) { model.toggleMasterMute() }
        }
        .padding(.vertical, 14)
        .frame(width: 108)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.accent.opacity(0.07)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.accent.opacity(0.18), lineWidth: 0.5))
    }
}

struct ChannelStrip: View {
    @EnvironmentObject var model: AppModel
    let row: MixerRow
    @ObservedObject var engine: AudioEngine
    @ObservedObject var devices: DeviceMonitor
    @State var hovering = false

    var body: some View {
        let s = model.appSettings(row.id)
        let meter = engine.meters.model(for: row.id)
        VStack(spacing: 10) {
            AppIconView(id: row.id, bundlePath: row.bundlePath, category: row.category, size: 36, dimmed: !row.isRunning)
            Text(row.name).font(.system(size: 12, weight: .semibold)).lineLimit(1)
            HStack(spacing: 4) {
                OutputMenu(devices: devices, current: s.outputDeviceUID) { model.setOutput(row.id, $0) }
                Button {
                    model.selectedAppID = row.id
                    NotificationCenter.default.post(name: .airmixOpenMixer, object: "eq")
                } label: {
                    Text("EQ").font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Capsule().fill(s.eq.isEnabled && !s.eq.isNeutral ? Theme.accent.opacity(0.22) : Theme.track))
                        .foregroundStyle(s.eq.isEnabled && !s.eq.isNeutral ? Theme.accent : .secondary)
                }
                .buttonStyle(.plain)
                .help("Edit equalizer")
            }
            .frame(height: 26)
            HStack(spacing: 8) {
                VerticalFader(value: Binding(get: { model.appSettings(row.id).volume }, set: { model.setVolume(row.id, $0) }),
                              maxValue: model.maxBoost, muted: s.isMuted)
                    .frame(width: 34)
                LevelMeter(meter: meter, stereo: true, vertical: true, thickness: 4)
                    .opacity(engine.isProcessing(row.id) ? 1 : 0.25)
            }
            .frame(height: 280)
            Text(s.isMuted ? "Muted" : VolumeTaper.percentLabel(s.volume))
                .font(Theme.mono(12))
                .foregroundStyle(s.volume > 1.0001 && !s.isMuted ? Theme.boost : .primary)
            IconButton(symbol: s.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill", help: "Mute \(row.name)",
                       active: s.isMuted, tint: Theme.danger, size: 28) { model.toggleMute(row.id) }
        }
        .padding(.vertical, 14)
        .frame(width: 104)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.primary.opacity(hovering ? 0.06 : 0.035)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.cardStroke, lineWidth: 0.5))
        .onHover { hovering = $0 }
        .contextMenu {
            Button(s.isPinned ? "Unpin" : "Pin") { model.togglePin(row.id) }
            Button("Hide") { model.setHidden(row.id, true) }
            Button("Reset") { model.resetApp(row.id) }
        }
        .help(engine.appErrors[row.id] ?? row.name)
    }
}
