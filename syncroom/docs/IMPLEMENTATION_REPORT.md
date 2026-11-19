# SyncRoom — Implementation Report

Date: 2026-11-19 · Branch: `claude/friendly-noether-ycgp7w` · Directory: `syncroom/`

Status key:
- ✅ **implemented and tested**
- 🔑 **implemented, but depends on external authorization** (credentials or a server I couldn't run here)
- ⛔ **unsupported** (by design or by provider limits)
- ⏳ **not yet implemented**

## 1. Research summary: how Cinejoy-style sites work, and what SyncRoom does instead

Cinejoy and similar sites pair a TMDB/IMDb catalogue with *third-party embed aggregators*. These are iframe players
keyed by TMDB/IMDb id and `season/episode` that stream unlicensed copies, inject their own ads, and expose no
playback-control API to the embedding page. "Servers" are just alternative aggregator iframes. Two consequences:

1. Those sources are not authorized, so integrating them would violate the brief ("do not assume an accessible
   video URL grants integration permissions").
2. They can't be synchronized. A cross-origin iframe without a `postMessage` control API can't be played, paused,
   seeked or timed by the host page, so any "watch party" built on them is faked or needs a browser extension that
   injects into the third-party page.

SyncRoom keeps the catalogue model (IMDb/TMDB ids, seasons, episodes, multiple selectable servers) but plays only
sources that are both authorized and controllable:

| Source | Status | Notes |
|---|---|---|
| Internet Archive (public domain) | ✅ | Curated `feature_films`/`silent_films` collections only (community uploads excluded). Matched by explicit IMDb id or exact title + year. Direct MP4, multiple renditions, `.srt` where present. |
| Public-domain TV (Internet Archive) | ✅ | Only series with precisely documented PD scope: *Sherlock Holmes* (1954), *Flash Gordon* (1954), *The Beverly Hillbillies* (first 55 episodes). Episodes matched by name/SxxEyy. |
| Blender open movies (CC BY) | ✅ | *Sintel* (DASH), *Tears of Steel* (HLS, DASH, MP4), *Big Buck Bunny* (HLS, DASH). Official subtitles: 9 and 15 languages. |
| Your media folder | ✅ | Parsing of Plex/Jellyfin-style names, IMDb tags, sidecar subtitles, byte-range streaming from the SyncRoom server. |
| User-added links (MP4/WebM/HLS/DASH) | ✅ | Verified on add (real bytes/manifest), re-verified daily. |
| User-added YouTube / Vimeo links | ✅ (sync is coarse) | YouTube IFrame API and Vimeo SDK expose transport control; verified via oEmbed. YouTube may show its own ads (labelled). |
| Jellyfin | 🔑 | Adapter complete (IMDb provider-id match, direct play, HLS transcode, text subtitles → WebVTT). Contract-tested against a fake server. A live run was blocked here: the environment's permission policy didn't allow launching the downloaded Jellyfin server. |
| Plex | 🔑 | Adapter complete (imdb:// guid match, direct part, universal HLS transcode, subtitle streams). Contract-tested only; needs your Plex token. |
| OpenSubtitles | 🔑 | Search by IMDb id (+ season/episode), download, SRT→VTT. Needs a free API key; not live-tested. |
| TMDB metadata | 🔑 | Full provider (discover, trending, search, detail with cast photos, seasons, recommendations). Contract-tested; activates automatically with a key. |
| Unlicensed embed aggregators (vidsrc-style) | ⛔ | Not integrated: unauthorized, ad-injecting, and uncontrollable. |
| Arbitrary iframe embeds without a control API | ⛔ | Can't be synced, so they are not offered. A browser extension for such sites was not built (⏳). |

## 2. Features that genuinely work (✅, exercised by automated tests or manual runs)

**Catalogue**
- Search with autocomplete.
- Search filters: type, decade, genre, minimum rating, "playable now".
- Movie and series detail pages with backdrops, logos, ratings, runtime, release info, cast/crew, trailers and
  recommendations.
- Full season and episode navigation, with thumbnails, synopses, air dates, availability badges and progress bars.
- Genre and year browsing with Popular / New / Top-rated sorting.
- Home shelves: Trending, Popular Series, New Releases, New Seasons, Critically Acclaimed, World Cinema,
  Indian Cinema, Animation, Documentaries, Horror, Comedy, Acclaimed Series, Coming Soon. Coming Soon is clearly
  labelled "not yet watchable".
- Persistent SQLite metadata cache with stale-while-revalidate, which gives automatic background refresh.

**Player**
- Native MP4/WebM, HLS (hls.js) and DASH (Shaka 5), plus YouTube and Vimeo engines.
- Play/pause, scrubbing with buffered ranges and hover time, ±10 s, volume/mute, fullscreen, picture-in-picture.
- Speeds 0.5–2×.
- Quality: HLS/DASH levels and Internet Archive renditions.
- Subtitles:
  - external (provider/sidecar/OpenSubtitles), in-stream, or a local `.srt/.vtt` file
  - custom overlay with timing offset (±0.1/±0.5 s) and size control
- Next episode: episode drawer inside the player, up-next card, 8-second auto-next countdown.
- Resume from saved progress.
- Remembered preferences: volume, rate, subtitle language and size, quality.
- Keyboard shortcuts.
- Loading and buffering indicators.
- Error recovery:
  - hls.js network/media recovery
  - Shaka retries
  - retry button
  - automatic fallback to the next verified source
  - in-browser failures are reported back and demote a source after repeated failures

**Sources**
- Modular registry and adapters, with a capability report per source (sync grade, rates, subtitles, quality, PiP).
- Byte-level verification: MP4 `ftyp`, EBML, Ogg, MPEG-TS magic bytes, or HLS/DASH manifest plus first variant.
- Results are cached (12 h positive, 30 min negative). Provider health checks run every 10 min and on demand, and
  can be inspected in Settings.
- Manual source selection is available on title pages and inside the player.

**Rooms and synchronization**
- Rooms: create, private invite link (`#k=` key), join, uninvited access refused, per-member reconnect token.
- Participants: list with ready / buffering / drift / ping, host transfer, host-only mode.
- Room settings: "wait for each other", autoplay next. Chat.
- Shared controls: either person can play, pause, seek, change speed, change source (room-wide), switch episode, or
  restart; automatic next episode applies to both players.
- Session state survives disconnects. Rooms are persisted, and restored paused at the last position after the last
  person leaves or the server restarts.

**Personal data**
- Lightweight identity: random id + display name, no account.
- Progress is saved every 10 s, on pause and on exit; Continue Watching; completed and history lists.
- Watchlist and favorites.

**Calling**
- P2P voice/video over WebRTC (perfect negotiation, signalling over the room WebSocket).
- Mic and camera toggles, draggable floating bubbles (double-click to enlarge), per-person volume, picture-in-picture
  for a partner's bubble.
- Background blur where Chrome's platform `backgroundBlur` constraint is supported.

**UI**
- Dark cinematic design (Fraunces + Inter, glass surfaces, Ken Burns hero, skeleton loading).
- Responsive from 390 px phones to desktop. No ads or promotions.

## 3. Catalogue size and coverage

- **Metadata provider (default):** Cinemeta, Stremio's public IMDb-keyed catalogue; no key needed.
  - Measured depth of the popularity catalogues: ≥ 20,000 movies and ≥ 10,000 series browsable (pages still
    returned at offsets 20,000 and 10,000 respectively).
  - Search covers Cinemeta's full IMDb-backed index.
  - Verified in tests: Hollywood (*Breaking Bad*, *The Odyssey* 2026), Indian (*3 Idiots*), silent classics, upcoming
    titles, and complete episode lists (e.g. *Breaking Bad* 5 seasons / 62 episodes; *The Beverly Hillbillies*
    276 entries).
- **With a TMDB key:** TMDB's catalogue, including origin-country shelves (India, Korea) and cast photos.
- **Limitations:** Cinemeta has no cast photos and no native recommendation endpoint. Recommendations are computed
  from genre overlap, rating and era. Short films such as the Blender movies are missing from Cinemeta's search, so
  SyncRoom also merges its own verified-playable titles into search results.

## 4. Verified playable titles and episodes

Measured with `npm run verify:sources` (the full pass took about 5 minutes):

| Library | Titles | Playable units |
|---|---|---|
| Internet Archive public-domain films | 1,407 | 1,407 |
| Internet Archive public-domain TV | 3 series | 58 episodes (Sherlock Holmes 37, Flash Gordon 16, Beverly Hillbillies 5*) |
| Blender open movies | 3 | 3 (6 renditions: HLS/DASH/MP4) |
| **Total in index** | **1,413** | **1,468** |
| Local media folder (test setup) | 2 | Sintel (+4 subtitle languages), Sherlock Holmes S01E02 |

\* Only about 8 distinct *Beverly Hillbillies* episodes exist in the curated archive collection.

Era distribution: almost all are pre-1930 silent films; about 45 are well-known public-domain sound films
(*Night of the Living Dead*, *His Girl Friday*, *Charade*, *Detour*, *The Lady Vanishes*, *Plan 9 from Outer
Space*, …).

To be clear: modern Hollywood, Bollywood and current TV are browsable but **not playable** unless you supply them
through your own files, your Jellyfin/Plex server, or links you're entitled to use. This is deliberate. No
authorized, free, ad-free source for that content exists.

In-browser playback was verified (video `currentTime` advancing in Chromium) for:
- Internet Archive MP4 (*Night of the Living Dead*, *His Girl Friday*, *Sherlock Holmes* episodes)
- HLS (*Tears of Steel*)
- DASH at 1080p (*Sintel*)
- the local file via byte-range serving (*Sintel*)
- the PD TV episode *Beverly Hillbillies* S1E1

## 5. Synchronization test results (measured, `tests/e2e/sync*.spec.ts`)

Method: two independent browser contexts (separate identities) join one room over the real invite link. Both sample
`<video>.currentTime` every 50 ms against the shared system clock, and traces are compared by interpolation.

Figures are ranges across three full runs. The highest values come from a run where background index seeding was
competing for CPU.

| Scenario | Samples/run | Median | p95 | Max |
|---|---|---|---|---|
| Normal playback, local network (20 s) | ~339 | 0.3–15 ms | 0.3–19 ms | 0.5–37 ms |
| After a seek during playback | 179 | 0.9–2.4 ms | 1.1–2.5 ms | 2.8–5.1 ms |
| Paused (position difference) | – | 2–15 ms | – | – |
| Reconnect (tab closed, reopened without key) | – | 2–19 ms | – | – |
| **Simulated ~300 ms RTT link with ±60 ms jitter**, normal playback (25 s) | 419 | 0.6–5.7 ms | 5.8–15 ms | 6–31 ms |
| Simulated ~300 ms RTT, after a seek | 179 | 2.3–11 ms | 2.5–11 ms | 3–12 ms |

All results are well under the 250 ms target. Caveats:
- Both browsers ran on one machine, so decoders and wall clocks are shared.
- Over real networks, clock-sync error is bounded by about half the RTT asymmetry. The simulated-latency test
  exercises this, but not real Wi-Fi jitter or hardware differences.
- YouTube/Vimeo sources use seek-only correction (discrete rates). Expected accuracy there is about 0.3–0.9 s. This
  is labelled in the UI and was not separately measured.

Other verified behaviour:
- **Access control:** an uninvited user without the key is refused.
- **Episode switching:** Bob picks E2 from the in-player list and both players load the same file.
- **Automatic next episode:** when E2 ends, the room advances both players to E3 exactly once (positions within
  0.3 s).
- **Calling:** WebRTC reaches `connected` with live remote audio and video frames on both sides, and mute state
  propagates.

## 6. Test suites

- `npm test`: 26 unit tests. Covers SRT→VTT, VTT parsing and active cues, media-name parsing (8 naming styles),
  timeline math, clock-offset estimation under jitter, the room state machine (scheduled play, pause freeze,
  seek barrier, idempotent episode-end, host-only, last-writer-wins), byte verification, source-kind detection, IA
  rendition grouping, and Jellyfin/Plex/TMDB contract tests.
- `npm run test:e2e`: 15 Playwright tests (all passing on a fresh database, 3.3 min) against real media and a real server on a fresh database. Covers
  catalogue, autocomplete, filtered search, movie and series detail, upcoming titles, playback and resume via
  Continue Watching, watchlist/favorites, source fallback, subtitles, user-added source verification, mobile
  layout (no horizontal overflow on 6 pages), the two-person sync suite, the latency suite, episode transitions,
  and the WebRTC call.

## 7. Bugs found and fixed during testing

- Tailwind content globs were URL-encoded (`{ts,tsx}`), so the UI rendered unstyled.
- Shaka 5 removed `setTextTrackVisibility`, which crashed the player page. Fixed with an API-version-aware engine
  and an error boundary.
- A transient archive.org failure was cached as "no sources" for 12 h. Failures now propagate, and negative results
  expire after 20 min.
- An Internet Archive DVD-rip item was mislabelled as "parts". Selection is now duration-based.
- The WebRTC manager lost its signalling listener on remount (React StrictMode). Its lifecycle is now owned by the
  effect.
- Fresh installs had an empty "Watch Free Now" shelf. Background seeding now runs on first start and repeats daily.
- Mobile hero/nav overlap, clipped navbar icon, low-contrast dark logos, raw language codes for in-stream subtitle
  tracks.
- Licensing scope: the first PD-TV pass surfaced whole series (e.g. *The Dick Van Dyke Show*, 158 episodes) that are
  only partly public domain. Scope is now restricted per episode, and those entries were purged.

## 8. Remaining issues and limitations

- Modern mainstream content requires your own media or servers (see §4).
- Jellyfin, Plex, OpenSubtitles and TMDB are implemented but were not live-verified here (credentials needed, and
  Jellyfin couldn't be launched in this sandbox).
- No TURN server is configured. Calls between two strictly-NATed networks may fail to connect; LAN and most home
  networks work via STUN.
- Background blur works only where the browser exposes `backgroundBlur` (recent Chrome on supported hardware).
  There is no canvas-segmentation fallback.
- Invite links from `localhost` only work on the same machine. Use the LAN link, or a tunnel plus
  `SYNCROOM_PUBLIC_URL`.
- Identity is per browser (localStorage). Clearing site data loses history and room tokens; there's no
  cross-device account.
- MKV playback depends on the browser's codec support, and SyncRoom doesn't transcode. Jellyfin/Plex transcoding
  covers that case.
- Rooms are optimised for two people. Calling is a mesh, so it works for 3–4 but isn't designed for more.
- Some Internet Archive films have only low-bitrate renditions, and subtitles exist for a minority of them.
- `node:sqlite` is still flagged experimental in Node 22 (prints a warning) but is stable in practice.

## 9. Steps for future deployment

1. Run `npm run build && npm start` behind HTTPS on any Node 22+ host or container. WebSocket upgrade is needed
   on `/ws`, and the app uses a single port.
2. Set `SYNCROOM_PUBLIC_URL` so invite links use the public hostname.
3. Persist `SYNCROOM_DATA_DIR`, which holds the SQLite database. For multiple instances, move rooms to a shared
   store (Redis pub/sub) or pin rooms to one instance.
4. Add a TURN server (e.g. coturn) to `ICE` in `web/src/rtc/call.ts` for reliable calling across NATs.
5. Optional: set a TMDB key, connect Jellyfin/Plex, and mount your media folder read-only.
6. Schedule `npm run verify:sources` (or rely on the built-in daily re-verification) to keep the public-domain index
   fresh.
