import AppKit
import Carbon
import Foundation

/// Global hot keys.
///
/// * Emergency stop ⌃⌥⌘. uses Carbon `RegisterEventHotKey` (no permission needed).
/// * Push-to-talk ⌥⇧C (the user's choice) can NOT use RegisterEventHotKey on macOS 15+, which
///   rejects combos whose only modifiers are ⌥ or ⌥⇧. It uses a keyboard event tap instead
///   (requires the Accessibility permission JARVIS already needs). The tap swallows ⌥⇧C so no
///   "Ç" is typed. If the tap can't be created (permission missing), ⌃⌥C via Carbon is used.
final class HotKeys {
    struct Binding { let id: UInt32; let keyCode: UInt32; let modifiers: UInt32 }
    var onPress: ((UInt32) -> Void)?
    var onRelease: ((UInt32) -> Void)?
    private(set) var pttDescription = "⌥⇧C"
    /// True while JARVIS is listening, thinking or speaking: Esc then means "stop" system-wide.
    var isActive: () -> Bool = { false }
    private(set) var stopRegistered = true
    private var escRef: EventHotKeyRef?
    private var refs: [EventHotKeyRef?] = []
    private var handler: EventHandlerRef?
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var tapKeyDown = false
    private var retryTimer: Timer?
    var tapActive: Bool { tap != nil }
    static let pushToTalk: UInt32 = 1
    static let emergencyStop: UInt32 = 2
    static let escapeStop: UInt32 = 3

    static let stopBinding = Binding(id: emergencyStop, keyCode: UInt32(kVK_ANSI_Period), modifiers: UInt32(controlKey | optionKey | cmdKey))
    static let pttFallback = Binding(id: pushToTalk, keyCode: UInt32(kVK_ANSI_C), modifiers: UInt32(controlKey | optionKey))

    func start() {
        var bindings = [HotKeys.stopBinding]
        if installTap() {
            pttDescription = "⌥⇧C"
        } else {
            bindings.append(HotKeys.pttFallback)
            pttDescription = "⌃⌥C"
            NSLog("JARVIS: event tap unavailable (grant Accessibility); push-to-talk falls back to ⌃⌥C until it is")
            // Keep trying: macOS can keep telling a running app "not trusted" after you grant access,
            // so the only reliable test is to try creating the tap again.
            retryTimer = Timer.scheduledTimer(withTimeInterval: 4.0, repeats: true) { [weak self] t in
                guard let self = self else { t.invalidate(); return }
                self.retryTapIfNeeded()
                if self.tap != nil { t.invalidate(); self.retryTimer = nil }
            }
        }
        register(bindings)
    }

    /// Re-try the ⌥⇧C tap later (e.g. after the user grants Accessibility).
    func retryTapIfNeeded() {
        guard tap == nil else { return }
        if installTap() {
            pttDescription = "⌥⇧C"
            register([HotKeys.stopBinding])
        }
    }

    // MARK: event tap for ⌥⇧C

    private func installTap() -> Bool {
        // No AXIsProcessTrusted() pre-check: its answer can be stale. Creating the tap is the real test.
        let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                           eventsOfInterest: CGEventMask(mask), callback: { _, type, event, refcon in
            guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
            let me = Unmanaged<HotKeys>.fromOpaque(refcon).takeUnretainedValue()
            return me.handleTap(type: type, event: event)
        }, userInfo: selfPtr) else { return false }
        tap = port
        tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), tapSource, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    private func handleTap(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags.intersection([.maskAlternate, .maskShift, .maskControl, .maskCommand])
        // Emergency stop also through the tap, so it works even if another app owns ⌃⌥⌘. as a hot key.
        if type == .keyDown && code == Int64(kVK_ANSI_Period) && flags == [.maskControl, .maskAlternate, .maskCommand] {
            DispatchQueue.main.async { self.onPress?(HotKeys.emergencyStop) }
            return nil
        }
        // Esc stops JARVIS only while it is active; otherwise Esc belongs to the front app.
        if type == .keyDown && code == Int64(kVK_Escape) && flags.isEmpty && isActive() {
            DispatchQueue.main.async { self.onPress?(HotKeys.emergencyStop) }
            return nil
        }
        guard code == Int64(kVK_ANSI_C) || tapKeyDown else { return Unmanaged.passUnretained(event) }
        if type == .keyDown && code == Int64(kVK_ANSI_C) && flags == [.maskAlternate, .maskShift] {
            if !tapKeyDown {  // ignore key-repeat
                tapKeyDown = true
                DispatchQueue.main.async { self.onPress?(HotKeys.pushToTalk) }
            }
            return nil  // swallow: don't type "Ç"
        }
        if type == .keyUp && code == Int64(kVK_ANSI_C) && tapKeyDown {
            tapKeyDown = false
            DispatchQueue.main.async { self.onRelease?(HotKeys.pushToTalk) }
            return nil
        }
        return Unmanaged.passUnretained(event)
    }

    // MARK: Carbon hot keys

    func register(_ bindings: [Binding]) {
        unregisterCarbon()
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
            if b.id == HotKeys.emergencyStop { stopRegistered = (status == noErr) }
            refs.append(ref)
        }
    }

    /// Without the keyboard tap (no Accessibility yet), register plain Esc as a hot key only while JARVIS is active.
    func setEscapeHotKey(_ on: Bool) {
        if tap != nil { return }  // the tap already handles Esc
        if on, escRef == nil {
            let hkID = EventHotKeyID(signature: OSType(0x4A52_5653), id: HotKeys.escapeStop)
            RegisterEventHotKey(UInt32(kVK_Escape), 0, hkID, GetApplicationEventTarget(), 0, &escRef)
        } else if !on, let r = escRef {
            UnregisterEventHotKey(r)
            escRef = nil
        }
    }

    var stopAvailable: Bool { stopRegistered || tap != nil }

    private func unregisterCarbon() {
        for r in refs { if let r = r { UnregisterEventHotKey(r) } }
        refs.removeAll()
        if let h = handler { RemoveEventHandler(h); handler = nil }
    }

    func unregister() {
        unregisterCarbon()
        retryTimer?.invalidate()
        retryTimer = nil
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        if let s = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), s, .commonModes) }
        tap = nil
        tapSource = nil
    }
}
