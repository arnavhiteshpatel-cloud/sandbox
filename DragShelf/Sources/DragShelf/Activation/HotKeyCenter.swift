import AppKit
import Carbon.HIToolbox
import DragShelfCore

/// System-wide keyboard shortcuts via Carbon's RegisterEventHotKey.
/// This is the supported way to get global hotkeys without Accessibility permission:
/// only the registered key combination is delivered to DragShelf — no other keystrokes are seen.
final class HotKeyCenter {
    static let shared = HotKeyCenter()

    enum ID: UInt32 {
        case toggleShelf = 1
        case addClipboard = 2
    }

    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var handlers: [UInt32: () -> Void] = [:]
    private var handlerInstalled = false
    private static let signature: OSType = 0x4453_4846 // 'DSHF'

    /// Registers (or replaces) a hotkey. Returns false if the combination is taken by another app.
    @discardableResult
    func register(_ id: ID, combo: KeyCombo?, handler: @escaping () -> Void) -> Bool {
        unregister(id)
        guard let combo = combo, combo.isValidGlobalShortcut else { return true }
        installHandlerIfNeeded()
        var ref: EventHotKeyRef?
        let hkID = EventHotKeyID(signature: Self.signature, id: id.rawValue)
        let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, hkID, GetApplicationEventTarget(), 0, &ref)
        guard status == noErr, let r = ref else { return false }
        refs[id.rawValue] = r
        handlers[id.rawValue] = handler
        return true
    }

    func unregister(_ id: ID) {
        if let r = refs.removeValue(forKey: id.rawValue) { UnregisterEventHotKey(r) }
        handlers.removeValue(forKey: id.rawValue)
    }

    func unregisterAll() {
        for r in refs.values { UnregisterEventHotKey(r) }
        refs.removeAll()
        handlers.removeAll()
    }

    /// While true, hotkey presses are ignored (the owner also unregisters them while the
    /// Settings shortcut recorder is active, so the combination reaches the recorder).
    var isSuspended = false

    fileprivate func fire(_ id: UInt32) {
        guard !isSuspended else { return }
        handlers[id]?()
    }

    private func installHandlerIfNeeded() {
        guard !handlerInstalled else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(GetApplicationEventTarget(), dragShelfHotKeyHandler, 1, &spec, nil, nil)
        handlerInstalled = (status == noErr)
    }
}

/// C callback for Carbon hotkey events (runs on the main thread).
private func dragShelfHotKeyHandler(_ next: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event = event else { return OSStatus(eventNotHandledErr) }
    var hkID = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                   nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID)
    guard status == noErr else { return status }
    HotKeyCenter.shared.fire(hkID.id)
    return noErr
}

// MARK: - Key names / modifier conversion

enum KeyNames {
    static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
        var m: UInt32 = 0
        if flags.contains(.command) { m |= KeyCombo.carbonCmd }
        if flags.contains(.shift) { m |= KeyCombo.carbonShift }
        if flags.contains(.option) { m |= KeyCombo.carbonOption }
        if flags.contains(.control) { m |= KeyCombo.carbonControl }
        return m
    }

    static func name(for event: NSEvent) -> String {
        switch Int(event.keyCode) {
        case kVK_Space: return "Space"
        case kVK_Return: return "↩"
        case kVK_Tab: return "⇥"
        case kVK_Delete: return "⌫"
        case kVK_ForwardDelete: return "⌦"
        case kVK_Escape: return "⎋"
        case kVK_LeftArrow: return "←"
        case kVK_RightArrow: return "→"
        case kVK_UpArrow: return "↑"
        case kVK_DownArrow: return "↓"
        case kVK_Home: return "↖"
        case kVK_End: return "↘"
        case kVK_PageUp: return "⇞"
        case kVK_PageDown: return "⇟"
        case kVK_F1: return "F1"
        case kVK_F2: return "F2"
        case kVK_F3: return "F3"
        case kVK_F4: return "F4"
        case kVK_F5: return "F5"
        case kVK_F6: return "F6"
        case kVK_F7: return "F7"
        case kVK_F8: return "F8"
        case kVK_F9: return "F9"
        case kVK_F10: return "F10"
        case kVK_F11: return "F11"
        case kVK_F12: return "F12"
        default:
            let chars = event.charactersIgnoringModifiers?.uppercased() ?? ""
            return chars.isEmpty ? "Key \(event.keyCode)" : chars
        }
    }
}
