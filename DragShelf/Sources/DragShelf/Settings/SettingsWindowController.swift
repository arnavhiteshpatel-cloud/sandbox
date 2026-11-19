import AppKit
import SwiftUI
import Carbon.HIToolbox
import DragShelfCore

final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let window: NSWindow
    private weak var app: AppController?

    init(app: AppController) {
        self.app = app
        let hosting = NSHostingController(rootView: SettingsView(app: app, settingsStore: app.settingsStore,
                                                                  model: app.model, status: app.status))
        window = NSWindow(contentViewController: hosting)
        window.title = "DragShelf Settings"
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 540, height: 500))
        window.center()
        super.init()
        window.delegate = self
    }

    func show() {
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        app?.setShortcutRecording(false)
    }
}

// MARK: - Views

struct SettingsView: View {
    let app: AppController
    @ObservedObject var settingsStore: SettingsStore
    @ObservedObject var model: ShelfModel
    @ObservedObject var status: AppStatus

    var body: some View {
        TabView {
            GeneralSettings(app: app, settingsStore: settingsStore, status: status)
                .tabItem { Label("General", systemImage: "gearshape") }
            ActivationSettings(settingsStore: settingsStore)
                .tabItem { Label("Activation", systemImage: "sidebar.right") }
            StorageSettings(app: app, settingsStore: settingsStore, model: model)
                .tabItem { Label("Storage", systemImage: "internaldrive") }
            PrivacySettings(settingsStore: settingsStore)
                .tabItem { Label("Privacy", systemImage: "hand.raised") }
        }
        .frame(width: 540, height: 500)
    }
}

private struct GeneralSettings: View {
    let app: AppController
    @ObservedObject var settingsStore: SettingsStore
    @ObservedObject var status: AppStatus
    @State private var launchAtLogin = false

    var body: some View {
        Form {
            Section {
                Toggle("Open DragShelf at login", isOn: Binding(
                    get: { launchAtLogin },
                    set: { on in app.setLaunchAtLogin(on); launchAtLogin = app.launchAtLogin }))
                if let msg = status.launchAtLoginMessage {
                    Text(msg).font(.caption).foregroundStyle(.secondary)
                }
                Toggle("Show menu-bar icon", isOn: $settingsStore.settings.showMenuBarIcon)
                if !settingsStore.settings.showMenuBarIcon {
                    Text("To reopen Settings later, open DragShelf again from Applications or Spotlight, or press ⌘, while the shelf is open.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Keyboard shortcuts") {
                LabeledContent("Show or hide shelf") {
                    ShortcutField(combo: $settingsStore.settings.toggleShortcut, onRecording: app.setShortcutRecording)
                }
                Toggle("Add clipboard with a shortcut", isOn: $settingsStore.settings.clipboardShortcutEnabled)
                if settingsStore.settings.clipboardShortcutEnabled {
                    LabeledContent("Add clipboard to shelf") {
                        ShortcutField(combo: $settingsStore.settings.clipboardShortcut, onRecording: app.setShortcutRecording)
                    }
                }
                ForEach(status.hotKeyProblems, id: \.self) { p in
                    Label(p, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.caption)
                }
                Text("Press Esc while the shelf is focused to hide it. Hiding never removes items.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Appearance") {
                Picker("Shelf size", selection: $settingsStore.settings.shelfSize) {
                    ForEach(ShelfSize.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Picker("Appearance", selection: $settingsStore.settings.appearance) {
                    ForEach(AppearanceMode.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Picker("Animations", selection: $settingsStore.settings.animationStyle) {
                    ForEach(AnimationStyle.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                Text("Animations are reduced automatically when “Reduce motion” is on in Accessibility settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Dragging") {
                Toggle("Stack items dropped together", isOn: $settingsStore.settings.stackMultiItemDrops)
                Toggle("Remove items from the shelf after dragging them out", isOn: $settingsStore.settings.removeAfterDragOut)
                Toggle("Allow moving original files when dragging out", isOn: $settingsStore.settings.allowMovingOriginals)
                Text(settingsStore.settings.allowMovingOriginals
                     ? "Finder may move an original file to the drop location (same volume)."
                     : "Dragging out always copies, so original files stay where they are.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section {
                HStack {
                    Spacer()
                    Button("Restore Defaults") { settingsStore.resetToDefaults() }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { launchAtLogin = app.launchAtLogin }
    }
}

private struct ActivationSettings: View {
    @ObservedObject var settingsStore: SettingsStore

    private func edgeBinding(_ e: ScreenEdge) -> Binding<Bool> {
        Binding(get: { settingsStore.settings.edges.contains(e) },
                set: { on in
                    if on { settingsStore.settings.edges.insert(e) } else { settingsStore.settings.edges.remove(e) }
                })
    }

    var body: some View {
        Form {
            Section {
                HStack(spacing: 16) {
                    ForEach(ScreenEdge.allCases, id: \.self) { e in
                        Toggle(e.title, isOn: edgeBinding(e))
                    }
                }
                Picker("Hot corner", selection: $settingsStore.settings.corner) {
                    Text("None").tag(ScreenCorner?.none)
                    ForEach(ScreenCorner.allCases, id: \.self) { c in Text(c.title).tag(ScreenCorner?.some(c)) }
                }
                Picker("Displays", selection: $settingsStore.settings.displayMode) {
                    ForEach(DisplayMode.allCases, id: \.self) { Text($0.title).tag($0) }
                }
            } header: {
                Text("Reveal the shelf when a drag reaches")
            } footer: {
                Text("Edges shared with another display are pass-throughs and never activate. The shelf is placed inside the visible area, clear of the menu bar and Dock.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Sensitivity") {
                SliderRow(title: "Edge thickness", value: $settingsStore.settings.edgeSensitivity, range: 2...30, step: 1, format: { "\(Int($0)) pt" })
                SliderRow(title: "Activation delay", value: $settingsStore.settings.activationDelay, range: 0...1.5, step: 0.05, format: { String(format: "%.2f s", $0) })
                Toggle("Also reveal a shelf that holds items when the pointer rests at the edge", isOn: $settingsStore.settings.revealOnHover)
                if settingsStore.settings.revealOnHover {
                    SliderRow(title: "Extra delay without a drag", value: $settingsStore.settings.hoverDelay, range: 0.2...2, step: 0.05, format: { String(format: "%.2f s", $0) })
                }
            }

            Section("Hiding") {
                SliderRow(title: "Hide empty shelf after", value: $settingsStore.settings.emptyHideDelay, range: 0.3...5, step: 0.1, format: { String(format: "%.1f s", $0) })
                SliderRow(title: "Hide shelf with items after", value: $settingsStore.settings.collapseDelay, range: 0.3...10, step: 0.1, format: { String(format: "%.1f s", $0) })
                Text("A pinned shelf stays until unpinned. While you drag items out of the shelf it stays open until the drag finishes.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

private struct SliderRow: View {
    let title: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let format: (Double) -> String

    var body: some View {
        LabeledContent(title) {
            HStack {
                Slider(value: $value, in: range, step: step)
                    .frame(width: 180)
                    .accessibilityLabel(title)
                    .accessibilityValue(format(value))
                Text(format(value))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .frame(width: 56, alignment: .trailing)
            }
        }
    }
}

private struct StorageSettings: View {
    let app: AppController
    @ObservedObject var settingsStore: SettingsStore
    @ObservedObject var model: ShelfModel
    @State private var confirmClear = false

    private let limits: [Double] = [250, 500, 1024, 2048, 5120, 10240, 25600]

    var body: some View {
        Form {
            Section {
                Picker("Keep items", selection: $settingsStore.settings.retention) {
                    ForEach(RetentionPolicy.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                if settingsStore.settings.retention == .afterInterval {
                    Stepper(value: $settingsStore.settings.retentionHours, in: 1...(24 * 30), step: 1) {
                        Text("For \(Int(settingsStore.settings.retentionHours)) hour\(Int(settingsStore.settings.retentionHours) == 1 ? "" : "s") after adding")
                    }
                }
            } footer: {
                Text(settingsStore.settings.retention == .clearOnQuit
                     ? "Shelves start empty each time DragShelf launches."
                     : "Shelves are restored when DragShelf launches.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Storage") {
                LabeledContent("Copies kept by DragShelf") {
                    Text(ByteCountFormatter.string(fromByteCount: model.storageBytes, countStyle: .file))
                        .monospacedDigit()
                        .foregroundStyle(model.storageOverLimit ? Color.orange : Color.secondary)
                }
                Picker("Warn above", selection: $settingsStore.settings.storageLimitMB) {
                    ForEach(limits, id: \.self) { mb in
                        Text(ByteCountFormatter.string(fromByteCount: Int64(mb * 1024 * 1024), countStyle: .file)).tag(mb)
                    }
                    if !limits.contains(settingsStore.settings.storageLimitMB) {
                        Text("\(Int(settingsStore.settings.storageLimitMB)) MB").tag(settingsStore.settings.storageLimitMB)
                    }
                }
                Text("Files and folders you drop are kept as references to the originals and use no space. Copies are made only for content that has no file of its own — text, links, images from browsers, screenshots, promised files.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Show Storage Folder") { app.revealStorageFolder() }
                    Spacer()
                    Button("Clear All Shelves…") { confirmClear = true }
                        .disabled(model.library.totalItemCount == 0)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { model.refreshStorageUsage() }
        .alert("Clear all shelves?", isPresented: $confirmClear) {
            Button("Clear", role: .destructive) { app.clearAllShelves() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes every item from every shelf and deletes DragShelf's stored copies. Your original files are not touched.")
        }
    }
}

private struct PrivacySettings: View {
    @ObservedObject var settingsStore: SettingsStore

    var body: some View {
        Form {
            Section("Clipboard") {
                Toggle("Keep a clipboard history on a “Clipboard” shelf", isOn: $settingsStore.settings.clipboardHistoryEnabled)
                Text("Off by default. When on, new clipboard contents are copied to a separate shelf (last \(ClipboardWatcher.maxEntries) entries). Content that apps mark as private, such as passwords from password managers, is never recorded.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Network") {
                Toggle("Load website icons for links", isOn: $settingsStore.settings.loadWebsiteIcons)
                Text("Off by default. When on, DragShelf requests /favicon.ico directly from a link’s own website. Nothing else ever uses the network.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Permissions") {
                VStack(alignment: .leading, spacing: 8) {
                    Label("No special permissions are required.", systemImage: "checkmark.shield")
                    Text("DragShelf notices drags by observing mouse-button and drag events, which macOS allows without Accessibility access. It never reads your keystrokes (the shortcuts are registered with the system, which delivers only those key combinations), never records the screen, and has no accounts, analytics, ads or cloud service.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("macOS may ask once whether DragShelf can access a protected folder (Desktop, Documents, Downloads) when it restores references to files stored there after a restart.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Dropped content is treated as untrusted: nothing is executed, and opening an app or script from the shelf always asks first.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: - Shortcut recorder

struct ShortcutField: View {
    @Binding var combo: KeyCombo?
    let onRecording: (Bool) -> Void
    @StateObject private var recorder = KeyRecorder()

    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            HStack(spacing: 6) {
                Button {
                    if recorder.isRecording {
                        recorder.stop()
                    } else {
                        recorder.start { new in combo = new }
                    }
                } label: {
                    Text(recorder.isRecording ? "Type shortcut…" : (combo?.displayString ?? "Record Shortcut"))
                        .frame(minWidth: 120)
                }
                .accessibilityLabel(recorder.isRecording ? "Recording shortcut" : "Shortcut \(combo?.displayString ?? "none"). Click to change.")
                if combo != nil && !recorder.isRecording {
                    Button { combo = nil } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .help("Remove shortcut")
                        .accessibilityLabel("Remove shortcut")
                }
            }
            if let m = recorder.message {
                Text(m).font(.caption).foregroundStyle(.orange)
            }
        }
        .onChange(of: recorder.isRecording) { onRecording($0) }
        .onDisappear { recorder.stop() }
    }
}

final class KeyRecorder: ObservableObject {
    @Published var isRecording = false
    @Published var message: String?
    private var monitor: Any?

    func start(_ done: @escaping (KeyCombo) -> Void) {
        stop()
        message = nil
        isRecording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if Int(event.keyCode) == kVK_Escape && flags.isEmpty {
                self.stop()
                return nil
            }
            let combo = KeyCombo(keyCode: UInt32(event.keyCode), modifiers: KeyNames.carbonModifiers(from: flags),
                                 keyName: KeyNames.name(for: event))
            guard combo.isValidGlobalShortcut else {
                self.message = "Include ⌘, ⌥ or ⌃ in the shortcut."
                NSSound.beep()
                return nil
            }
            done(combo)
            self.stop()
            return nil
        }
    }

    func stop() {
        if let m = monitor { NSEvent.removeMonitor(m) }
        monitor = nil
        if isRecording { isRecording = false }
    }

    deinit { stop() }
}
