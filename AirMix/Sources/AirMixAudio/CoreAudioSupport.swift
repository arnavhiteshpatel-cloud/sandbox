import AudioToolbox
import CoreAudio
import Foundation

/// An error from a Core Audio call, with the four-character status code decoded.
public struct CoreAudioError: Error, LocalizedError, CustomStringConvertible {
    public let status: OSStatus
    public let operation: String

    public init(_ status: OSStatus, _ operation: String) {
        self.status = status
        self.operation = operation
    }

    public var description: String { "\(operation) failed (\(CoreAudioError.fourCC(status)))" }
    public var errorDescription: String? { description }

    public static func fourCC(_ status: OSStatus) -> String {
        let n = UInt32(bitPattern: status)
        let bytes = [UInt8((n >> 24) & 0xFF), UInt8((n >> 16) & 0xFF), UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF)]
        if bytes.allSatisfy({ $0 >= 32 && $0 < 127 }), let s = String(bytes: bytes, encoding: .ascii) {
            return "'\(s)'"
        }
        return "\(status)"
    }
}

@inline(__always)
func check(_ status: OSStatus, _ operation: @autoclosure () -> String) throws {
    if status != noErr { throw CoreAudioError(status, operation()) }
}

public let systemAudioObject = AudioObjectID(kAudioObjectSystemObject)

@inline(__always)
func propertyAddress(_ selector: AudioObjectPropertySelector,
                     _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                     _ element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

/// Thin, typed wrappers around AudioObjectGet/SetPropertyData.
enum CA {
    static func has(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> Bool {
        var a = address
        return AudioObjectHasProperty(object, &a)
    }

    static func isSettable(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> Bool {
        var a = address
        var settable: DarwinBoolean = false
        return AudioObjectIsPropertySettable(object, &a, &settable) == noErr && settable.boolValue
    }

    static func get<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, _ initial: T) throws -> T {
        var a = address
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        try check(AudioObjectGetPropertyData(object, &a, 0, nil, &size, &value),
                  "Reading \(CoreAudioError.fourCC(OSStatus(bitPattern: address.mSelector)))")
        return value
    }

    static func set<T>(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, _ value: T) throws {
        var a = address
        var v = value
        try check(AudioObjectSetPropertyData(object, &a, 0, nil, UInt32(MemoryLayout<T>.size), &v),
                  "Writing \(CoreAudioError.fourCC(OSStatus(bitPattern: address.mSelector)))")
    }

    static func uint32(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> UInt32? {
        try? get(object, address, UInt32(0))
    }

    static func objectIDs(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> [AudioObjectID] {
        var a = address
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
        let count = Int(size) / MemoryLayout<AudioObjectID>.stride
        var ids = [AudioObjectID](repeating: 0, count: count)
        let status = ids.withUnsafeMutableBytes { buf in
            AudioObjectGetPropertyData(object, &a, 0, nil, &size, buf.baseAddress!)
        }
        guard status == noErr else { return [] }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.stride))
    }

    /// Reads a CFString property. Core Audio returns a +1 reference, so take ownership.
    static func string(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress) -> String? {
        var a = address
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(object, &a, 0, nil, &size, &value)
        guard status == noErr, let v = value else { return nil }
        return v.takeRetainedValue() as String
    }

    /// Total channel count in a stream configuration (AudioBufferList with NULL data).
    static func channelCount(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Int {
        var a = propertyAddress(kAudioDevicePropertyStreamConfiguration, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &a, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(device, &a, 0, nil, &size, raw) == noErr else { return 0 }
        let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
        return list.reduce(0) { $0 + Int($1.mNumberChannels) }
    }
}

/// Owns one Core Audio property listener; removes it on `invalidate()` or deinit.
/// The handler is delivered on the main queue.
final class PropertyListener {
    let object: AudioObjectID
    let address: AudioObjectPropertyAddress
    private let block: AudioObjectPropertyListenerBlock
    private var active = false

    init?(_ object: AudioObjectID, _ address: AudioObjectPropertyAddress, handler: @escaping () -> Void) {
        self.object = object
        self.address = address
        self.block = { _, _ in handler() }
        var a = address
        active = AudioObjectAddPropertyListenerBlock(object, &a, DispatchQueue.main, block) == noErr
        if !active { return nil }
    }

    func invalidate() {
        guard active else { return }
        active = false
        var a = address
        // Removing a listener from an object that has gone away returns '!obj'; that's fine.
        _ = AudioObjectRemovePropertyListenerBlock(object, &a, DispatchQueue.main, block)
    }

    deinit { invalidate() }
}

/// Runs `work` on the main actor after `delay` seconds.
func onMain(after delay: TimeInterval, _ work: @escaping @MainActor () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
        MainActor.assumeIsolated { work() }
    }
}
