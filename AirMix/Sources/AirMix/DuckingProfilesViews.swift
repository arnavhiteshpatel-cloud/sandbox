import AirMixAudio
import AirMixCore
import AppKit
import SwiftUI

// MARK: - App selector chips

struct AppSelectorEditor: View {
    @EnvironmentObject var model: AppModel
    @Binding var selector: AppSelector
    var placeholder = "Add apps or categories"

    var body: some View {
        FlowLayout(spacing: 6) {
            ForEach(selector.categories, id: \.self) { c in
                Chip(symbol: c.symbolName, title: c.displayName) { selector.categories.removeAll { $0 == c } }
            }
            ForEach(selector.bundleIDs, id: \.self) { id in
                Chip(symbol: nil, title: model.displayName(id), iconID: id) { selector.bundleIDs.removeAll { $0 == id } }
            }
            Menu {
                Section("Categories") {
                    ForEach(AppCategory.allCases, id: \.self) { c in
                        Button(c.displayName) { if !selector.categories.contains(c) { selector.categories.append(c) } }
                            .disabled(selector.categories.contains(c))
                    }
                }
                Section("Apps") {
                    ForEach(knownApps, id: \.0) { id, name in
                        Button(name) { if !selector.bundleIDs.contains(id) { selector.bundleIDs.append(id) } }
                            .disabled(selector.bundleIDs.contains(id))
                    }
                }
            } label: {
                Label(selector.isEmpty ? placeholder : "Add", systemImage: "plus").font(.system(size: 11))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }

    private var knownApps: [(String, String)] {
        var all: [String: String] = [:]
        for (id, k) in model.settings.knownApps { all[id] = k.displayName }
        for r in model.rows { all[r.id] = r.name }
        return all.sorted { $0.value.localizedCaseInsensitiveCompare($1.value) == .orderedAscending }.map { ($0.key, $0.value) }
    }
}

struct Chip: View {
    let symbol: String?
    let title: String
    var iconID: String? = nil
    let onRemove: () -> Void
    @EnvironmentObject var model: AppModel

    var body: some View {
        HStack(spacing: 5) {
            if let iconID {
                let k = model.settings.knownApps[iconID]
                AppIconView(id: iconID, bundlePath: k?.bundlePath, category: k?.category ?? .other, size: 14)
            } else if let symbol {
                Image(systemName: symbol).font(.system(size: 9, weight: .semibold))
            }
            Text(title).font(.system(size: 11, weight: .medium)).lineLimit(1)
            Button(action: onRemove) {
                Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Capsule().fill(Theme.accent.opacity(0.12)))
    }
}

/// Simple wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 500
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing
            maxX = max(maxX, x)
            rowH = max(rowH, sz.height)
        }
        return CGSize(width: min(width, maxX), height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
    }
}

// MARK: - Ducking

struct DuckingView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine

    var body: some View {
        Page(title: "Ducking", subtitle: "Automatically lower some apps while others are active — smoothly, without pumping between words.",
             trailing: AnyView(Button {
                 _ = model.addRule()
             } label: { Label("New Rule", systemImage: "plus") })) {
            ScrollView {
                VStack(spacing: 14) {
                    ForEach(model.settings.duckingRules) { rule in
                        DuckingRuleCard(rule: rule, amount: engine.duckingAmounts[rule.id] ?? 0)
                    }
                    Text("“Speech-like sound” compares the energy in the 300–3400 Hz voice band with the total, a lightweight heuristic that runs on your Mac. It can mistake some music for speech; “Microphone in use” is the most reliable trigger for calls.")
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 24)
            }
        }
    }
}

struct DuckingRuleCard: View {
    @EnvironmentObject var model: AppModel
    let rule: DuckingRule
    let amount: Double

    private func update(_ body: (inout DuckingRule) -> Void) {
        var r = rule
        body(&r)
        model.updateRule(r)
    }

    var body: some View {
        Card(padding: 16) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Toggle("", isOn: Binding(get: { rule.isEnabled }, set: { v in update { $0.isEnabled = v } }))
                        .toggleStyle(.switch).labelsHidden()
                    TextField("Rule name", text: Binding(get: { rule.name }, set: { v in update { $0.name = v } }))
                        .textFieldStyle(.plain)
                        .font(.system(size: 14, weight: .semibold))
                    Spacer()
                    if rule.isEnabled {
                        HStack(spacing: 6) {
                            Circle().fill(amount > 0.01 ? Theme.boost : Theme.meterLow).frame(width: 7, height: 7)
                            Text(amount > 0.01 ? "Ducking \(Int(amount * 100))%" : "Listening")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                        }
                        .animation(.easeOut, value: amount > 0.01)
                    }
                    Button(role: .destructive) { model.deleteRule(rule.id) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                        .help("Delete rule")
                }
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 12) {
                    GridRow {
                        Text("When").foregroundStyle(.secondary)
                        AppSelectorEditor(selector: Binding(get: { rule.triggers }, set: { v in update { $0.triggers = v } }))
                    }
                    GridRow {
                        Text("detects").foregroundStyle(.secondary)
                        Picker("", selection: Binding(get: { rule.mode }, set: { v in update { $0.mode = v } })) {
                            ForEach(DuckingTriggerMode.allCases, id: \.self) { Text($0.displayName).tag($0) }
                        }
                        .labelsHidden().fixedSize()
                    }
                    GridRow {
                        Text("lower").foregroundStyle(.secondary)
                        AppSelectorEditor(selector: Binding(get: { rule.targets }, set: { v in update { $0.targets = v } }))
                    }
                    GridRow {
                        Text("to").foregroundStyle(.secondary)
                        HStack {
                            Slider(value: Binding(get: { rule.duckVolume }, set: { v in update { $0.duckVolume = (v * 100).rounded() / 100 } }), in: 0...1)
                                .frame(maxWidth: 260)
                            Text(VolumeTaper.percentLabel(rule.duckVolume)).font(Theme.mono(12)).frame(width: 44)
                        }
                    }
                }
                .font(.system(size: 12))

                DisclosureGroup("Timing & sensitivity") {
                    Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                        timing("Fade down", value: rule.attack, range: 0.05...3, unit: "s") { v in update { $0.attack = v } }
                        timing("Fade back up", value: rule.release, range: 0.2...6, unit: "s") { v in update { $0.release = v } }
                        timing("Wait after silence", value: rule.hold, range: 0...8, unit: "s") { v in update { $0.hold = v } }
                        timing("Minimum activity", value: rule.minimumActivity, range: 0...2, unit: "s") { v in update { $0.minimumActivity = v } }
                        timing("Silence threshold", value: rule.thresholdDB, range: -70...(-20), unit: "dB") { v in update { $0.thresholdDB = v } }
                        if rule.mode == .voice || rule.mode == .voiceOrMicrophone {
                            timing("Voice sensitivity", value: 1 - rule.voiceRatio, range: 0.1...0.8, unit: "") { v in update { $0.voiceRatio = 1 - v } }
                        }
                    }
                    .padding(.top, 8)
                }
                .font(.system(size: 12))
            }
        }
    }

    private func timing(_ label: String, value: Double, range: ClosedRange<Double>, unit: String,
                        set: @escaping (Double) -> Void) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary).frame(width: 130, alignment: .leading)
            Slider(value: Binding(get: { value }, set: { set(($0 * 100).rounded() / 100) }), in: range).frame(maxWidth: 240)
            Text(unit == "dB" ? String(format: "%.0f dB", value) : unit.isEmpty ? String(format: "%.0f%%", value * 100) : String(format: "%.2f %@", value, unit))
                .font(Theme.mono(11)).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Profiles

struct ProfilesView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var devices: DeviceMonitor
    @State var selected: UUID?
    @State var newName = ""
    @State var naming = false

    var body: some View {
        Page(title: "Profiles", subtitle: "Save volumes, EQ, routing and ducking together; switch instantly from the menu bar.",
             trailing: AnyView(Button { newName = ""; naming = true } label: { Label("Save Current as Profile", systemImage: "plus") })) {
            HStack(alignment: .top, spacing: 16) {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(model.settings.profiles) { p in
                            Button { selected = p.id } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: p.symbolName).frame(width: 18).foregroundStyle(Theme.accent)
                                    Text(p.name).font(.system(size: 13, weight: .medium))
                                    Spacer()
                                    if model.settings.activeProfileID == p.id {
                                        Text("Active").badgeStyle()
                                    }
                                }
                                .padding(10)
                                .background(RoundedRectangle(cornerRadius: 9).fill(currentID == p.id ? Theme.accent.opacity(0.12) : Theme.cardFill))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(width: 220)
                if let id = currentID, let p = model.settings.profiles.first(where: { $0.id == id }) {
                    ProfileEditor(profile: p, devices: devices)
                }
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 20)
        }
        .sheet(isPresented: $naming) {
            VStack(alignment: .leading, spacing: 12) {
                Text("New Profile").font(.headline)
                Text("Captures every app’s current volume, mute, EQ preset and output, plus enabled ducking rules.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 300, alignment: .leading)
                TextField("Name", text: $newName).textFieldStyle(.roundedBorder)
                HStack {
                    Spacer()
                    Button("Cancel") { naming = false }
                    Button("Save") {
                        let p = model.createProfileFromCurrent(name: newName.isEmpty ? "My Profile" : newName)
                        selected = p.id
                        naming = false
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20)
            .frame(width: 340)
        }
    }

    private var currentID: UUID? { selected ?? model.settings.activeProfileID ?? model.settings.profiles.first?.id }
}

struct ProfileEditor: View {
    @EnvironmentObject var model: AppModel
    let profile: Profile
    @ObservedObject var devices: DeviceMonitor
    private let symbols = ["slider.horizontal.3", "book.fill", "film.fill", "phone.fill", "music.note", "gamecontroller.fill",
                           "moon.fill", "briefcase.fill", "headphones", "star.fill", "house.fill", "figure.run"]

    private func update(_ body: (inout Profile) -> Void) {
        var p = profile
        body(&p)
        model.updateProfile(p)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    Menu {
                        ForEach(symbols, id: \.self) { s in Button { update { $0.symbolName = s } } label: { Image(systemName: s) } }
                    } label: {
                        Image(systemName: profile.symbolName).font(.system(size: 16)).frame(width: 30, height: 30)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accent.opacity(0.15)))
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    TextField("Name", text: Binding(get: { profile.name }, set: { v in update { $0.name = v } }))
                        .textFieldStyle(.plain).font(.system(size: 18, weight: .semibold))
                    Spacer()
                    Button("Activate") { model.activateProfile(profile.id) }.keyboardShortcut(.defaultAction)
                    Button("Update from Current") { model.recaptureProfile(profile.id) }
                    Button(role: .destructive) { model.deleteProfile(profile.id) } label: { Image(systemName: "trash") }
                }

                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader(title: "Apps & categories", trailing: AnyView(addEntryMenu))
                        if profile.entries.isEmpty {
                            Text("No entries — this profile changes nothing yet.").font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        ForEach(profile.entries) { entry in
                            ProfileEntryRow(entry: entry, devices: devices) { new in
                                update { p in
                                    if let i = p.entries.firstIndex(where: { $0.id == entry.id }) {
                                        if let new { p.entries[i] = new } else { p.entries.remove(at: i) }
                                    }
                                }
                            }
                        }
                    }
                }

                Card {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader(title: "Ducking rules")
                        Toggle("Leave ducking rules unchanged", isOn: Binding(
                            get: { profile.enabledDuckingRules == nil },
                            set: { v in update { $0.enabledDuckingRules = v ? nil : [] } }))
                            .font(.system(size: 12))
                        if let enabled = profile.enabledDuckingRules {
                            ForEach(model.settings.duckingRules) { r in
                                Toggle(r.name, isOn: Binding(get: { enabled.contains(r.id) }, set: { on in
                                    update { p in
                                        var list = p.enabledDuckingRules ?? []
                                        if on { list.append(r.id) } else { list.removeAll { $0 == r.id } }
                                        p.enabledDuckingRules = list
                                    }
                                }))
                                .font(.system(size: 12))
                            }
                        }
                    }
                }

                Card {
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeader(title: "Switch automatically")
                        if !model.settings.preferences.autoProfileSwitching {
                            HStack {
                                Text("Automatic switching is off.").font(.system(size: 11)).foregroundStyle(.secondary)
                                Button("Turn On") { model.updatePreferences { $0.autoProfileSwitching = true } }.controlSize(.small)
                            }
                        }
                        Text("When one of these apps is in front:").font(.system(size: 12))
                        AppSelectorEditor(selector: Binding(
                            get: { AppSelector(bundleIDs: profile.autoActivation.frontmostBundleIDs) },
                            set: { v in update { $0.autoActivation.frontmostBundleIDs = v.bundleIDs } }), placeholder: "Add apps")
                        Text("When this output becomes the default:").font(.system(size: 12))
                        FlowLayout(spacing: 6) {
                            ForEach(profile.autoActivation.outputDeviceUIDs, id: \.self) { uid in
                                Chip(symbol: "hifispeaker.fill", title: devices.device(uid: uid)?.name ?? "Disconnected device") {
                                    update { $0.autoActivation.outputDeviceUIDs.removeAll { $0 == uid } }
                                }
                            }
                            Menu {
                                ForEach(devices.outputs) { d in
                                    Button(d.name) { update { if !$0.autoActivation.outputDeviceUIDs.contains(d.uid) { $0.autoActivation.outputDeviceUIDs.append(d.uid) } } }
                                }
                            } label: { Label("Add output", systemImage: "plus").font(.system(size: 11)) }
                                .menuStyle(.borderlessButton).fixedSize()
                        }
                    }
                }

                Card {
                    HStack {
                        SectionHeader(title: "Keyboard shortcut")
                        Spacer()
                        ShortcutField(binding: profileBinding)
                    }
                }
            }
        }
    }

    private var profileBinding: ShortcutBinding {
        if let b = model.settings.shortcuts.first(where: { if case .activateProfile(profile.id) = $0.action { return true }; return false }) {
            return b
        }
        return ShortcutBinding(action: .activateProfile(profile.id), combo: nil)
    }

    private var addEntryMenu: some View {
        Menu {
            Section("Category") {
                ForEach(AppCategory.allCases, id: \.self) { c in
                    Button(c.displayName) { update { $0.entries.append(ProfileEntry(target: .category(c), volume: 1)) } }
                }
            }
            Section("App") {
                ForEach(model.rows) { r in
                    Button(r.name) { update { $0.entries.append(ProfileEntry(target: .app(r.id), volume: 1)) } }
                }
            }
        } label: { Label("Add", systemImage: "plus").font(.system(size: 11)) }
            .menuStyle(.borderlessButton).fixedSize()
    }
}

struct ProfileEntryRow: View {
    @EnvironmentObject var model: AppModel
    let entry: ProfileEntry
    @ObservedObject var devices: DeviceMonitor
    let onChange: (ProfileEntry?) -> Void

    var body: some View {
        HStack(spacing: 10) {
            target.frame(width: 150, alignment: .leading)
            Toggle("", isOn: Binding(get: { entry.volume != nil }, set: { v in var e = entry; e.volume = v ? 1 : nil; onChange(e) }))
                .labelsHidden().controlSize(.mini)
            Slider(value: Binding(get: { entry.volume ?? 1 }, set: { v in var e = entry; e.volume = (v * 100).rounded() / 100; onChange(e) }),
                   in: 0...model.maxBoost)
                .disabled(entry.volume == nil)
                .frame(minWidth: 100)
            Text(entry.volume.map(VolumeTaper.percentLabel) ?? "—").font(Theme.mono(11)).frame(width: 40)
            Picker("", selection: Binding(get: { entry.isMuted.map { $0 ? 2 : 1 } ?? 0 },
                                         set: { v in var e = entry; e.isMuted = v == 0 ? nil : v == 2; onChange(e) })) {
                Text("Mute: keep").tag(0)
                Text("Unmuted").tag(1)
                Text("Muted").tag(2)
            }
            .labelsHidden().frame(width: 100).controlSize(.small)
            Picker("", selection: Binding(get: { entry.eqPresetID ?? "" }, set: { v in var e = entry; e.eqPresetID = v.isEmpty ? nil : v; onChange(e) })) {
                Text("EQ: keep").tag("")
                Text("EQ off").tag("off")
                ForEach(model.allPresets) { Text($0.name).tag($0.id) }
            }
            .labelsHidden().frame(width: 110).controlSize(.small)
            Picker("", selection: Binding(get: { entry.setsOutput ? (entry.outputDeviceUID ?? "default") : "" },
                                         set: { v in
                                             var e = entry
                                             e.setsOutput = !v.isEmpty
                                             e.outputDeviceUID = (v.isEmpty || v == "default") ? nil : v
                                             onChange(e)
                                         })) {
                Text("Output: keep").tag("")
                Text("System default").tag("default")
                ForEach(devices.outputs) { Text($0.name).tag($0.uid) }
            }
            .labelsHidden().frame(width: 130).controlSize(.small)
            Button { onChange(nil) } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
        }
        .font(.system(size: 12))
    }

    @ViewBuilder private var target: some View {
        switch entry.target {
        case .app(let id):
            HStack(spacing: 6) {
                let k = model.settings.knownApps[id]
                AppIconView(id: id, bundlePath: k?.bundlePath, category: k?.category ?? .other, size: 16)
                Text(model.displayName(id)).lineLimit(1)
            }
        case .category(let c):
            Label("All \(c.displayName)", systemImage: c.symbolName).lineLimit(1)
        }
    }
}

// MARK: - Shortcuts

struct ShortcutsView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Page(title: "Shortcuts", subtitle: "Global keyboard shortcuts work in every app. Click a field and press the keys.",
             trailing: AnyView(addMenu)) {
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(model.settings.shortcuts) { b in
                        HStack {
                            Text(title(for: b.action)).font(.system(size: 13))
                            Spacer()
                            if let err = model.hotKeyFailures[b.id] {
                                Label(err, systemImage: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(Theme.boost)
                            }
                            ShortcutField(binding: b)
                            if isRemovable(b.action) {
                                Button { model.removeShortcut(b.id) } label: { Image(systemName: "minus.circle") }.buttonStyle(.borderless)
                            }
                        }
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.cardFill))
                    }
                    Text("Tip: hold ⌥ and scroll over an app in the menu-bar mixer to change its volume. With a row selected, ← → change volume and M mutes.")
                        .font(.system(size: 11)).foregroundStyle(.tertiary).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 20)
            }
        }
    }

    private func title(for action: ShortcutAction) -> String {
        switch action {
        case .toggleMuteApp(let id): return "Mute \(model.displayName(id))"
        case .activateProfile(let id): return "Switch to “\(model.settings.profiles.first { $0.id == id }?.name ?? "profile")”"
        default: return action.displayName
        }
    }

    private func isRemovable(_ a: ShortcutAction) -> Bool {
        switch a {
        case .toggleMuteApp, .activateProfile: return true
        default: return false
        }
    }

    private var addMenu: some View {
        Menu {
            Menu("Mute an App") {
                ForEach(model.rows) { r in Button(r.name) { model.addShortcut(.toggleMuteApp(r.id)) } }
            }
            Menu("Switch to a Profile") {
                ForEach(model.settings.profiles) { p in Button(p.name) { model.addShortcut(.activateProfile(p.id)) } }
            }
        } label: { Label("Add Shortcut", systemImage: "plus") }
            .fixedSize()
    }
}

/// Shows a shortcut and records a new one when clicked.
struct ShortcutField: View {
    @EnvironmentObject var model: AppModel
    let binding: ShortcutBinding
    @State var recording = false
    @State var problem: String?

    var body: some View {
        HStack(spacing: 6) {
            if let problem {
                Text(problem).font(.system(size: 10)).foregroundStyle(Theme.danger).lineLimit(2).frame(maxWidth: 220, alignment: .trailing)
            }
            ZStack {
                RoundedRectangle(cornerRadius: 7).fill(recording ? Theme.accent.opacity(0.18) : Theme.track)
                Text(recording ? "Type shortcut…" : (binding.combo.map(KeyNames.display) ?? "Record Shortcut"))
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(binding.combo == nil && !recording ? .secondary : .primary)
                if recording {
                    KeyRecorder { combo in
                        recording = false
                        guard let combo else { return }
                        let issues = ShortcutConflicts.conflicts(for: combo, bindingID: binding.id, in: model.settings.shortcuts)
                        if let first = issues.first {
                            problem = first
                            return
                        }
                        problem = nil
                        assign(combo)
                    }
                    .frame(width: 1, height: 1)
                }
            }
            .frame(width: 150, height: 26)
            .onTapGesture { recording = true; problem = nil }
            if binding.combo != nil {
                Button { assign(nil) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary) }
                    .buttonStyle(.plain).help("Clear")
            }
        }
    }

    private func assign(_ combo: KeyCombo?) {
        if model.settings.shortcuts.contains(where: { $0.id == binding.id }) {
            model.setShortcut(binding.id, combo: combo)
        } else if let combo {
            model.addShortcut(binding.action)
            if let added = model.settings.shortcuts.last { model.setShortcut(added.id, combo: combo) }
        }
    }
}

/// Invisible first responder that captures one key combination (Esc cancels, ⌫ clears).
struct KeyRecorder: NSViewRepresentable {
    let onFinish: (KeyCombo?) -> Void

    func makeNSView(context: Context) -> RecorderView {
        let v = RecorderView()
        v.onFinish = onFinish
        DispatchQueue.main.async { v.window?.makeFirstResponder(v) }
        return v
    }

    func updateNSView(_ nsView: RecorderView, context: Context) { nsView.onFinish = onFinish }

    final class RecorderView: NSView {
        var onFinish: ((KeyCombo?) -> Void)?
        override var acceptsFirstResponder: Bool { true }

        override func keyDown(with event: NSEvent) {
            let code = UInt32(event.keyCode)
            if code == 53 { onFinish?(nil); return }                      // Esc
            let mods = KeyNames.carbonModifiers(event.modifierFlags)
            onFinish?(KeyCombo(keyCode: code, modifiers: mods))
        }

        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            keyDown(with: event)
            return true
        }

        override func resignFirstResponder() -> Bool {
            onFinish?(nil)
            return true
        }
    }
}
