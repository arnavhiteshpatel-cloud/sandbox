import Foundation

/// Loads and saves `AirMixSettings` as JSON. Writes are atomic (temp file + rename) so a crash
/// mid-write can never leave a truncated file. An unreadable file is preserved as a backup and
/// defaults are used instead.
public final class SettingsStore {
    public let fileURL: URL
    public private(set) var lastLoadIssue: String?

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// `~/Library/Application Support/AirMix/settings.json`
    public static func defaultURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("AirMix", isDirectory: true).appendingPathComponent("settings.json")
    }

    public func load() -> AirMixSettings {
        lastLoadIssue = nil
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return Defaults.settings }
        do {
            let data = try Data(contentsOf: fileURL)
            var s = try JSONDecoder.airmix.decode(AirMixSettings.self, from: data)
            Self.migrate(&s)
            return s
        } catch {
            let stamp = Int(Date().timeIntervalSince1970)
            let backup = fileURL.deletingPathExtension().appendingPathExtension("corrupt-\(stamp).json")
            try? FileManager.default.copyItem(at: fileURL, to: backup)
            lastLoadIssue = "Settings could not be read (\(error.localizedDescription)). A copy was saved to \(backup.lastPathComponent) and defaults were loaded."
            return Defaults.settings
        }
    }

    public func save(_ settings: AirMixSettings) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder.airmix.encode(settings)
        try data.write(to: fileURL, options: .atomic)
    }

    static func migrate(_ s: inout AirMixSettings) {
        if !s.duckingRules.contains(where: { $0.id == Defaults.callDuckingRuleID }) && s.schemaVersion < 1 {
            s.duckingRules.append(Defaults.callDuckingRule)
        }
        if s.shortcuts.isEmpty { s.shortcuts = Defaults.shortcuts }
        s.schemaVersion = AirMixSettings.currentSchemaVersion
    }
}

extension JSONEncoder {
    static var airmix: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        e.dateEncodingStrategy = .iso8601
        return e
    }
}

extension JSONDecoder {
    static var airmix: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
