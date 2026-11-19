import AppKit
import Combine
import ServiceManagement
import DragShelfCore

/// Status shown in Settings.
final class AppStatus: ObservableObject {
    @Published var hotKeyProblems: [String] = []
    @Published var launchAtLoginMessage: String?
}

/// Wires everything together. Owns no UI of its own besides the status item.
final class AppController: NSObject {
    let settingsStore = SettingsStore()
    let status = AppStatus()
    let store: ShelfStore
    let model: ShelfModel
    let ingestor: PasteboardIngestor
    let shelf: ShelfController
    let dragMonitor: DragMonitor
    let statusItem = StatusItemController()
    let clipboard = ClipboardWatcher()
    private var settingsWindow: SettingsWindowController?
    private var cancellables = Set<AnyCancellable>()
    private var retentionWork: DispatchWorkItem?

    var settings: DragShelfSettings { settingsStore.settings }

    static var storageDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("DragShelf", isDirectory: true)
    }

    override init() {
        let s: ShelfStore
        do {
            s = try ShelfStore(rootURL: Self.storageDirectory)
        } catch {
            NSLog("DragShelf: storage unavailable (\(error)); using a temporary folder this session")
            s = try! ShelfStore(rootURL: FileManager.default.temporaryDirectory.appendingPathComponent("DragShelf-\(UUID().uuidString)"))
        }
        store = s

        var library = ShelfLibrary()
        if Retention.shouldRestore(policy: settingsStore.settings.retention) {
            switch s.load() {
            case .loaded(let l): library = l
            case .corrupt(let aside): NSLog("DragShelf: saved shelf was unreadable and was moved to \(aside?.path ?? "?")")
            case .none: break
            }
        }
        model = ShelfModel(store: s, library: library)
        ingestor = PasteboardIngestor(store: s)
        shelf = ShelfController(model: model, settingsStore: settingsStore, ingestor: ingestor)
        dragMonitor = DragMonitor(settings: settingsStore.settings)
        super.init()
    }

    // MARK: Lifecycle

    func start() {
        shelf.dragMonitor = dragMonitor
        statusItem.app = self

        // Wiring
        dragMonitor.onActivate = { [weak self] hit, reason in
            guard let self = self else { return }
            if reason == .hover && (self.shelf.isShown || self.model.library.totalItemCount == 0) { return }
            self.shelf.reveal(from: hit, reason: reason)
        }
        shelf.onVisibilityChanged = { [weak self] _ in
            self?.updateHoverMonitoring()
            self?.statusItem.refresh()
        }
        shelf.openSettingsHandler = { [weak self] in self?.openSettings() }
        shelf.addClipboardHandler = { [weak self] in self?.addClipboardToShelf() }
        shelf.clipboardWriteHandler = { [weak self] in self?.clipboard.ignoreCurrentContents() }
        model.onLibraryChanged = { [weak self] in
            guard let self = self else { return }
            self.shelf.libraryChanged()
            self.updateHoverMonitoring()
            self.scheduleRetention()
            self.statusItem.refresh()
        }
        clipboard.onNewContent = { [weak self] pb in self?.captureClipboardHistory(pb) }

        // Restore-time housekeeping
        if !Retention.shouldRestore(policy: settings.retention) {
            store.deleteState()
        }
        purgeExpired()
        model.collectGarbage()
        model.refreshAvailability()

        dragMonitor.start()
        apply(settings)

        settingsStore.$settings
            .dropFirst()
            .removeDuplicates()
            .receive(on: DispatchQueue.main)   // apply after the new value is stored
            .sink { [weak self] s in self?.apply(s) }
            .store(in: &cancellables)

        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake),
                                                          name: NSWorkspace.didWakeNotification, object: nil)
    }

    func prepareForTermination() {
        if settings.retention == .clearOnQuit {
            model.mutate { _ = $0.clearAll() }
            model.dropUndoHistory()
            model.flush()
            model.collectGarbage()
            store.deleteState()
        } else {
            model.flush()
        }
    }

    // MARK: Settings

    func apply(_ s: DragShelfSettings) {
        dragMonitor.apply(s)
        shelf.apply(s)
        applyHotKeys(s)
        statusItem.setVisible(s.showMenuBarIcon)
        clipboard.setEnabled(s.clipboardHistoryEnabled)
        model.storageLimitBytes = Int64(s.storageLimitMB * 1024 * 1024)
        model.refreshStorageUsage()
        scheduleRetention()
        updateHoverMonitoring()
    }

    func applyHotKeys(_ s: DragShelfSettings) {
        HotKeyCenter.shared.isSuspended = false
        var problems: [String] = []
        let ok = HotKeyCenter.shared.register(.toggleShelf, combo: s.toggleShortcut) { [weak self] in
            self?.shelf.toggleFromShortcut()
        }
        if !ok, let c = s.toggleShortcut { problems.append("\(c.displayString) is already used by another app.") }
        if s.clipboardShortcutEnabled {
            let ok2 = HotKeyCenter.shared.register(.addClipboard, combo: s.clipboardShortcut) { [weak self] in
                self?.addClipboardToShelf()
            }
            if !ok2, let c = s.clipboardShortcut { problems.append("\(c.displayString) is already used by another app.") }
        } else {
            HotKeyCenter.shared.unregister(.addClipboard)
        }
        status.hotKeyProblems = problems
    }

    /// While Settings records a new shortcut, the old ones must not swallow the keystroke.
    func setShortcutRecording(_ recording: Bool) {
        if recording {
            HotKeyCenter.shared.unregisterAll()
            HotKeyCenter.shared.isSuspended = true
        } else {
            applyHotKeys(settings)
        }
    }

    private func updateHoverMonitoring() {
        let wanted = settings.revealOnHover && !shelf.isShown && model.library.totalItemCount > 0
        dragMonitor.setHoverMonitoring(wanted)
    }

    @objc private func screensChanged() {
        dragMonitor.refreshScreens()
        shelf.screensChanged()
    }

    @objc private func didWake() {
        dragMonitor.refreshScreens()
        scheduleRetention()
        model.refreshAvailability()
    }

    // MARK: Retention

    private func purgeExpired() {
        let expired = Retention.expiredItemIDs(in: model.library, policy: settings.retention,
                                               hours: settings.retentionHours, now: Date())
        guard !expired.isEmpty else { return }
        model.mutate { $0.removeItems(expired) }
        model.dropUndoHistory()
        model.collectGarbage()
    }

    /// One one-shot timer for the next expiry — no polling.
    private func scheduleRetention() {
        retentionWork?.cancel()
        retentionWork = nil
        guard settings.retention == .afterInterval else { return }
        purgeExpired()
        guard let next = Retention.nextExpiry(in: model.library, policy: settings.retention, hours: settings.retentionHours) else { return }
        let work = DispatchWorkItem { [weak self] in self?.scheduleRetention() }
        retentionWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(1, next.timeIntervalSinceNow + 0.5), execute: work)
    }

    // MARK: Clipboard

    /// Adds the current clipboard contents to the active shelf (explicit user action).
    func addClipboardToShelf() {
        let result = ingestor.ingest(NSPasteboard.general, allowPromises: false) { _ in }
        guard !result.items.isEmpty else {
            NSSound.beep()
            return
        }
        model.add(result.items, stack: settings.stackMultiItemDrops)
        shelf.flash()
    }

    /// Optional clipboard history (off by default): copies land on a separate "Clipboard" shelf.
    private func captureClipboardHistory(_ pb: NSPasteboard) {
        let result = ingestor.ingest(pb, allowPromises: false) { _ in }
        guard !result.items.isEmpty else { return }
        var lib = model.library
        let shelfID: UUID
        if let existing = lib.shelves.first(where: { $0.name == ClipboardWatcher.shelfName }) {
            shelfID = existing.id
        } else {
            shelfID = lib.newShelf(name: ClipboardWatcher.shelfName, activate: false)
            model.mutate { $0 = lib }
        }
        // Skip an exact repeat of the latest text.
        if result.items.count == 1, case .data(let new) = result.items[0].content,
           let last = model.library.shelves.first(where: { $0.id == shelfID })?.entries.last?.items.last,
           case .data(let old) = last.content, new.text != nil, new.text == old.text {
            model.collectGarbage()
            return
        }
        model.mutate { lib in
            lib.add(result.items, to: shelfID, stack: true)
            if let i = lib.shelfIndex(shelfID), lib.shelves[i].entries.count > ClipboardWatcher.maxEntries {
                lib.shelves[i].entries.removeFirst(lib.shelves[i].entries.count - ClipboardWatcher.maxEntries)
            }
        }
        model.collectGarbage()
    }

    // MARK: Launch at login

    var launchAtLogin: Bool {
        SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            if SMAppService.mainApp.status == .requiresApproval {
                status.launchAtLoginMessage = "Allow DragShelf in System Settings › General › Login Items."
            } else {
                status.launchAtLoginMessage = nil
            }
        } catch {
            status.launchAtLoginMessage = "Couldn't change login item: \(error.localizedDescription)"
        }
        objectWillChangeLaunch()
    }

    private func objectWillChangeLaunch() {
        status.objectWillChange.send()
    }

    // MARK: Windows & misc

    func openSettings() {
        if settingsWindow == nil {
            settingsWindow = SettingsWindowController(app: self)
        }
        settingsWindow?.show()
    }

    func clearAllShelves() {
        model.mutate(undoable: true) { _ = $0.clearAll() }
        model.collectGarbage()
    }

    func revealStorageFolder() {
        NSWorkspace.shared.activateFileViewerSelecting([store.rootURL])
    }
}
