# AirMix — implementation report

_Last updated 2026-11-19._

## 1. Where it was built, and what that means for verification

AirMix was developed in a **Linux cloud container**. No Mac was attached, and no macOS GitHub
Actions runner became available for this account during the session (see §6). In practice:

- **The real-time DSP kernel (C) and all platform-independent logic (Swift) were compiled and
  unit-tested here.** That logic covers EQ design, ducking, profiles, persistence, shortcut
  conflicts, app grouping and tone analysis: 45 tests, all passing, on this container and on
  GitHub's Linux runner.
- **The Core Audio layer and the SwiftUI app have not been compiled yet.** They were written
  against Apple's real SDK headers (macOS 14.2, 15.5 and 26.1, checked for every Core Audio
  symbol) and reviewed by hand. The first `swift build` on a Mac, or the macOS CI job, is the
  first compile. Small compile fixes may be needed.
- **No audio has been played through AirMix on real hardware.** The repository includes
  `scripts/verify-on-mac.sh` and an in-app **Independence Test**, so that verification takes one
  command on your Mac.

## 2. Architecture decision

| Approach | Verdict |
|---|---|
| **Core Audio process taps + private aggregate device per app** | **Chosen.** Documented API (macOS 14.2+). `muteBehavior = .mutedWhenTapped` silences the app's own output only while AirMix reads the tap, so there is no duplicate playback and audio comes back automatically if AirMix stops or crashes. No driver, no admin rights, and the system default device is never changed. |
| Virtual HAL driver (Background Music) | Rejected. It needs an admin install into `/Library/Audio/Plug-Ins/HAL` and a root helper, and it must make itself the system default output. That last requirement causes most of its documented failure modes, such as silence after a crash. |
| One aggregate with many taps (macOS-volume-controller) | Rejected. Any change rebuilds every app's path (briefly un-muting all of them), and per-app routing is impossible. |

Projects studied: Background Music (GPL-2), macOS-volume-controller (AGPL-3), sound_pref
(GPL-3), FineTune (GPL-3), AudioCap (BSD) and Apple's "Capturing system audio with Core Audio
taps" sample. Only designs were learned from them; no code was copied.

## 3. Feature status

Legend:
- ✅ implemented and tested (automated tests in this environment)
- 🟡 implemented, not yet compiled or physically verified on a Mac
- ⚠️ limited by macOS or by specific apps
- ⏳ not done

### Audio engine

| Feature | Status | Notes |
|---|---|---|
| Real-time processing kernel (gain, EQ, limiter, meters, voice-band detector) | ✅ | 16 kernel tests cover the following. **Gain accuracy:** unity is bit-transparent, and 0.25× is exact. **Independence:** two streams with different gains stay independent, and muting one leaves the other untouched. **Clicks:** gain ramps are click-free (largest per-sample step under 0.001 on a 0.5 DC signal). **EQ accuracy:** a +6 dB bell measures within 0.1 dB of its design. **EQ bypass:** the crossfade has no discontinuity. **Limiter:** +12 dB of boost never exceeds 0.98. **Stereo separation:** no leakage between channels. **Buffer layouts:** interleaved, split-mono and mono outputs, a device microphone ahead of the tap, and missing input → silence. **Stability:** concurrent EQ updates during processing (20k updates against 4k blocks) and a 20 Hz shelf at 192 kHz. |
| Kernel CPU cost | ✅ measured | On a 2.1 GHz Xeon VM, per app stream at 48 kHz: 2.6 µs per 512-frame block with gain and limiter (0.025% of one core), 14 µs with an 8-band EQ (0.13%), 16 µs with the voice detector added (0.15%). Not yet measured on Apple Silicon. |
| Per-app tap + aggregate + C I/O proc | 🟡 | `AppAudioPath.swift`. Teardown order is stop → destroy I/O proc → destroy aggregate → destroy tap. A duplex device's microphone streams are turned off so AirMix never opens a mic. |
| Independent per-app volume 0–100% (and up to 200%) | 🟡 (kernel ✅) | Square-law taper. Boost above 100% always enables the limiter. |
| Per-app mute, global mute | 🟡 | Global mute uses the device's hardware mute, or a software mute if the device has none. |
| Master volume | 🟡 | Uses the device's virtual main volume, falling back to per-channel volume, then to software gain. |
| Live meters from the real signal | 🟡 (kernel ✅) | Peak values come from the samples actually written to the device. Meters are read at 30 Hz only while the mixer is visible, and a view re-renders only when its value changes. |
| Automatic discovery, event-driven | 🟡 | Core Audio listeners on the process list and on each process's running-output and running-input state. No polling. |
| Multi-process apps (Chrome, Safari/WebKit, Electron) | 🟡 ⚠️ | Processes are grouped by their outermost `.app` bundle, then by parent process, then by macOS's "responsible process". That last step uses `responsibility_get_pid_responsible_for_pid`, an undocumented read-only libSystem function, looked up dynamically with a fallback. It changes nothing on the system. New helper processes are added to the live tap without a rebuild. |
| Settings persistence and restore on relaunch | ✅ (store) / 🟡 (app) | Atomic JSON writes. A corrupt file is backed up and defaults are loaded. Missing keys fall back to defaults. |
| Device disconnect / default change / sample-rate change / sleep–wake / coreaudiod restart | 🟡 | Paths on a removed device stop at once and are rebuilt on the fallback output. Other changes rebuild with a crossfade. A health check every 2 s runs only while paths exist. |
| Crash safety | 🟡 (by design) | Taps and aggregates are private, and `.mutedWhenTapped` means apps are heard again as soon as AirMix stops reading. Leftover AirMix aggregates are removed at launch. SIGTERM, SIGINT and SIGHUP exit cleanly. |
| One-click **Reset Audio**, **Pause AirMix** | 🟡 | |
| Permission handling | 🟡 ⚠️ | `NSAudioCaptureUsageDescription` is set. macOS has no public API to query this permission, so AirMix detects "apps are playing but no audio arrives" and explains how to fix it. |

### Routing

| Feature | Status | Notes |
|---|---|---|
| Per-app output device, saved by app | 🟡 | Uses a separate aggregate per app. Switching outputs builds the new path first, then crossfades. |
| Fallback when a device is gone; restore on reconnect | 🟡 | The UI shows "Preferred output unavailable · using X". |
| Aggregate / Multi-Output devices | ⚠️ | They can't be nested in AirMix's aggregate, so they are shown as unsupported for per-app routing. If one is the system default, AirMix leaves all apps unprocessed and says so. |

### EQ, ducking, profiles, shortcuts, UI

| Feature | Status | Notes |
|---|---|---|
| Parametric EQ per app (up to 12 bands; bell, shelf, low/high-pass and notch filters) | ✅ (design and response) / 🟡 (UI) | RBJ cookbook biquads with double-precision state. All presets are verified stable at 44.1, 48 and 96 kHz. Auto headroom keeps the curve at or below 0 dB. Bypass is instant with a 6 ms crossfade. |
| Presets (Neutral, Bass Boost, Vocal Clarity, Movie, Music, Podcast, Night Mode) and custom presets | ✅ / 🟡 | |
| Ducking engine | ✅ | 7 tests: blips are ignored, ducking holds through pauses between words, release is smooth, trigger modes (activity, speech, microphone) work, an app never ducks itself, and the dB-interpolated gain math is checked. |
| Speech detection | ✅ ⚠️ | A heuristic based on the share of energy in the 300–3400 Hz voice band. The "Microphone in use" trigger is more reliable for calls. |
| Profiles (Default, Study, Movie, Call + unlimited custom) | ✅ (engine) / 🟡 (UI) | Category and app entries, with app entries taking precedence. Profiles store ducking rule sets, auto-activation by frontmost app or output device, and a shortcut. |
| Global shortcuts with conflict detection | ✅ (conflict logic) / 🟡 | Carbon `RegisterEventHotKey` needs no Accessibility permission. It flags combinations taken by macOS or by another app. |
| ⌥-scroll per app, arrow keys and M on a focused row | 🟡 | |
| Menu-bar popover, mixer window (console, EQ graph, routing, ducking, profiles, shortcuts, settings) | 🟡 | Native vibrancy, light and dark themes. |
| Launch at login (`SMAppService`) | 🟡 | AirMix must be in /Applications. |
| End-to-end independence test | 🟡 | The analysis pipeline is ✅: a simulated two-app mix measures −12.04 ± 0.3 dB. |

## 4. Known limitations (macOS / app-specific)

1. **Onset latency.** The tap is created when an app starts playing, so the first few
   milliseconds of a brand-new sound can be heard at the app's original level. Pausing and
   resuming within the grace period (default 30 s) is seamless.
2. **Added output latency.** Processed apps go through one extra I/O cycle of the aggregate,
   typically about 10 ms (shown per app in Diagnostics). Video sync is unaffected in practice.
   Rhythm games or monitoring may notice it; turn on "Only process adjusted apps" so untouched
   apps bypass AirMix entirely.
3. **Voice-over-IP apps** (FaceTime, WhatsApp) use echo cancellation. Re-playing their output
   through a tap can, in rare cases, affect echo cancellation. Leaving such an app at default
   settings with "Only process adjusted apps" on bypasses it completely.
4. **Shared WebKit audio.** When the responsible-process lookup is unavailable, audio from
   WebKit's shared GPU process is attributed to Safari, even if it came from another app that
   embeds WebKit.
5. **Bluetooth codec switches.** A Bluetooth headset switching to its microphone (HFP) changes
   sample rate. The affected paths are rebuilt, which causes a brief dropout.
6. **Ad-hoc signing.** macOS may ask again for System Audio Recording permission after AirMix
   is rebuilt.

## 5. Remaining work

- First compile on a Mac; fix any compile errors in `AirMixAudio` and `AirMix` targets.
- Run `scripts/verify-on-mac.sh` (independence test through real audio) and the manual checks
  below; tune meter ballistics and UI spacing on a real screen.
- Measure CPU, memory and latency of the running app with Activity Monitor / Instruments.
- Manual test matrix (needs real hardware): AirPods disconnect during playback; speakers ↔
  headphones; 3+ apps at once; browser restart; rapid slider moves; profile switch during
  playback; quit during playback; `kill -9` then relaunch; sleep/wake; USB interface
  plug/unplug.
- Optional: on macOS 26, use `CATapDescription.bundleIDs` + `isProcessRestoreEnabled` to keep
  taps across app relaunches (removes the onset blip).
- Optional: Developer ID signing + notarisation for distribution.

## 6. CI status

- `.github/workflows/airmix.yml` defines two jobs:
  - **Linux:** the portable unit tests. ✅ green on GitHub.
  - **macOS 15:** `swift test`, building the `.app`, a launch smoke test, and uploading a zipped
    artifact.
- On this account, the macOS job stayed queued without receiving a runner. Earlier runs in this
  repository were cancelled instantly at the macOS step. Fixing that is an account-level GitHub
  Actions setting (billing or spending limit for macOS minutes). Once it runs, the CI artifact
  **AirMix-macOS** is a ready-to-install app.
