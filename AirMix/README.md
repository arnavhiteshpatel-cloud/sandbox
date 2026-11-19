# AirMix

Free, local, per-application audio control for macOS: a separate volume, mute, EQ and output
device for every app, automatic ducking, profiles and global shortcuts, all from a compact
menu-bar mixer.

AirMix is driver-free. It uses Apple's Core Audio process taps (macOS 14.2+) to take each app's
audio, process it with your settings, and play it back. It installs no kernel extension, audio
driver, helper daemon, or anything else that needs an admin password.

## Requirements

- macOS **14.2 or later**, on Apple Silicon or Intel.
- To build:
  - Xcode 15.2+ or 16, **or** just the Command Line Tools (`xcode-select --install`).
  - Unit tests need full Xcode, because XCTest isn't included in the Command Line Tools.

## Build and install

```bash
cd AirMix
```

```bash
scripts/build-app.sh --install --run
```

This builds a release binary and assembles `dist/AirMix.app` (ad-hoc signed). It then copies the
app to `/Applications` and launches it. AirMix appears in the menu bar (the slider icon), not in
the Dock.

For development, open `Package.swift` in Xcode and run the **AirMix** scheme, or:

```bash
swift build && swift test
```

### First launch and permissions

The first time AirMix processes an app's audio, macOS asks you to allow **System Audio
Recording** for AirMix. Click **Allow**.

- This is the only permission AirMix uses. macOS shows that wording for any audio tap.
- Audio is processed in memory and never recorded, saved or sent anywhere.
- You can change it later in System Settings → Privacy & Security → Screen & System Audio
  Recording.

AirMix is ad-hoc signed because it has no paid developer certificate. macOS may therefore ask for
the permission again after you rebuild, and the first launch of a downloaded copy needs
right-click → **Open** (or `xattr -dr com.apple.quarantine /Applications/AirMix.app`).

## Verify that it works on your Mac

```bash
scripts/verify-on-mac.sh
```

The script does three things, in order:

1. Runs the unit tests.
2. Builds the app.
3. Runs the **end-to-end independence test** through the real audio system:
   - Two separate processes play a 440 Hz and a 660 Hz tone for about 8 seconds.
   - AirMix gives each one a different volume: 25%/100%, then 100%/25%, then muted/100%.
   - It records what actually reaches the output device and measures each tone's level.

The report is saved to `dist/verification.txt`. You can run the same test from inside the app:
**Mixer window → Settings → Diagnostics → Run Independence Test**.

## Using AirMix

### Menu-bar mixer

Click the menu-bar icon to open the mixer:

- **Master output and volume:** pick the system output device and set the master volume.
- **Apps:** every app producing sound appears automatically, with its icon, a live level shown
  inside the fader, a mute button, an output-device menu and a "…" menu (EQ presets, pin, hide,
  reset).
- **Not playing:** a collapsible list of remembered apps, so you can set them up in advance.
- **Profiles:** pills along the bottom switch profiles instantly.
- **Keyboard and mouse:**
  - Double-click a fader to reset it to 100%.
  - Hold ⌥ and scroll over an app to adjust it.
  - Tab to a row, then use ← → to change volume and M to mute.
- **Right-click the menu-bar icon** for Pause, Reset Audio and Quit.

### Mixer window

Open it with ⤢ in the menu-bar mixer. It has these sections:

- **Mixer:** a console with vertical faders and stereo meters.
- **Equalizer:** a per-app parametric EQ (up to 12 bands) with draggable curve points, presets
  (Neutral, Bass Boost, Vocal Clarity, Movie, Music, Podcast, Night Mode), custom presets, an
  instant bypass and automatic headroom.
- **Devices & Routing:** device details and per-app output routing.
- **Ducking:** rules such as "when FaceTime or Discord has speech or uses the microphone, lower
  music to 15%". Each rule has its own attack, release, hold, minimum activity and threshold.
- **Profiles:** volume, mute, EQ and output per app or category, the ducking rules to enable,
  automatic switching by frontmost app or output device, and a shortcut per profile.
- **Shortcuts:** global shortcuts, with conflict detection.
- **Settings:** launch at login, boost limit (100/150/200%), limiter, "only process adjusted
  apps", privacy, diagnostics and recovery.

## How it works

```
app processes ─▶ process tap (muted while tapped) ─▶ private aggregate device ─▶ output device
                                                     (output = clock + sub-device)
                                                     I/O proc in C: gain · EQ · limiter · meters
```

- **One tap per app.** Each app gets one private `CATapDescription` covering all of its processes,
  with `muteBehavior = .mutedWhenTapped`. The app's original audio is silent only while AirMix is
  reading the tap, so if AirMix quits, crashes or stalls, the app is heard normally again. Nothing
  system-wide changes: AirMix never replaces your default output device.
- **One private aggregate device per app.** Its sub-device is the app's chosen output, which is
  what makes per-app routing possible. Drift compensation is enabled for wired outputs and
  disabled for Bluetooth.
- **Real-time code in C.** The real-time processing (`Sources/AirMixDSP`) is plain C:
  - no allocation, locks or Swift/Objective-C runtime calls on the audio thread;
  - parameters change through atomics, and EQ coefficients through a wait-free triple buffer;
  - gain is smoothed per sample (no clicks), and EQ bypass crossfades;
  - a zero-latency peak limiter catches overs;
  - filters are RBJ biquads with double-precision state.
- **Event-driven discovery.** Apps are found through Core Audio property listeners on the process
  list and each process's running-output state; there is no polling. Helper processes are grouped
  under the app that owns them: Chrome helpers by bundle path or parent process, and Safari's
  WebKit audio by macOS's "responsible process".
- **Recovery:**
  - device removal moves apps to the fallback output;
  - a default-output change or sample-rate change rebuilds the path with a crossfade;
  - waking from sleep and a coreaudiod restart trigger a rebuild;
  - a 2-second health check runs only while paths exist, and rebuilds a stalled callback;
  - **Reset Audio** does all of this on demand;
  - quitting or SIGTERM tears everything down cleanly.

See `docs/REPORT.md` for the implementation report and test status.

## Privacy

AirMix has no network code, no accounts, no analytics and no AI features. Settings are plain JSON
in `~/Library/Application Support/AirMix/settings.json`.
