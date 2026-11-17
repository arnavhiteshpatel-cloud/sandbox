import AppKit
import IOKit.ps

/// Forwards sleep/wake, screen lock and power-source changes to the service.
/// Event-driven (no polling): the app costs nothing while nothing happens.
final class SystemEvents {
    var send: ((String) -> Void)?
    private var powerSource: CFRunLoopSource?

    func start() {
        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.send?("will_sleep") }
        ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.send?("did_wake") }
        let dn = DistributedNotificationCenter.default()
        dn.addObserver(forName: NSNotification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in self?.send?("screen_locked") }
        dn.addObserver(forName: NSNotification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in self?.send?("screen_unlocked") }
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        if let src = IOPSNotificationCreateRunLoopSource({ ctx in
            guard let ctx = ctx else { return }
            Unmanaged<SystemEvents>.fromOpaque(ctx).takeUnretainedValue().send?("power_source")
        }, ctx)?.takeRetainedValue() {
            powerSource = src
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
        }
    }
}
