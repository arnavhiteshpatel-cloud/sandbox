import Foundation

public enum ProfileEngine {
    /// Applies a profile to the settings. Only apps/fields the profile mentions change; app entries
    /// beat category entries. Category entries apply to every known app in that category.
    /// - Parameter categories: category of each app the caller knows about (running or remembered).
    public static func apply(_ profile: Profile, to settings: inout AirMixSettings, categories: [String: AppCategory]) {
        var appIDs = Set(categories.keys)
        for entry in profile.entries { if case .app(let id) = entry.target { appIDs.insert(id) } }

        for id in appIDs {
            let category = categories[id] ?? settings.knownApps[id]?.category ?? .other
            let appEntry = profile.entries.first { $0.target == .app(id) }
            let categoryEntry = profile.entries.first { $0.target == .category(category) }
            guard appEntry != nil || categoryEntry != nil else { continue }

            var s = settings.settings(for: id)
            // Category first, then the app-specific entry overrides it field by field.
            for entry in [categoryEntry, appEntry].compactMap({ $0 }) {
                if let v = entry.volume { s.volume = v.clamped(to: 0...settings.preferences.maxBoost) }
                if let m = entry.isMuted { s.isMuted = m }
                if let presetID = entry.eqPresetID {
                    if presetID == "off" {
                        s.eq.isEnabled = false
                    } else if let preset = settings.preset(id: presetID) {
                        s.eq.bands = preset.bands
                        s.eq.presetID = preset.id
                        s.eq.isEnabled = true
                    }
                }
                if entry.setsOutput { s.outputDeviceUID = entry.outputDeviceUID }
            }
            settings.apps[id] = s
        }

        if let enabled = profile.enabledDuckingRules {
            let on = Set(enabled)
            for i in settings.duckingRules.indices { settings.duckingRules[i].isEnabled = on.contains(settings.duckingRules[i].id) }
        }
        settings.activeProfileID = profile.id
    }

    /// Captures the current state of the given apps into a profile's entries.
    public static func capture(settings: AirMixSettings, appIDs: [String], includeRouting: Bool) -> [ProfileEntry] {
        appIDs.sorted().map { id in
            let s = settings.settings(for: id)
            return ProfileEntry(target: .app(id), volume: s.volume, isMuted: s.isMuted,
                                eqPresetID: s.eq.isEnabled ? (s.eq.presetID ?? nil) : "off",
                                setsOutput: includeRouting, outputDeviceUID: s.outputDeviceUID)
        }
    }

    /// The profile that should auto-activate for the given context, if any.
    public static func autoProfile(in profiles: [Profile], frontmostBundleID: String?, defaultOutputUID: String?) -> Profile? {
        if let f = frontmostBundleID, let p = profiles.first(where: { $0.autoActivation.frontmostBundleIDs.contains(f) }) {
            return p
        }
        if let d = defaultOutputUID, let p = profiles.first(where: { $0.autoActivation.outputDeviceUIDs.contains(d) }) {
            return p
        }
        return nil
    }
}

public enum Defaults {
    public static let callDuckingRuleID = UUID(uuidString: "6A0D2C4B-3B6E-4C1F-9E57-5B8F0C7A11D1")!
    public static let defaultProfileID = UUID(uuidString: "0B7E1C5A-0E44-4E3A-8E8D-2E0D7E1B0001")!
    public static let studyProfileID = UUID(uuidString: "0B7E1C5A-0E44-4E3A-8E8D-2E0D7E1B0002")!
    public static let movieProfileID = UUID(uuidString: "0B7E1C5A-0E44-4E3A-8E8D-2E0D7E1B0003")!
    public static let callProfileID = UUID(uuidString: "0B7E1C5A-0E44-4E3A-8E8D-2E0D7E1B0004")!

    public static var callDuckingRule: DuckingRule {
        DuckingRule(id: callDuckingRuleID, name: "Lower music during calls", isEnabled: false,
                    triggers: AppSelector(categories: [.communication]),
                    targets: AppSelector(categories: [.music]),
                    duckVolume: 0.15, attack: 0.5, release: 2.0, minimumActivity: 0.4, hold: 2.5,
                    thresholdDB: -45, mode: .voiceOrMicrophone)
    }

    public static var profiles: [Profile] {
        [
            Profile(id: defaultProfileID, name: "Default", symbolName: "slider.horizontal.3",
                    entries: [
                        ProfileEntry(target: .category(.music), volume: 0.8, isMuted: false),
                        ProfileEntry(target: .category(.browser), volume: 1.0, isMuted: false),
                        ProfileEntry(target: .category(.communication), volume: 1.0, isMuted: false),
                        ProfileEntry(target: .category(.video), volume: 1.0, isMuted: false, eqPresetID: "off"),
                        ProfileEntry(target: .category(.system), volume: 1.0, isMuted: false),
                    ],
                    enabledDuckingRules: []),
            Profile(id: studyProfileID, name: "Study", symbolName: "book.fill",
                    entries: [
                        ProfileEntry(target: .category(.music), volume: 0.55, isMuted: false),
                        ProfileEntry(target: .app("com.spotify.client"), volume: 0.55, isMuted: false),
                        ProfileEntry(target: .category(.browser), volume: 0.87, isMuted: false),
                        ProfileEntry(target: .category(.system), volume: 0.5, isMuted: false),
                    ],
                    enabledDuckingRules: []),
            Profile(id: movieProfileID, name: "Movie", symbolName: "film.fill",
                    entries: [
                        ProfileEntry(target: .category(.browser), volume: 1.0, isMuted: false, eqPresetID: "movie"),
                        ProfileEntry(target: .category(.video), volume: 1.0, isMuted: false, eqPresetID: "movie"),
                        ProfileEntry(target: .category(.music), isMuted: true),
                        ProfileEntry(target: .category(.system), volume: 0.4),
                    ],
                    enabledDuckingRules: []),
            Profile(id: callProfileID, name: "Call", symbolName: "phone.fill",
                    entries: [
                        ProfileEntry(target: .category(.communication), volume: 1.0, isMuted: false),
                        ProfileEntry(target: .category(.music), volume: 0.39, isMuted: false),
                    ],
                    enabledDuckingRules: [callDuckingRuleID]),
        ]
    }

    public static var shortcuts: [ShortcutBinding] {
        // ⌃⌥⌘A opens the mixer; others start unassigned so we never grab keys the user relies on.
        [
            ShortcutBinding(action: .toggleMixer, combo: KeyCombo(keyCode: 0, modifiers: KeyCombo.controlKey | KeyCombo.optionKey | KeyCombo.commandKey)),
            ShortcutBinding(action: .muteAll, combo: nil),
            ShortcutBinding(action: .focusedAppVolumeUp, combo: nil),
            ShortcutBinding(action: .focusedAppVolumeDown, combo: nil),
            ShortcutBinding(action: .toggleMuteFocusedApp, combo: nil),
            ShortcutBinding(action: .nextOutputDevice, combo: nil),
            ShortcutBinding(action: .nextProfile, combo: nil),
        ]
    }

    public static var settings: AirMixSettings {
        AirMixSettings(duckingRules: [callDuckingRule], profiles: profiles, activeProfileID: nil, shortcuts: shortcuts)
    }
}

public enum ShortcutConflicts {
    public struct Conflict: Hashable, Sendable {
        public var combo: KeyCombo
        public var description: String
    }

    /// Well-known system shortcuts (key codes are kVK_* virtual key codes).
    public static let reserved: [KeyCombo: String] = [
        KeyCombo(keyCode: 49, modifiers: KeyCombo.commandKey): "Spotlight (⌘Space)",
        KeyCombo(keyCode: 49, modifiers: KeyCombo.controlKey): "Input source (⌃Space)",
        KeyCombo(keyCode: 48, modifiers: KeyCombo.commandKey): "App switcher (⌘Tab)",
        KeyCombo(keyCode: 12, modifiers: KeyCombo.commandKey): "Quit (⌘Q)",
        KeyCombo(keyCode: 13, modifiers: KeyCombo.commandKey): "Close window (⌘W)",
        KeyCombo(keyCode: 4, modifiers: KeyCombo.commandKey): "Hide app (⌘H)",
        KeyCombo(keyCode: 46, modifiers: KeyCombo.commandKey): "Minimise (⌘M)",
        KeyCombo(keyCode: 20, modifiers: KeyCombo.commandKey | KeyCombo.shiftKey): "Screenshot (⇧⌘3)",
        KeyCombo(keyCode: 21, modifiers: KeyCombo.commandKey | KeyCombo.shiftKey): "Screenshot (⇧⌘4)",
        KeyCombo(keyCode: 23, modifiers: KeyCombo.commandKey | KeyCombo.shiftKey): "Screenshot (⇧⌘5)",
        KeyCombo(keyCode: 12, modifiers: KeyCombo.controlKey | KeyCombo.commandKey): "Lock screen (⌃⌘Q)",
        KeyCombo(keyCode: 3, modifiers: KeyCombo.controlKey | KeyCombo.commandKey): "Full screen (⌃⌘F)",
    ]

    /// Problems with assigning `combo` to `bindingID`, given the other bindings.
    public static func conflicts(for combo: KeyCombo, bindingID: UUID, in bindings: [ShortcutBinding]) -> [String] {
        var out: [String] = []
        if !combo.hasModifier { out.append("Global shortcuts need ⌘, ⌥ or ⌃.") }
        if let r = reserved[combo] { out.append("Used by macOS: \(r).") }
        for b in bindings where b.id != bindingID && b.combo == combo {
            out.append("Already assigned to “\(b.action.displayName)”.")
        }
        return out
    }
}
