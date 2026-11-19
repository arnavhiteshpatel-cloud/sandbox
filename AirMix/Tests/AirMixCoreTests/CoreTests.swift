@testable import AirMixCore
import Foundation
import XCTest

final class VolumeTaperTests: XCTestCase {
    func testTaper() {
        XCTAssertEqual(VolumeTaper.gain(forPosition: 1), 1)
        XCTAssertEqual(VolumeTaper.gain(forPosition: 0), 0)
        XCTAssertEqual(VolumeTaper.decibels(forGain: VolumeTaper.gain(forPosition: 0.5)), -12.04, accuracy: 0.01)
        XCTAssertEqual(VolumeTaper.decibels(forGain: VolumeTaper.gain(forPosition: 2)), 12.04, accuracy: 0.01)
        for p in stride(from: 0.0, through: 2.0, by: 0.1) {
            XCTAssertEqual(VolumeTaper.position(forGain: VolumeTaper.gain(forPosition: p)), p, accuracy: 1e-12)
        }
        XCTAssertEqual(VolumeTaper.percentLabel(0.35), "35%")
    }

    func testMeterScale() {
        XCTAssertEqual(MeterScale.fraction(forLinear: 1), 1)
        XCTAssertEqual(MeterScale.fraction(forLinear: 0), 0)
        XCTAssertEqual(MeterScale.fraction(forLinear: 0.001), 0, accuracy: 1e-9)
        XCTAssertEqual(MeterScale.fraction(forLinear: pow(10, -30.0 / 20)), 0.5, accuracy: 1e-9)
    }
}

final class EQDesignTests: XCTestCase {
    func testFlatIsNeutral() {
        var eq = EQSettings.flat
        XCTAssertTrue(eq.isNeutral)
        eq.isEnabled = true
        XCTAssertTrue(eq.isNeutral)
        let r = EQDesigner.response(eq, frequencies: EQDesigner.logFrequencies(count: 32))
        XCTAssertTrue(r.allSatisfy { abs($0) < 1e-6 })
    }

    func testAutoHeadroomCompensatesBoost() {
        var eq = EQSettings(isEnabled: true, bands: EQPreset.builtIn(id: "bass")!.bands)
        let d = EQDesigner.design(eq, sampleRate: 48000)
        XCTAssertGreaterThan(d.peakGainDB, 5)
        let r = EQDesigner.response(eq, frequencies: EQDesigner.logFrequencies(count: 512))
        XCTAssertLessThanOrEqual(r.max()!, 0.05, "with headroom the curve never exceeds 0 dB")
        eq.autoHeadroom = false
        let r2 = EQDesigner.response(eq, frequencies: EQDesigner.logFrequencies(count: 512))
        XCTAssertGreaterThan(r2.max()!, 5)
    }

    func testAllBuiltInPresetsAreStable() {
        XCTAssertEqual(Set(EQPreset.builtIn.map(\.name)),
                       ["Neutral", "Bass Boost", "Vocal Clarity", "Movie", "Music", "Podcast", "Night Mode"])
        for preset in EQPreset.builtIn {
            for rate in [44100.0, 48000, 96000] {
                let d = EQDesigner.design(EQSettings(isEnabled: true, bands: preset.bands), sampleRate: rate)
                for c in d.coefficients {
                    // Biquad poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2.
                    XCTAssertLessThan(abs(c.a2), 1, preset.name)
                    XCTAssertLessThan(abs(c.a1), 1 + c.a2, preset.name)
                }
            }
        }
    }

    func testDisabledBandsIgnored() {
        var bands = EQSettings.defaultBands(gains: [10, 0, 0, 0, 0, 0, 0, 0])
        bands[0].isEnabled = false
        let eq = EQSettings(isEnabled: true, bands: bands)
        XCTAssertTrue(eq.isNeutral)
        XCTAssertEqual(EQDesigner.design(eq, sampleRate: 48000).coefficients.count, 7)
    }
}

final class AudioProcessorTests: XCTestCase {
    func testWrapperAppliesSettings() {
        let p = AudioProcessor(sampleRate: 48000)
        p.setGain(0.5, immediate: true)
        p.setEQ(EQSettings(isEnabled: true, bands: EQPreset.builtIn(id: "vocal")!.bands))
        p.setSampleRate(44100)
        XCTAssertEqual(p.sampleRate, 44100)
        let m = p.readMeters()
        XCTAssertEqual(m.peak, 0)
    }
}

final class DuckingTests: XCTestCase {
    let rule = DuckingRule(name: "t", triggers: AppSelector(bundleIDs: ["facetime"]),
                           targets: AppSelector(categories: [.music]), duckVolume: 0.15, attack: 0.5, release: 1.0,
                           minimumActivity: 0.3, hold: 1.5, thresholdDB: -40, mode: .activity)

    func participants(trigger rms: Double, mic: Bool = false, voice: Double = 0) -> [DuckingParticipant] {
        [DuckingParticipant(bundleID: "facetime", category: .communication,
                            signal: AppSignal(rms: rms, voiceRatio: voice, usesMicrophone: mic)),
         DuckingParticipant(bundleID: "spotify", category: .music, signal: AppSignal(rms: 0.3))]
    }

    func run(_ e: DuckingEngine, seconds: Double, rms: Double, rule r: DuckingRule? = nil, mic: Bool = false, voice: Double = 0) -> [String: [DuckInfluence]] {
        var last: [String: [DuckInfluence]] = [:]
        for _ in 0..<Int(seconds * 20) { last = e.step(dt: 0.05, rules: [r ?? rule], participants: participants(trigger: rms, mic: mic, voice: voice)) }
        return last
    }

    func testShortBlipDoesNotDuck() {
        let e = DuckingEngine()
        let r = run(e, seconds: 0.2, rms: 0.1)
        XCTAssertNil(r["spotify"])
        _ = run(e, seconds: 1, rms: 0)
        XCTAssertTrue(e.isIdle)
    }

    func testSustainedActivityDucksSmoothlyAndHoldsThroughPauses() {
        let e = DuckingEngine()
        _ = run(e, seconds: 0.35, rms: 0.1)
        XCTAssertTrue(e.isEngaged(rule.id))
        let mid = run(e, seconds: 0.25, rms: 0.1)["spotify"]!.first!.amount
        XCTAssertGreaterThan(mid, 0.3); XCTAssertLessThan(mid, 0.9)
        let full = run(e, seconds: 1, rms: 0.1)["spotify"]!.first!.amount
        XCTAssertEqual(full, 1, accuracy: 1e-9)
        // A 1 s pause between sentences (< hold) keeps music ducked.
        XCTAssertEqual(run(e, seconds: 1.0, rms: 0)["spotify"]!.first!.amount, 1, accuracy: 1e-9)
        _ = run(e, seconds: 0.5, rms: 0.1)
        // After the conversation stops: hold, then a smooth release back to full volume.
        XCTAssertEqual(run(e, seconds: 1.4, rms: 0)["spotify"]!.first!.amount, 1, accuracy: 1e-9)
        let releasing = run(e, seconds: 0.6, rms: 0)["spotify"]?.first?.amount ?? 0
        XCTAssertGreaterThan(releasing, 0); XCTAssertLessThan(releasing, 1)
        XCTAssertNil(run(e, seconds: 1.5, rms: 0)["spotify"])
        XCTAssertTrue(e.isIdle)
    }

    func testQuietTriggerBelowThresholdIgnored() {
        let e = DuckingEngine()
        XCTAssertNil(run(e, seconds: 3, rms: 0.001)["spotify"]) // −60 dBFS < −40 threshold
    }

    func testMicrophoneMode() {
        var r = rule; r.mode = .microphone
        let e = DuckingEngine()
        XCTAssertNil(run(e, seconds: 2, rms: 0.5, rule: r)["spotify"], "sound alone doesn't trigger mic mode")
        XCTAssertNotNil(run(e, seconds: 2, rms: 0, rule: r, mic: true)["spotify"])
    }

    func testVoiceMode() {
        var r = rule; r.mode = .voice
        let e = DuckingEngine()
        XCTAssertNil(run(e, seconds: 2, rms: 0.2, rule: r, voice: 0.2)["spotify"], "music-like sound ignored")
        XCTAssertNotNil(run(e, seconds: 2, rms: 0.2, rule: r, voice: 0.8)["spotify"])
    }

    func testDisabledRuleAndSelfDucking() {
        var r = rule; r.isEnabled = false
        let e = DuckingEngine()
        XCTAssertNil(run(e, seconds: 2, rms: 0.5, rule: r)["spotify"])
        var self_ = rule; self_.targets = AppSelector(bundleIDs: ["facetime", "spotify"])
        let out = run(e, seconds: 2, rms: 0.5, rule: self_)
        XCTAssertNil(out["facetime"], "a trigger never ducks itself")
        XCTAssertNotNil(out["spotify"])
    }

    func testDuckedGainMath() {
        let inf = { (a: Double, v: Double) in DuckInfluence(amount: a, duckVolume: v, ruleID: UUID()) }
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 1, influences: []), 1)
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 1, influences: [inf(1, 0.15)]), 0.0225, accuracy: 1e-9)
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 1, influences: [inf(0, 0.15)]), 1, accuracy: 1e-9)
        // Halfway in dB: sqrt(1 * 0.0225)
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 1, influences: [inf(0.5, 0.15)]), 0.15, accuracy: 1e-9)
        // Already quieter than the duck target → unchanged.
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 0.01, influences: [inf(1, 0.15)]), 0.01, accuracy: 1e-12)
        // Duck to 0 % fades to silence.
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 1, influences: [inf(1, 0)]), 0)
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 1, influences: [inf(0.5, 0)]), pow(0.001, 0.5), accuracy: 1e-9)
        // Strongest rule wins.
        XCTAssertEqual(DuckingMath.duckedGain(baseGain: 1, influences: [inf(1, 0.5), inf(1, 0.1)]), 0.01, accuracy: 1e-9)
    }
}

final class ProfileTests: XCTestCase {
    func testAppEntryOverridesCategory() {
        var s = Defaults.settings
        s.apps["com.spotify.client"] = AppAudioSettings(volume: 0.9)
        s.apps["com.apple.Music"] = AppAudioSettings(volume: 0.9)
        let profile = Profile(name: "P", entries: [
            ProfileEntry(target: .category(.music), volume: 0.2, isMuted: false, eqPresetID: "bass"),
            ProfileEntry(target: .app("com.spotify.client"), volume: 0.6),
        ])
        ProfileEngine.apply(profile, to: &s, categories: ["com.spotify.client": .music, "com.apple.Music": .music,
                                                          "com.google.Chrome": .browser])
        XCTAssertEqual(s.apps["com.spotify.client"]?.volume, 0.6)
        XCTAssertEqual(s.apps["com.spotify.client"]?.eq.presetID, "bass", "category fields still apply")
        XCTAssertEqual(s.apps["com.apple.Music"]?.volume, 0.2)
        XCTAssertNil(s.apps["com.google.Chrome"], "untouched apps keep their settings")
        XCTAssertEqual(s.activeProfileID, profile.id)
    }

    func testCallProfileEnablesDucking() {
        var s = Defaults.settings
        XCTAssertFalse(s.duckingRules[0].isEnabled)
        let call = s.profiles.first { $0.id == Defaults.callProfileID }!
        ProfileEngine.apply(call, to: &s, categories: [:])
        XCTAssertTrue(s.duckingRules[0].isEnabled)
        let study = s.profiles.first { $0.id == Defaults.studyProfileID }!
        ProfileEngine.apply(study, to: &s, categories: [:])
        XCTAssertFalse(s.duckingRules[0].isEnabled)
    }

    func testMovieMutesMusicAndLoadsEQ() {
        var s = Defaults.settings
        let movie = s.profiles.first { $0.id == Defaults.movieProfileID }!
        ProfileEngine.apply(movie, to: &s, categories: ["spotify": .music, "chrome": .browser])
        XCTAssertEqual(s.apps["spotify"]?.isMuted, true)
        XCTAssertEqual(s.apps["chrome"]?.eq.presetID, "movie")
        XCTAssertEqual(s.apps["chrome"]?.eq.isEnabled, true)
    }

    func testVolumeClampedToMaxBoost() {
        var s = Defaults.settings
        s.preferences.maxBoost = 1.0
        ProfileEngine.apply(Profile(name: "x", entries: [ProfileEntry(target: .app("a"), volume: 1.8)]), to: &s, categories: [:])
        XCTAssertEqual(s.apps["a"]?.volume, 1.0)
    }

    func testCaptureAndAutoProfile() {
        var s = Defaults.settings
        s.apps["a"] = AppAudioSettings(volume: 0.3, isMuted: true)
        let entries = ProfileEngine.capture(settings: s, appIDs: ["a"], includeRouting: false)
        XCTAssertEqual(entries.first?.volume, 0.3)
        XCTAssertEqual(entries.first?.isMuted, true)
        XCTAssertEqual(entries.first?.eqPresetID, "off")
        var p = Profile(name: "Zoom")
        p.autoActivation.frontmostBundleIDs = ["us.zoom.xos"]
        var q = Profile(name: "AirPods")
        q.autoActivation.outputDeviceUIDs = ["airpods-uid"]
        XCTAssertEqual(ProfileEngine.autoProfile(in: [p, q], frontmostBundleID: "us.zoom.xos", defaultOutputUID: nil)?.name, "Zoom")
        XCTAssertEqual(ProfileEngine.autoProfile(in: [p, q], frontmostBundleID: "x", defaultOutputUID: "airpods-uid")?.name, "AirPods")
        XCTAssertNil(ProfileEngine.autoProfile(in: [p, q], frontmostBundleID: "x", defaultOutputUID: "y"))
    }
}

final class AppCatalogTests: XCTestCase {
    func testHelperResolvesToOutermostApp() {
        let chrome = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131.0/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
        XCTAssertEqual(AppCatalog.outermostAppBundlePath(forExecutablePath: chrome), "/Applications/Google Chrome.app")
        XCTAssertEqual(AppCatalog.outermostAppBundlePath(forExecutablePath: "/Applications/Spotify.app/Contents/MacOS/Spotify"),
                       "/Applications/Spotify.app")
        XCTAssertNil(AppCatalog.outermostAppBundlePath(forExecutablePath: "/usr/bin/afplay"))
    }

    func testNamesAndBundleIDs() {
        XCTAssertEqual(AppCatalog.cleanDisplayName("Google Chrome Helper (Renderer)"), "Google Chrome")
        XCTAssertEqual(AppCatalog.cleanDisplayName("Discord.app"), "Discord")
        XCTAssertEqual(AppCatalog.parentBundleID(forHelper: "com.google.Chrome.helper.renderer"), "com.google.Chrome")
        XCTAssertEqual(AppCatalog.parentBundleID(forHelper: "com.spotify.client"), "com.spotify.client")
        XCTAssertEqual(AppCatalog.sharedServiceOwners["com.apple.WebKit.GPU"]?.bundleID, "com.apple.Safari")
    }

    func testCategories() {
        XCTAssertEqual(AppCatalog.category(bundleID: "com.spotify.client", lsApplicationCategory: nil), .music)
        XCTAssertEqual(AppCatalog.category(bundleID: "x.y", lsApplicationCategory: "public.app-category.music"), .music)
        XCTAssertEqual(AppCatalog.category(bundleID: "x.y", lsApplicationCategory: "public.app-category.action-games"), .game)
        XCTAssertEqual(AppCatalog.category(bundleID: "x.y", lsApplicationCategory: nil), .other)
        XCTAssertEqual(AppCatalog.category(bundleID: AppCatalog.systemSoundsKey, lsApplicationCategory: nil), .system)
    }
}

final class SettingsStoreTests: XCTestCase {
    var dir: URL!

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("airmix-test-\(UUID().uuidString)")
    }

    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func testRoundTrip() throws {
        let store = SettingsStore(fileURL: dir.appendingPathComponent("settings.json"))
        var s = store.load()
        XCTAssertEqual(s.profiles.count, 4)
        s.apps["com.spotify.client"] = AppAudioSettings(volume: 0.35, isMuted: true, outputDeviceUID: "BuiltInSpeakerDevice")
        s.apps["com.spotify.client"]?.eq = EQSettings(isEnabled: true, bands: EQPreset.builtIn(id: "music")!.bands, presetID: "music")
        s.customPresets.append(EQPreset(name: "Mine", bands: EQSettings.defaultBands(gains: [1, 2, 3])))
        s.shortcuts.append(ShortcutBinding(action: .activateProfile(Defaults.movieProfileID),
                                           combo: KeyCombo(keyCode: 46, modifiers: KeyCombo.optionKey)))
        try store.save(s)
        let loaded = SettingsStore(fileURL: store.fileURL).load()
        XCTAssertEqual(loaded, s)
    }

    func testCorruptFileFallsBackToDefaultsAndKeepsBackup() throws {
        let url = dir.appendingPathComponent("settings.json")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: url)
        let store = SettingsStore(fileURL: url)
        let s = store.load()
        XCTAssertEqual(s.profiles.count, 4)
        XCTAssertNotNil(store.lastLoadIssue)
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertTrue(files.contains { $0.contains("corrupt") })
    }

    func testMissingKeysUseDefaults() throws {
        let url = dir.appendingPathComponent("settings.json")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(#"{"apps":{"a":{"volume":0.5}},"preferences":{"maxBoost":1.5}}"#.utf8).write(to: url)
        let s = SettingsStore(fileURL: url).load()
        XCTAssertEqual(s.apps["a"]?.volume, 0.5)
        XCTAssertEqual(s.apps["a"]?.isMuted, false)
        XCTAssertEqual(s.preferences.maxBoost, 1.5)
        XCTAssertEqual(s.preferences.limiterEnabled, true)
        XCTAssertFalse(s.shortcuts.isEmpty)
    }
}

final class ShortcutTests: XCTestCase {
    func testConflicts() {
        let a = ShortcutBinding(action: .muteAll, combo: KeyCombo(keyCode: 46, modifiers: KeyCombo.optionKey | KeyCombo.commandKey))
        let b = ShortcutBinding(action: .nextProfile, combo: nil)
        XCTAssertEqual(ShortcutConflicts.conflicts(for: a.combo!, bindingID: b.id, in: [a, b]).count, 1)
        XCTAssertTrue(ShortcutConflicts.conflicts(for: a.combo!, bindingID: a.id, in: [a, b]).isEmpty)
        XCTAssertFalse(ShortcutConflicts.conflicts(for: KeyCombo(keyCode: 49, modifiers: KeyCombo.commandKey), bindingID: b.id, in: [a, b]).isEmpty)
        XCTAssertFalse(ShortcutConflicts.conflicts(for: KeyCombo(keyCode: 0, modifiers: KeyCombo.shiftKey), bindingID: b.id, in: []).isEmpty)
        XCTAssertEqual(KeyCombo(keyCode: 0, modifiers: KeyCombo.controlKey | KeyCombo.optionKey | KeyCombo.commandKey).modifierSymbols, "⌃⌥⌘")
    }
}
