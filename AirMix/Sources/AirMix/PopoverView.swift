import AirMixAudio
import AirMixCore
import SwiftUI

struct PopoverView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine
    @ObservedObject var devices: DeviceMonitor
    @State private var showInactive = false

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 14)
                .padding(.top, 12)
                .padding(.bottom, 10)
            banners
            MasterCard(devices: devices)
                .padding(.horizontal, 12)
            appList
            footer
        }
        .frame(width: 368)
        .background(VisualEffect(material: .popover).ignoresSafeArea())
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Theme.fillGradient)
                    .frame(width: 22, height: 22)
                Image(systemName: "slider.vertical.3")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
            }
            Text("AirMix")
                .font(.system(size: 15, weight: .semibold, design: .rounded))
            Spacer()
            ProfileMenu()
            IconButton(symbol: "arrow.up.left.and.arrow.down.right", help: "Open the full mixer (⌘O)") {
                NotificationCenter.default.post(name: .airmixOpenMixer, object: "mixer")
            }
            .keyboardShortcut("o", modifiers: .command)
            Menu {
                Button(engine.isPaused ? "Resume AirMix" : "Pause AirMix") { engine.setPaused(!engine.isPaused) }
                Button("Reset Audio") { model.resetAudio() }
                Divider()
                Button("Equalizer…") { NotificationCenter.default.post(name: .airmixOpenMixer, object: "eq") }
                Button("Ducking…") { NotificationCenter.default.post(name: .airmixOpenMixer, object: "ducking") }
                Button("Profiles…") { NotificationCenter.default.post(name: .airmixOpenMixer, object: "profiles") }
                Button("Settings…") { NotificationCenter.default.post(name: .airmixOpenMixer, object: "settings") }
                Divider()
                Button("Quit AirMix") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle").font(.system(size: 14, weight: .medium)).foregroundStyle(.secondary)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    // MARK: Banners

    @ViewBuilder private var banners: some View {
        VStack(spacing: 6) {
            if !model.settings.preferences.hasCompletedOnboarding {
                Banner(symbol: "lock.shield", tint: Theme.accent,
                       title: "One permission needed",
                       message: "AirMix uses macOS audio taps to adjust each app’s sound. The first time an app plays, macOS asks to allow “System Audio Recording”. Audio never leaves your Mac and is never saved.",
                       actionTitle: "Got it") { model.completeOnboarding() }
            }
            if engine.permissionSuspected {
                Banner(symbol: "exclamationmark.triangle.fill", tint: Theme.boost,
                       title: "No audio is reaching AirMix",
                       message: "Allow AirMix under Privacy & Security → Screen & System Audio Recording, then relaunch AirMix. Pause AirMix to restore normal playback meanwhile.",
                       actionTitle: "Open Settings") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture") {
                        NSWorkspace.shared.open(url)
                    }
                }
            }
            switch engine.status {
            case .unsupportedOutput(let name):
                Banner(symbol: "info.circle.fill", tint: .secondary, title: "Per-app control paused",
                       message: "“\(name)” is an aggregate or Multi-Output device, which can’t host per-app audio. Apps play normally. Pick a regular output to use AirMix.",
                       actionTitle: nil, action: nil)
            case .noOutput:
                Banner(symbol: "speaker.slash.fill", tint: .secondary, title: "No output device", message: "Connect speakers or headphones.",
                       actionTitle: nil, action: nil)
            case .paused:
                Banner(symbol: "pause.circle.fill", tint: .secondary, title: "AirMix is paused",
                       message: "All apps play normally without AirMix.", actionTitle: "Resume") { engine.setPaused(false) }
            default:
                EmptyView()
            }
            if let issue = model.loadIssue {
                Banner(symbol: "doc.badge.gearshape", tint: Theme.boost, title: "Settings were reset", message: issue,
                       actionTitle: "Dismiss") { model.loadIssue = nil }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    // MARK: App list

    private var appList: some View {
        let rows = model.visibleRows
        let active = rows.filter { $0.isPlaying || $0.isPinned }
        let inactive = rows.filter { !$0.isPlaying && !$0.isPinned }
        return VStack(spacing: 0) {
            HStack {
                SectionHeader(title: "Apps")
                Spacer()
                let playing = model.rows.filter(\.isPlaying).count
                Text(playing == 0 ? "Nothing playing" : "\(playing) playing")
                    .font(Theme.caption())
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 4)

            ScrollView {
                LazyVStack(spacing: 2) {
                    if active.isEmpty && inactive.isEmpty {
                        EmptyMixer()
                    }
                    ForEach(active) { row in
                        AppRow(row: row, engine: engine, devices: devices)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                    if !inactive.isEmpty {
                        Button {
                            withAnimation(.easeInOut(duration: 0.2)) { showInactive.toggle() }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 9, weight: .bold))
                                    .rotationEffect(.degrees(showInactive ? 90 : 0))
                                Text("Not playing (\(inactive.count))").font(Theme.caption())
                                Spacer()
                            }
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if showInactive {
                            ForEach(inactive) { row in
                                AppRow(row: row, engine: engine, devices: devices)
                                    .transition(.opacity)
                            }
                        }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.bottom, 6)
                .animation(.easeInOut(duration: 0.22), value: active.map(\.id))
            }
            .frame(minHeight: 120, maxHeight: 400)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 8) {
            Divider().opacity(0.5)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(model.settings.profiles) { p in
                        ProfilePill(profile: p, active: model.settings.activeProfileID == p.id) {
                            withAnimation(.easeOut(duration: 0.2)) { model.activateProfile(p.id) }
                        }
                    }
                }
                .padding(.horizontal, 12)
            }
            .padding(.bottom, 10)
        }
    }
}

// MARK: - Master

struct MasterCard: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var devices: DeviceMonitor

    var body: some View {
        Card(padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Menu {
                        ForEach(devices.outputs) { d in
                            Button {
                                model.setDefaultOutput(d.uid)
                            } label: {
                                Label(d.name, systemImage: d.uid == devices.defaultOutput?.uid ? "checkmark" : d.symbolName)
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: devices.defaultOutput?.symbolName ?? "speaker.slash")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.accent)
                                .frame(width: 18)
                            Text(devices.defaultOutput?.name ?? "No Output")
                                .font(.system(size: 13, weight: .semibold))
                                .lineLimit(1)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("System output device")
                    Spacer()
                    if let d = devices.defaultOutput {
                        Text(d.transport.displayName)
                            .font(.system(size: 10, weight: .medium))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Theme.track))
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 10) {
                    IconButton(symbol: model.masterMuted ? "speaker.slash.fill" : speakerSymbol(model.masterVolume),
                               help: model.masterMuted ? "Unmute output" : "Mute all audio",
                               active: model.masterMuted, tint: Theme.danger, size: 26) {
                        model.toggleMasterMute()
                    }
                    VolumeFader(value: Binding(get: { model.masterVolume }, set: { model.setMasterVolume($0) }),
                                maxValue: 1, muted: model.masterMuted, height: 22)
                    Text(VolumeTaper.percentLabel(model.masterVolume))
                        .font(Theme.mono(12))
                        .foregroundStyle(.secondary)
                        .frame(width: 38, alignment: .trailing)
                }
                if !model.masterIsHardware && devices.defaultOutput != nil {
                    Text("This device has no volume control — AirMix adjusts the apps it processes instead.")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }
}

func speakerSymbol(_ v: Double) -> String {
    v < 0.01 ? "speaker.fill" : v < 0.34 ? "speaker.wave.1.fill" : v < 0.67 ? "speaker.wave.2.fill" : "speaker.wave.3.fill"
}

// MARK: - App row

struct AppRow: View {
    @EnvironmentObject var model: AppModel
    let row: MixerRow
    @ObservedObject var engine: AudioEngine
    @ObservedObject var devices: DeviceMonitor
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        let s = model.appSettings(row.id)
        let meter = engine.meters.model(for: row.id)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 9) {
                AppIconView(id: row.id, bundlePath: row.bundlePath, category: row.category, size: 26,
                            dimmed: !row.isRunning)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(row.name).font(Theme.rowTitle()).lineLimit(1)
                        if row.isPlaying && !s.isMuted { ActivityBars(meter: meter) }
                        if row.isPinned { Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(.tertiary) }
                    }
                    statusLine(s)
                }
                Spacer(minLength: 4)
                Text(s.isMuted ? "Muted" : VolumeTaper.percentLabel(s.volume))
                    .font(Theme.mono(11))
                    .foregroundStyle(s.volume > 1.0001 && !s.isMuted ? Theme.boost : .secondary)
                    .frame(width: 42, alignment: .trailing)
                    .contentTransition(.numericText())
                IconButton(symbol: s.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                           help: s.isMuted ? "Unmute \(row.name)" : "Mute \(row.name)",
                           active: s.isMuted, tint: Theme.danger, size: 22) {
                    withAnimation(.easeOut(duration: 0.15)) { model.toggleMute(row.id) }
                }
                OutputMenu(devices: devices, current: s.outputDeviceUID) { model.setOutput(row.id, $0) }
                    .frame(width: 18)
                rowMenu(s)
            }
            VolumeFader(value: Binding(get: { model.appSettings(row.id).volume },
                                       set: { model.setVolume(row.id, $0) }),
                        maxValue: model.maxBoost, muted: s.isMuted,
                        meter: engine.isProcessing(row.id) ? meter : nil, height: 18)
                .padding(.leading, 35)
                .padding(.trailing, 4)
            if let err = engine.appErrors[row.id] {
                Label(err, systemImage: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.boost)
                    .padding(.leading, 35)
                    .lineLimit(3)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(focused ? 0.07 : (hovering ? 0.045 : 0)))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Theme.accent.opacity(focused ? 0.5 : 0), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onHover { h in
            hovering = h
            model.hoveredRowID = h ? row.id : (model.hoveredRowID == row.id ? nil : model.hoveredRowID)
        }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.leftArrow) { model.nudgeVolume(row.id, by: -model.settings.preferences.volumeStep); return .handled }
        .onKeyPress(.rightArrow) { model.nudgeVolume(row.id, by: model.settings.preferences.volumeStep); return .handled }
        .onKeyPress(characters: CharacterSet(charactersIn: "m")) { _ in model.toggleMute(row.id); return .handled }
        .onChange(of: focused) { _, f in if f { model.selectedAppID = row.id } }
        .contextMenu { menuItems(s) }
        .animation(.easeOut(duration: 0.12), value: hovering)
    }

    @ViewBuilder private func statusLine(_ s: AppAudioSettings) -> some View {
        HStack(spacing: 5) {
            if row.usesMicrophone {
                Label("Mic", systemImage: "mic.fill").labelStyle(.iconOnly).font(.system(size: 9)).foregroundStyle(Theme.boost)
            }
            if s.eq.isEnabled && !s.eq.isNeutral {
                Text(eqLabel(s)).badgeStyle()
            }
            if let info = engine.pathInfo[row.id] {
                if info.usingFallbackDevice {
                    Text("Preferred output unavailable · \(info.deviceName)").font(.system(size: 10)).foregroundStyle(Theme.boost)
                        .lineLimit(1)
                } else if s.outputDeviceUID != nil {
                    Text("→ \(info.deviceName)").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                }
            } else if !row.isRunning {
                Text("Not running").font(.system(size: 10)).foregroundStyle(.tertiary)
            } else if !row.isPlaying {
                Text("Silent").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
        }
    }

    private func eqLabel(_ s: AppAudioSettings) -> String {
        if let id = s.eq.presetID, let p = model.settings.preset(id: id) { return "EQ · \(p.name)" }
        return "EQ · Custom"
    }

    private func rowMenu(_ s: AppAudioSettings) -> some View {
        Menu { menuItems(s) } label: {
            Image(systemName: "ellipsis").font(.system(size: 11, weight: .bold)).foregroundStyle(.secondary)
                .frame(width: 16, height: 20)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    @ViewBuilder private func menuItems(_ s: AppAudioSettings) -> some View {
        Menu("Equalizer") {
            Button(s.eq.isEnabled ? "Turn EQ Off" : "Turn EQ On") {
                var eq = s.eq; eq.isEnabled.toggle(); model.setEQ(row.id, eq)
            }
            Divider()
            ForEach(model.allPresets) { p in
                Button {
                    model.applyPreset(p.id, to: row.id)
                } label: {
                    if s.eq.isEnabled && s.eq.presetID == p.id { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                }
            }
            Divider()
            Button("Edit Equalizer…") {
                model.selectedAppID = row.id
                NotificationCenter.default.post(name: .airmixOpenMixer, object: "eq")
            }
        }
        Button(s.isPinned ? "Unpin" : "Pin to Top") { model.togglePin(row.id) }
        Button("Hide from Mixer") { model.setHidden(row.id, true) }
        Button("Volume 100%") { model.setVolume(row.id, 1) }
        Divider()
        Button("Reset \(row.name)") { model.resetApp(row.id) }
        if !row.isRunning { Button("Forget \(row.name)") { model.forgetApp(row.id) } }
    }
}

extension Text {
    func badgeStyle() -> some View {
        self.font(.system(size: 9, weight: .semibold))
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Capsule().fill(Theme.accent.opacity(0.15)))
            .foregroundStyle(Theme.accent)
    }
}

// MARK: - Pieces

struct Banner: View {
    let symbol: String
    let tint: Color
    let title: String
    let message: String
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).font(.system(size: 14, weight: .semibold)).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 12, weight: .semibold))
                Text(message).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .buttonStyle(.borderless)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                        .padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(tint.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(tint.opacity(0.18), lineWidth: 0.5))
    }
}

struct EmptyMixer: View {
    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "waveform")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(Theme.fillGradient)
            Text("No apps are playing audio")
                .font(.system(size: 12, weight: .medium))
            Text("Apps appear here automatically as soon as they make a sound.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 22)
        .frame(maxWidth: .infinity)
    }
}

struct ProfilePill: View {
    let profile: Profile
    let active: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: profile.symbolName).font(.system(size: 10, weight: .semibold))
                Text(profile.name).font(.system(size: 11, weight: .medium))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(active ? AnyShapeStyle(Theme.fillGradient) : AnyShapeStyle(Color.primary.opacity(hovering ? 0.1 : 0.06)))
            )
            .foregroundStyle(active ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help("Switch to the \(profile.name) profile")
    }
}

struct ProfileMenu: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Menu {
            ForEach(model.settings.profiles) { p in
                Button {
                    model.activateProfile(p.id)
                } label: {
                    Label(p.name, systemImage: model.settings.activeProfileID == p.id ? "checkmark" : p.symbolName)
                }
            }
            Divider()
            Button("Save Current as Profile…") { NotificationCenter.default.post(name: .airmixOpenMixer, object: "profiles") }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.activeProfile?.symbolName ?? "slider.horizontal.3").font(.system(size: 10, weight: .semibold))
                Text(model.activeProfile?.name ?? "Custom").font(.system(size: 11, weight: .medium))
                Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Capsule().fill(Theme.track))
            .foregroundStyle(.primary)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("Audio profile")
    }
}
