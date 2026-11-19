import Foundation

/// Helpers that turn raw audio processes into user-facing apps. Pure string logic so it is testable
/// everywhere; the macOS layer feeds it real paths and bundle identifiers.
public enum AppCatalog {
    /// Returns the outermost `.app` bundle containing `executablePath`, e.g. Chrome's audio helper
    /// `/Applications/Google Chrome.app/Contents/Frameworks/…/Google Chrome Helper.app/Contents/MacOS/…`
    /// resolves to `/Applications/Google Chrome.app`.
    public static func outermostAppBundlePath(forExecutablePath path: String) -> String? {
        let components = path.split(separator: "/", omittingEmptySubsequences: false)
        guard let idx = components.firstIndex(where: { $0.hasSuffix(".app") }) else { return nil }
        let joined = components[...idx].joined(separator: "/")
        return joined.isEmpty ? nil : joined
    }

    /// Bundle IDs of shared system services that play audio on behalf of other apps and are not
    /// inside the owning app's bundle. Used when the responsible process can't be determined.
    public static let sharedServiceOwners: [String: (bundleID: String, name: String)] = [
        "com.apple.WebKit.GPU": ("com.apple.Safari", "Safari"),
        "com.apple.WebKit.WebContent": ("com.apple.Safari", "Safari"),
        "com.apple.WebKit.Networking": ("com.apple.Safari", "Safari"),
    ]

    /// System daemons whose audio is grouped as "System Sounds".
    public static let systemSoundBundleIDs: Set<String> = [
        "com.apple.systemsoundserverd", "com.apple.SystemSoundServer-macOS", "com.apple.UserNotificationCenter",
        "com.apple.notificationcenterui", "com.apple.coreaudiod", "com.apple.audio.SystemSoundServer-OSX",
    ]

    public static let systemSoundsKey = "com.apple.systemsounds"

    /// Processes AirMix should never tap (its own output, audio infrastructure).
    public static let excludedBundleIDs: Set<String> = [
        "com.apple.audio.coreaudiod", "com.apple.audio.AudioComponentRegistrar",
    ]

    /// Removes helper suffixes from process names: "Google Chrome Helper (Renderer)" → "Google Chrome".
    public static func cleanDisplayName(_ name: String) -> String {
        var n = name
        if let r = n.range(of: " Helper", options: [.backwards]) { n = String(n[..<r.lowerBound]) }
        if n.hasSuffix(".app") { n = String(n.dropLast(4)) }
        return n.trimmingCharacters(in: .whitespaces)
    }

    /// Bundle-ID suffixes used by helper processes ("com.google.Chrome.helper.renderer" → "com.google.Chrome").
    public static func parentBundleID(forHelper bundleID: String) -> String {
        let lowered = bundleID.lowercased()
        for marker in [".helper", ".audioservice", ".renderer", ".plugin", ".gpu"] {
            if let r = lowered.range(of: marker) {
                let offset = lowered.distance(from: lowered.startIndex, to: r.lowerBound)
                return String(bundleID.prefix(offset))
            }
        }
        return bundleID
    }

    // MARK: Categories

    private static let knownCategories: [String: AppCategory] = [
        "com.spotify.client": .music, "com.apple.Music": .music, "com.apple.podcasts": .music,
        "com.tidal.desktop": .music, "com.amazon.music": .music, "com.deezer.deezer-desktop": .music,
        "com.apple.iTunes": .music, "com.apple.Audible": .music, "com.apple.GarageBand10": .music,
        "com.apple.Safari": .browser, "com.google.Chrome": .browser, "company.thebrowser.Browser": .browser,
        "org.mozilla.firefox": .browser, "com.microsoft.edgemac": .browser, "com.brave.Browser": .browser,
        "com.vivaldi.Vivaldi": .browser, "com.operasoftware.Opera": .browser, "app.zen-browser.zen": .browser,
        "com.apple.FaceTime": .communication, "com.hnc.Discord": .communication, "us.zoom.xos": .communication,
        "com.microsoft.teams2": .communication, "com.microsoft.teams": .communication,
        "com.tinyspeck.slackmacgap": .communication, "com.cisco.webexmeetingsapp": .communication,
        "net.whatsapp.WhatsApp": .communication, "com.apple.MobileSMS": .communication,
        "ru.keepcoder.Telegram": .communication, "com.skype.skype": .communication,
        "com.apple.avconferenced": .communication, "org.whispersystems.signal-desktop": .communication,
        "org.videolan.vlc": .video, "com.colliderli.iina": .video, "com.apple.QuickTimePlayerX": .video,
        "com.apple.TV": .video, "com.netflix.Netflix": .video, "tv.plex.desktop": .video,
        "com.valvesoftware.steam": .game,
        systemSoundsKey: .system,
    ]

    /// LSApplicationCategoryType values from Info.plist.
    private static let lsCategories: [String: AppCategory] = [
        "public.app-category.music": .music,
        "public.app-category.entertainment": .video,
        "public.app-category.video": .video,
        "public.app-category.social-networking": .communication,
        "public.app-category.games": .game,
    ]

    public static func category(bundleID: String, lsApplicationCategory: String?) -> AppCategory {
        if let c = knownCategories[bundleID] { return c }
        if systemSoundBundleIDs.contains(bundleID) { return .system }
        if let ls = lsApplicationCategory {
            if let c = lsCategories[ls] { return c }
            if ls.hasPrefix("public.app-category.") && ls.contains("games") { return .game }
        }
        return .other
    }
}
