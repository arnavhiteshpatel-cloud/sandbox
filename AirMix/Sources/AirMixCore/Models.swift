import Foundation

// MARK: - Apps

/// Coarse app categories used by profiles and ducking rules ("all music apps").
public enum AppCategory: String, Codable, CaseIterable, Hashable, Sendable {
    case music, browser, communication, video, game, system, other

    public var displayName: String {
        switch self {
        case .music: return "Music & Audio"
        case .browser: return "Browsers"
        case .communication: return "Calls & Chat"
        case .video: return "Video"
        case .game: return "Games"
        case .system: return "System Sounds"
        case .other: return "Other Apps"
        }
    }

    public var symbolName: String {
        switch self {
        case .music: return "music.note"
        case .browser: return "globe"
        case .communication: return "phone.fill"
        case .video: return "play.rectangle.fill"
        case .game: return "gamecontroller.fill"
        case .system: return "bell.fill"
        case .other: return "app.fill"
        }
    }
}

/// Persistent per-app settings. Keyed by the app's bundle identifier.
public struct AppAudioSettings: Codable, Hashable, Sendable {
    /// Slider position; 1.0 == 100 %. May exceed 1 when boost is allowed.
    public var volume: Double
    public var isMuted: Bool
    public var eq: EQSettings
    /// Preferred output device UID; nil follows the system default output.
    public var outputDeviceUID: String?
    public var isPinned: Bool
    /// Hidden from the compact mixer (still controlled).
    public var isHidden: Bool

    public init(volume: Double = 1.0, isMuted: Bool = false, eq: EQSettings = .flat, outputDeviceUID: String? = nil,
                isPinned: Bool = false, isHidden: Bool = false) {
        self.volume = volume
        self.isMuted = isMuted
        self.eq = eq
        self.outputDeviceUID = outputDeviceUID
        self.isPinned = isPinned
        self.isHidden = isHidden
    }

    public static let `default` = AppAudioSettings()

    /// True when processing would leave the audio untouched (used for "only process adjusted apps").
    public var isNeutral: Bool {
        abs(volume - 1) < 0.001 && !isMuted && eq.isNeutral && outputDeviceUID == nil
    }

    enum CodingKeys: String, CodingKey { case volume, isMuted, eq, outputDeviceUID, isPinned, isHidden }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        volume = try c.decodeIfPresent(Double.self, forKey: .volume) ?? 1
        isMuted = try c.decodeIfPresent(Bool.self, forKey: .isMuted) ?? false
        eq = (try? c.decodeIfPresent(EQSettings.self, forKey: .eq)) ?? .flat
        outputDeviceUID = try c.decodeIfPresent(String.self, forKey: .outputDeviceUID)
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        isHidden = try c.decodeIfPresent(Bool.self, forKey: .isHidden) ?? false
    }
}

/// Remembered metadata about apps that produced audio at some point (so settings can be shown
/// and edited even while the app is closed).
public struct KnownApp: Codable, Hashable, Sendable {
    public var displayName: String
    public var bundlePath: String?
    public var category: AppCategory
    public var lastSeen: Date

    public init(displayName: String, bundlePath: String?, category: AppCategory, lastSeen: Date) {
        self.displayName = displayName
        self.bundlePath = bundlePath
        self.category = category
        self.lastSeen = lastSeen
    }
}

// MARK: - Ducking

public enum DuckingTriggerMode: String, Codable, CaseIterable, Hashable, Sendable {
    /// Any sound from a trigger app above the threshold.
    case activity
    /// Sound whose energy is mostly in the voice band (heuristic speech detection).
    case voice
    /// The trigger app is capturing from a microphone (reliable for calls).
    case microphone
    /// Microphone in use, or voice-like output.
    case voiceOrMicrophone

    public var displayName: String {
        switch self {
        case .activity: return "Any sound"
        case .voice: return "Speech-like sound"
        case .microphone: return "Microphone in use"
        case .voiceOrMicrophone: return "Speech or microphone"
        }
    }
}

/// A set of apps addressed by bundle ID and/or category.
public struct AppSelector: Codable, Hashable, Sendable {
    public var bundleIDs: [String]
    public var categories: [AppCategory]

    public init(bundleIDs: [String] = [], categories: [AppCategory] = []) {
        self.bundleIDs = bundleIDs
        self.categories = categories
    }

    public func matches(bundleID: String, category: AppCategory) -> Bool {
        bundleIDs.contains(bundleID) || categories.contains(category)
    }

    public var isEmpty: Bool { bundleIDs.isEmpty && categories.isEmpty }
}

public struct DuckingRule: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    public var isEnabled: Bool
    public var triggers: AppSelector
    public var targets: AppSelector
    /// Volume (slider position) affected apps are lowered to, e.g. 0.15 == 15 %.
    public var duckVolume: Double
    /// Seconds to fade down / back up.
    public var attack: Double
    public var release: Double
    /// Trigger must be active this long before ducking engages (ignores short blips).
    public var minimumActivity: Double
    /// Silence needed before the release starts (bridges pauses between words).
    public var hold: Double
    /// Level (dBFS) below which a trigger counts as silent.
    public var thresholdDB: Double
    public var mode: DuckingTriggerMode
    /// Fraction of energy in the voice band required in voice mode.
    public var voiceRatio: Double

    public init(id: UUID = UUID(), name: String, isEnabled: Bool = true, triggers: AppSelector, targets: AppSelector,
                duckVolume: Double = 0.15, attack: Double = 0.4, release: Double = 1.5, minimumActivity: Double = 0.3,
                hold: Double = 2.0, thresholdDB: Double = -45, mode: DuckingTriggerMode = .voiceOrMicrophone,
                voiceRatio: Double = 0.55) {
        self.id = id
        self.name = name
        self.isEnabled = isEnabled
        self.triggers = triggers
        self.targets = targets
        self.duckVolume = duckVolume
        self.attack = attack
        self.release = release
        self.minimumActivity = minimumActivity
        self.hold = hold
        self.thresholdDB = thresholdDB
        self.mode = mode
        self.voiceRatio = voiceRatio
    }
}

// MARK: - Profiles

public enum ProfileTarget: Codable, Hashable, Sendable {
    case app(String)
    case category(AppCategory)
}

public struct ProfileEntry: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var target: ProfileTarget
    public var volume: Double?
    public var isMuted: Bool?
    /// EQ preset to load (nil = leave EQ unchanged, "off" = disable EQ).
    public var eqPresetID: String?
    /// Whether this entry changes routing; if true, `outputDeviceUID` nil means "system default".
    public var setsOutput: Bool
    public var outputDeviceUID: String?

    public init(id: UUID = UUID(), target: ProfileTarget, volume: Double? = nil, isMuted: Bool? = nil,
                eqPresetID: String? = nil, setsOutput: Bool = false, outputDeviceUID: String? = nil) {
        self.id = id
        self.target = target
        self.volume = volume
        self.isMuted = isMuted
        self.eqPresetID = eqPresetID
        self.setsOutput = setsOutput
        self.outputDeviceUID = outputDeviceUID
    }
}

public struct ProfileAutoActivation: Codable, Hashable, Sendable {
    /// Activate when one of these apps becomes frontmost.
    public var frontmostBundleIDs: [String]
    /// Activate when one of these output devices becomes the default output.
    public var outputDeviceUIDs: [String]

    public init(frontmostBundleIDs: [String] = [], outputDeviceUIDs: [String] = []) {
        self.frontmostBundleIDs = frontmostBundleIDs
        self.outputDeviceUIDs = outputDeviceUIDs
    }

    public var isEmpty: Bool { frontmostBundleIDs.isEmpty && outputDeviceUIDs.isEmpty }
}

public struct Profile: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var name: String
    public var symbolName: String
    public var entries: [ProfileEntry]
    /// Ducking rules switched on by this profile; rules not listed are switched off.
    /// nil leaves ducking rules unchanged.
    public var enabledDuckingRules: [UUID]?
    public var autoActivation: ProfileAutoActivation

    public init(id: UUID = UUID(), name: String, symbolName: String = "slider.horizontal.3",
                entries: [ProfileEntry] = [], enabledDuckingRules: [UUID]? = nil,
                autoActivation: ProfileAutoActivation = .init()) {
        self.id = id
        self.name = name
        self.symbolName = symbolName
        self.entries = entries
        self.enabledDuckingRules = enabledDuckingRules
        self.autoActivation = autoActivation
    }
}

// MARK: - Shortcuts

/// A key combination. Modifier bits follow Carbon's event modifiers so they can be registered
/// directly with RegisterEventHotKey.
public struct KeyCombo: Codable, Hashable, Sendable {
    public var keyCode: UInt32
    public var modifiers: UInt32

    public static let commandKey: UInt32 = 1 << 8   // cmdKey
    public static let shiftKey: UInt32 = 1 << 9     // shiftKey
    public static let optionKey: UInt32 = 1 << 11   // optionKey
    public static let controlKey: UInt32 = 1 << 12  // controlKey

    public init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    public var hasModifier: Bool {
        modifiers & (Self.commandKey | Self.optionKey | Self.controlKey) != 0
    }

    public var modifierSymbols: String {
        var s = ""
        if modifiers & Self.controlKey != 0 { s += "⌃" }
        if modifiers & Self.optionKey != 0 { s += "⌥" }
        if modifiers & Self.shiftKey != 0 { s += "⇧" }
        if modifiers & Self.commandKey != 0 { s += "⌘" }
        return s
    }
}

public enum ShortcutAction: Codable, Hashable, Sendable {
    case toggleMixer
    case muteAll
    case toggleMuteApp(String)
    case focusedAppVolumeUp
    case focusedAppVolumeDown
    case toggleMuteFocusedApp
    case nextOutputDevice
    case activateProfile(UUID)
    case nextProfile

    public var displayName: String {
        switch self {
        case .toggleMixer: return "Open / close AirMix"
        case .muteAll: return "Mute all audio"
        case .toggleMuteApp(let id): return "Mute \(id)"
        case .focusedAppVolumeUp: return "Frontmost app volume up"
        case .focusedAppVolumeDown: return "Frontmost app volume down"
        case .toggleMuteFocusedApp: return "Mute frontmost app"
        case .nextOutputDevice: return "Switch output device"
        case .activateProfile: return "Activate profile"
        case .nextProfile: return "Next profile"
        }
    }
}

public struct ShortcutBinding: Codable, Hashable, Identifiable, Sendable {
    public var id: UUID
    public var action: ShortcutAction
    public var combo: KeyCombo?

    public init(id: UUID = UUID(), action: ShortcutAction, combo: KeyCombo?) {
        self.id = id
        self.action = action
        self.combo = combo
    }
}

// MARK: - Preferences

public struct Preferences: Codable, Hashable, Sendable {
    public var launchAtLogin: Bool
    public var showInactiveApps: Bool
    /// Seconds an app stays in the list (and keeps its tap) after it stops playing.
    public var inactiveGracePeriod: Double
    /// Maximum slider position (1.0 = no boost, 2.0 = 200 %).
    public var maxBoost: Double
    /// Leave apps at their default settings unprocessed (lower latency, no meters for them).
    public var processOnlyAdjustedApps: Bool
    public var showVolumeInMenuBar: Bool
    public var limiterEnabled: Bool
    public var autoProfileSwitching: Bool
    /// Volume step for shortcuts / scroll (slider units).
    public var volumeStep: Double
    public var scrollToAdjust: Bool
    public var showStereoMeters: Bool
    public var hasCompletedOnboarding: Bool

    public init() {
        launchAtLogin = false
        showInactiveApps = true
        inactiveGracePeriod = 30
        maxBoost = 2.0
        processOnlyAdjustedApps = false
        showVolumeInMenuBar = false
        limiterEnabled = true
        autoProfileSwitching = false
        volumeStep = 0.05
        scrollToAdjust = true
        showStereoMeters = false
        hasCompletedOnboarding = false
    }

    enum CodingKeys: String, CodingKey {
        case launchAtLogin, showInactiveApps, inactiveGracePeriod, maxBoost, processOnlyAdjustedApps,
             showVolumeInMenuBar, limiterEnabled, autoProfileSwitching, volumeStep, scrollToAdjust,
             showStereoMeters, hasCompletedOnboarding
    }

    public init(from decoder: Decoder) throws {
        self.init()
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func get<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
            ((try? c.decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
        }
        launchAtLogin = get(.launchAtLogin, launchAtLogin)
        showInactiveApps = get(.showInactiveApps, showInactiveApps)
        inactiveGracePeriod = get(.inactiveGracePeriod, inactiveGracePeriod)
        maxBoost = get(.maxBoost, maxBoost).clamped(to: 1...2)
        processOnlyAdjustedApps = get(.processOnlyAdjustedApps, processOnlyAdjustedApps)
        showVolumeInMenuBar = get(.showVolumeInMenuBar, showVolumeInMenuBar)
        limiterEnabled = get(.limiterEnabled, limiterEnabled)
        autoProfileSwitching = get(.autoProfileSwitching, autoProfileSwitching)
        volumeStep = get(.volumeStep, volumeStep)
        scrollToAdjust = get(.scrollToAdjust, scrollToAdjust)
        showStereoMeters = get(.showStereoMeters, showStereoMeters)
        hasCompletedOnboarding = get(.hasCompletedOnboarding, hasCompletedOnboarding)
    }
}

// MARK: - Root

public struct AirMixSettings: Codable, Hashable, Sendable {
    public static let currentSchemaVersion = 1

    public var schemaVersion: Int
    public var apps: [String: AppAudioSettings]
    public var knownApps: [String: KnownApp]
    public var customPresets: [EQPreset]
    public var duckingRules: [DuckingRule]
    public var profiles: [Profile]
    public var activeProfileID: UUID?
    public var shortcuts: [ShortcutBinding]
    public var preferences: Preferences
    /// Software master gain applied to processed apps when the output device has no volume control.
    public var softwareMasterVolume: Double

    public init(schemaVersion: Int = AirMixSettings.currentSchemaVersion, apps: [String: AppAudioSettings] = [:],
                knownApps: [String: KnownApp] = [:], customPresets: [EQPreset] = [],
                duckingRules: [DuckingRule] = [], profiles: [Profile] = [], activeProfileID: UUID? = nil,
                shortcuts: [ShortcutBinding] = [], preferences: Preferences = Preferences(),
                softwareMasterVolume: Double = 1) {
        self.schemaVersion = schemaVersion
        self.apps = apps
        self.knownApps = knownApps
        self.customPresets = customPresets
        self.duckingRules = duckingRules
        self.profiles = profiles
        self.activeProfileID = activeProfileID
        self.shortcuts = shortcuts
        self.preferences = preferences
        self.softwareMasterVolume = softwareMasterVolume
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, apps, knownApps, customPresets, duckingRules, profiles, activeProfileID, shortcuts,
             preferences, softwareMasterVolume
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = (try? c.decodeIfPresent(Int.self, forKey: .schemaVersion)) ?? 1
        apps = (try? c.decodeIfPresent([String: AppAudioSettings].self, forKey: .apps)) ?? [:]
        knownApps = (try? c.decodeIfPresent([String: KnownApp].self, forKey: .knownApps)) ?? [:]
        customPresets = (try? c.decodeIfPresent([EQPreset].self, forKey: .customPresets)) ?? []
        duckingRules = (try? c.decodeIfPresent([DuckingRule].self, forKey: .duckingRules)) ?? []
        profiles = (try? c.decodeIfPresent([Profile].self, forKey: .profiles)) ?? []
        activeProfileID = try? c.decodeIfPresent(UUID.self, forKey: .activeProfileID)
        shortcuts = (try? c.decodeIfPresent([ShortcutBinding].self, forKey: .shortcuts)) ?? []
        preferences = (try? c.decodeIfPresent(Preferences.self, forKey: .preferences)) ?? Preferences()
        softwareMasterVolume = (try? c.decodeIfPresent(Double.self, forKey: .softwareMasterVolume)) ?? 1
    }

    public func settings(for bundleID: String) -> AppAudioSettings { apps[bundleID] ?? .default }

    public var allPresets: [EQPreset] { EQPreset.builtIn + customPresets }

    public func preset(id: String) -> EQPreset? { allPresets.first { $0.id == id } }
}
