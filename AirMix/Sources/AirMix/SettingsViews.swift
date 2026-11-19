import AirMixAudio
import AirMixCore
import AppKit
import SwiftUI

// MARK: - Devices & routing

struct DevicesView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine
    @ObservedObject var devices: DeviceMonitor

    var body: some View {
        Page(title: "Devices & Routing", subtitle: "Send each app to its own output. Preferences are remembered and restored when a device reconnects.") {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    SectionHeader(title: "Output devices")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), spacing: 12)], spacing: 12) {
                        ForEach(devices.outputs) { d in deviceCard(d) }
                    }
                    SectionHeader(title: "Per-app routing")
                    VStack(spacing: 6) {
                        ForEach(model.rows) { row in
                            HStack(spacing: 10) {
                                AppIconView(id: row.id, bundlePath: row.bundlePath, category: row.category, size: 22, dimmed: !row.isRunning)
                                Text(row.name).font(.system(size: 13))
                                Spacer()
                                if let info = engine.pathInfo[row.id] {
                                    Text(info.usingFallbackDevice ? "Preferred unavailable — using \(info.deviceName)" : "Playing on \(info.deviceName)")
                                        .font(.system(size: 11))
                                        .foregroundStyle(info.usingFallbackDevice ? Theme.boost : .secondary)
                                }
                                OutputMenu(devices: devices, current: model.appSettings(row.id).outputDeviceUID, compact: false) {
                                    model.setOutput(row.id, $0)
                                }
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .background(RoundedRectangle(cornerRadius: 9).fill(Theme.cardFill))
                        }
                    }
                    Text("Routing works with built-in, USB, Bluetooth, HDMI/DisplayPort and AirPlay outputs. Aggregate and Multi-Output devices can’t be nested inside AirMix’s per-app devices, so they’re unavailable as per-app targets. Apps that pick their own output device internally (some DAWs and call apps) are still captured, but routing them may override that app’s own choice.")
                        .font(.system(size: 11)).foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
            }
        }
    }

    private func deviceCard(_ d: OutputDevice) -> some View {
        let isDefault = d.uid == devices.defaultOutput?.uid
        return Card {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: d.symbolName).font(.system(size: 16)).foregroundStyle(Theme.accent).frame(width: 24)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(d.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                        Text(d.transport.displayName).font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if isDefault { Text("Default").badgeStyle() }
                }
                Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 3) {
                    info("Sample rate", d.sampleRate > 0 ? String(format: "%.1f kHz", d.sampleRate / 1000) : "—")
                    info("Channels", "\(d.outputChannels)")
                    info("Output latency", String(format: "%.1f ms", d.latencyMilliseconds))
                    info("Volume control", d.hasVolumeControl ? "Hardware" : "None (AirMix software volume)")
                    info("Per-app routing", d.supportsPerAppPlayback ? "Supported" : "Not supported")
                }
                if !isDefault {
                    Button("Use as System Output") { model.setDefaultOutput(d.uid) }.controlSize(.small)
                }
            }
        }
    }

    private func info(_ k: String, _ v: String) -> some View {
        GridRow {
            Text(k).font(.system(size: 11)).foregroundStyle(.secondary)
            Text(v).font(.system(size: 11))
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine

    private var prefs: Preferences { model.settings.preferences }
    private func bind<T>(_ kp: WritableKeyPath<Preferences, T>) -> Binding<T> {
        Binding(get: { model.settings.preferences[keyPath: kp] }, set: { v in model.updatePreferences { $0[keyPath: kp] = v } })
    }

    var body: some View {
        Page(title: "Settings") {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeader(title: "General")
                            Toggle("Launch AirMix at login", isOn: bind(\.launchAtLogin))
                            if let e = model.launchAtLoginError { Text(e).font(.system(size: 11)).foregroundStyle(Theme.danger) }
                            Toggle("Show volume percentage in the menu bar", isOn: bind(\.showVolumeInMenuBar))
                            Toggle("Show apps that aren’t playing", isOn: bind(\.showInactiveApps))
                            Toggle("Switch profiles automatically (frontmost app / output device)", isOn: bind(\.autoProfileSwitching))
                            Toggle("⌥-scroll over an app to change its volume", isOn: bind(\.scrollToAdjust))
                            HStack {
                                Text("Shortcut volume step")
                                Picker("", selection: bind(\.volumeStep)) {
                                    Text("2%").tag(0.02); Text("5%").tag(0.05); Text("10%").tag(0.1)
                                }
                                .labelsHidden().fixedSize()
                            }
                            if !model.hiddenRows.isEmpty {
                                Divider()
                                Text("Hidden apps").font(.system(size: 12, weight: .medium))
                                ForEach(model.hiddenRows) { r in
                                    HStack {
                                        Text(r.name)
                                        Spacer()
                                        Button("Show") { model.setHidden(r.id, false) }.controlSize(.small)
                                    }
                                }
                            }
                        }
                        .font(.system(size: 12))
                    }

                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeader(title: "Audio")
                            HStack {
                                Text("Maximum app volume")
                                Picker("", selection: bind(\.maxBoost)) {
                                    Text("100% (no boost)").tag(1.0)
                                    Text("150%").tag(1.5)
                                    Text("200%").tag(2.0)
                                }
                                .labelsHidden().fixedSize()
                            }
                            Toggle("Peak limiter (prevents clipping; always on while boosting)", isOn: bind(\.limiterEnabled))
                            Toggle("Only process apps whose settings differ from default", isOn: bind(\.processOnlyAdjustedApps))
                            Text("When on, untouched apps bypass AirMix completely (zero added latency) but have no live meters.")
                                .font(.system(size: 11)).foregroundStyle(.tertiary)
                            HStack {
                                Text("Keep an app’s audio path after it goes quiet for")
                                Picker("", selection: bind(\.inactiveGracePeriod)) {
                                    Text("10 s").tag(10.0); Text("30 s").tag(30.0); Text("2 min").tag(120.0); Text("10 min").tag(600.0)
                                }
                                .labelsHidden().fixedSize()
                            }
                        }
                        .font(.system(size: 12))
                    }

                    PrivacyCard()
                    DiagnosticsCard(engine: engine)
                    AboutCard()
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
            }
        }
    }
}

struct PrivacyCard: View {
    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Permissions & privacy")
                Label("System Audio Recording", systemImage: "waveform.badge.mic").font(.system(size: 12, weight: .semibold))
                Text("AirMix changes an app’s volume by tapping that app’s audio with Apple’s Core Audio process taps and playing it back with your settings applied. macOS treats any tap as “system audio recording”, so it asks once. That is the only permission AirMix needs: no microphone, accessibility, screen-recording, network or admin access, and nothing is installed into the system.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("Audio is processed in memory, in real time, on this Mac. It is never recorded, saved or sent anywhere. AirMix has no accounts, analytics or network features. Settings are stored in ~/Library/Application Support/AirMix.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("Open Privacy Settings…") {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .controlSize(.small)
            }
        }
    }
}

struct DiagnosticsCard: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Diagnostics & recovery")
                HStack(spacing: 10) {
                    Button("Reset Audio") { model.resetAudio() }
                    Button(engine.isPaused ? "Resume AirMix" : "Pause AirMix") { engine.setPaused(!engine.isPaused) }
                    Button(model.selfTestRunning ? "Testing…" : "Run Independence Test") { model.runSelfTest() }
                        .disabled(model.selfTestRunning)
                    Button("Show Settings File") { NSWorkspace.shared.activateFileViewerSelecting([model.exportSettingsURL()]) }
                }
                .controlSize(.small)
                Text("The independence test plays a 440 Hz and a 660 Hz tone from two separate processes for about 8 seconds, sets different volumes on each through AirMix, and measures what actually reaches your output.")
                    .font(.system(size: 11)).foregroundStyle(.tertiary)
                if let r = model.selfTestReport { SelfTestResultView(report: r) }

                Divider()
                Text("Active audio paths").font(.system(size: 12, weight: .medium))
                if engine.pathInfo.isEmpty {
                    Text("None — no app is being processed right now.").font(.system(size: 11)).foregroundStyle(.secondary)
                }
                ForEach(engine.pathInfo.sorted(by: { $0.key < $1.key }), id: \.key) { key, info in
                    HStack {
                        Text(model.displayName(key)).font(.system(size: 11, weight: .medium)).frame(width: 140, alignment: .leading)
                        Text(info.deviceName).font(.system(size: 11)).frame(width: 160, alignment: .leading)
                        Text(String(format: "%.1f kHz", info.sampleRate / 1000)).font(Theme.mono(11)).frame(width: 64, alignment: .leading)
                        Text(String(format: "+%.1f ms", info.addedLatencyMs)).font(Theme.mono(11)).frame(width: 64, alignment: .leading)
                            .help("Extra latency added by AirMix's audio path")
                        Text("\(info.processCount) proc").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
                if !engine.recoveryLog.isEmpty {
                    Divider()
                    Text("Event log").font(.system(size: 12, weight: .medium))
                    ScrollView {
                        Text(engine.recoveryLog.suffix(40).joined(separator: "\n"))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 140)
                }
            }
        }
    }
}

struct SelfTestResultView: View {
    let report: IndependenceTest.Report

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(report.passed ? "Passed — apps are controlled independently" : (report.conclusive ? "Failed" : "Inconclusive"),
                  systemImage: report.passed ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(report.passed ? Theme.meterLow : Theme.boost)
                .font(.system(size: 12, weight: .semibold))
            ForEach(Array(report.phases.enumerated()), id: \.offset) { _, p in
                Text(String(format: "440 Hz app %3.0f%%  ·  660 Hz app %3.0f%%  →  measured %+.1f dB (expected %@)  %@",
                            p.gainA * 100, p.gainB * 100, p.measuredDifferenceDB,
                            p.expectedDifferenceDB.map { String(format: "%+.1f dB", $0) } ?? "< −40 dB",
                            p.passed ? "✓" : "✗"))
                    .font(.system(size: 11, design: .monospaced))
            }
            ForEach(report.notes, id: \.self) { Text($0).font(.system(size: 11)).foregroundStyle(.secondary) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 9).fill(Theme.cardFill))
    }
}

struct AboutCard: View {
    var body: some View {
        Card {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.fillGradient).frame(width: 40, height: 40)
                    Image(systemName: "slider.vertical.3").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("AirMix \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")")
                        .font(.system(size: 13, weight: .semibold))
                    Text("Free, local, per-app audio control for macOS. Built on Core Audio process taps — no drivers.")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
        }
    }
}
