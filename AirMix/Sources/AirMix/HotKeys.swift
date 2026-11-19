import AirMixCore
import AppKit
import Carbon.HIToolbox

/// System-wide shortcuts via Carbon's RegisterEventHotKey: documented, needs no Accessibility
/// permission, and reports when another app already owns a combination.
@MainActor
final class HotKeyCenter {
    private var refs: [UInt32: EventHotKeyRef] = [:]
    private var actions: [UInt32: ShortcutAction] = [:]
    private var handlerRef: EventHandlerRef?
    private var nextID: UInt32 = 1
    var onAction: ((ShortcutAction) -> Void)?
    /// Binding IDs that could not be registered (taken by another app or the system).
    private(set) var failed: [UUID: String] = [:]

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let userData = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var hotKeyID = EventHotKeyID()
            let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                           nil, ByteCount(MemoryLayout<EventHotKeyID>.size), nil, &hotKeyID)
            guard status == noErr else { return status }
            let center = Unmanaged<HotKeyCenter>.fromOpaque(userData).takeUnretainedValue()
            let id = hotKeyID.id
            MainActor.assumeIsolated { center.fire(id) }
            return noErr
        }, 1, &spec, userData, &handlerRef)
    }

    private func fire(_ id: UInt32) {
        if let action = actions[id] { onAction?(action) }
    }

    func register(_ bindings: [ShortcutBinding]) {
        for ref in refs.values { UnregisterEventHotKey(ref) }
        refs.removeAll()
        actions.removeAll()
        failed.removeAll()
        let signature = OSType(0x414D_6978) // 'AMix'
        for binding in bindings {
            guard let combo = binding.combo else { continue }
            let id = nextID
            nextID &+= 1
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(combo.keyCode, combo.modifiers, EventHotKeyID(signature: signature, id: id),
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref {
                refs[id] = ref
                actions[id] = binding.action
            } else if status == OSStatus(eventHotKeyExistsErr) {
                failed[binding.id] = "Already used by another app."
            } else {
                failed[binding.id] = "Couldn’t register (error \(status))."
            }
        }
    }
}

enum KeyNames {
    private static let names: [UInt32: String] = [
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V", 11: "B", 12: "Q", 13: "W",
        14: "E", 15: "R", 16: "Y", 17: "T", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
        26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "O", 32: "U", 33: "[", 34: "I", 35: "P", 36: "↩", 37: "L",
        38: "J", 39: "'", 40: "K", 41: ";", 42: "\\", 43: ",", 44: "/", 45: "N", 46: "M", 47: ".", 48: "⇥", 49: "Space",
        50: "`", 51: "⌫", 53: "⎋", 96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9", 103: "F11",
        105: "F13", 107: "F14", 109: "F10", 111: "F12", 113: "F15", 118: "F4", 120: "F2", 122: "F1",
        123: "←", 124: "→", 125: "↓", 126: "↑", 115: "↖", 119: "↘", 116: "⇞", 121: "⇟", 117: "⌦",
    ]

    static func name(_ keyCode: UInt32) -> String { names[keyCode] ?? "Key \(keyCode)" }

    static func display(_ combo: KeyCombo) -> String { combo.modifierSymbols + name(combo.keyCode) }

    static func carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32 {
        var m: UInt32 = 0
        if flags.contains(.command) { m |= KeyCombo.commandKey }
        if flags.contains(.option) { m |= KeyCombo.optionKey }
        if flags.contains(.control) { m |= KeyCombo.controlKey }
        if flags.contains(.shift) { m |= KeyCombo.shiftKey }
        return m
    }
}
