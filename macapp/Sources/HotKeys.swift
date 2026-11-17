import Carbon
import Foundation

/// Global hot keys via Carbon RegisterEventHotKey. Works without Accessibility or Input
/// Monitoring permission, reports both press and release (needed for hold-to-talk), and
/// swallows the key combo so it doesn't type a character.
final class HotKeys {
    struct Binding { let id: UInt32; let keyCode: UInt32; let modifiers: UInt32 }
    var onPress: ((UInt32) -> Void)?
    var onRelease: ((UInt32) -> Void)?
    private var refs: [EventHotKeyRef?] = []
    private var handler: EventHandlerRef?
    static let pushToTalk: UInt32 = 1
    static let emergencyStop: UInt32 = 2

    func register(_ bindings: [Binding]) {
        unregister()
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
            guard let event = event, let userData = userData else { return noErr }
            let me = Unmanaged<HotKeys>.fromOpaque(userData).takeUnretainedValue()
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            if GetEventKind(event) == UInt32(kEventHotKeyPressed) {
                me.onPress?(hk.id)
            } else {
                me.onRelease?(hk.id)
            }
            return noErr
        }, 2, &types, selfPtr, &handler)
        for b in bindings {
            var ref: EventHotKeyRef?
            let hkID = EventHotKeyID(signature: OSType(0x4A52_5653), id: b.id)  // 'JRVS'
            let status = RegisterEventHotKey(b.keyCode, b.modifiers, hkID, GetApplicationEventTarget(), 0, &ref)
            if status != noErr { NSLog("JARVIS: hot key \(b.id) unavailable (status \(status)); another app may use it") }
            refs.append(ref)
        }
    }

    func unregister() {
        for r in refs { if let r = r { UnregisterEventHotKey(r) } }
        refs.removeAll()
        if let h = handler { RemoveEventHandler(h); handler = nil }
    }

    /// Defaults chosen by the user: hold ⌥⇧C to talk; ⌃⌥⌘. emergency stop.
    static let defaults: [Binding] = [
        Binding(id: pushToTalk, keyCode: UInt32(kVK_ANSI_C), modifiers: UInt32(optionKey | shiftKey)),
        Binding(id: emergencyStop, keyCode: UInt32(kVK_ANSI_Period), modifiers: UInt32(controlKey | optionKey | cmdKey)),
    ]
}
