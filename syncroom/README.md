# SyncRoom

Watch movies and series together, in sync — a cinematic, ad-free streaming front-end with private two-person rooms,
a large real catalogue, and **only verified, authorized playback sources**.

- Real catalogue: tens of thousands of browsable movies and series (Hollywood, world/Indian cinema, classics, animation,
  documentaries, upcoming titles), full season/episode lists, cast & crew, ratings, trailers, recommendations.
- Real playback: your own media folder, your Jellyfin/Plex server, links you add (MP4/WebM/HLS/DASH/YouTube/Vimeo),
  Blender Foundation open movies, and public-domain films/TV from curated Internet Archive collections.
  Every source is test-fetched before it is shown as playable.
- Rooms: private invite links, either person controls play/pause/seek/episode/source, NTP-style clock sync,
  drift correction, buffering holds, automatic next episode, reconnect-and-resume, chat, optional P2P voice/video.

> Catalogue ≠ playable. A title can be in the catalogue without any source. Only titles with a green **WATCH**
> badge (or a verified source on their page) can be played. SyncRoom never shows a player for content it can't play.

## Run it

Requirements: **Node.js 22.5+** (uses the built-in `node:sqlite`), a modern Chromium/Firefox/Safari.

```bash
cd syncroom
npm install
npm run dev
```

Open <http://localhost:4300>. The API, WebSocket and web app share this one port.

On first start SyncRoom seeds its *verified-playable* index in the background (about a minute). To verify the whole
public-domain library (~2,000 Internet Archive titles, ~5 minutes):

```bash
npm run verify:sources
```

Production mode (pre-built client, same single port):

```bash
npm run build
npm start
```

### Watching with someone

1. Open a title → **Watch together** (or **Rooms → Create private room**).
2. Click **Invite** and send the link. The secret after `#k=` grants access; it never reaches server logs.
3. Same Wi‑Fi: use the LAN link shown in the invite dialog (e.g. `http://192.168.1.20:4300/room/…`).
   Different networks: put SyncRoom behind any HTTPS tunnel/reverse proxy and set `SYNCROOM_PUBLIC_URL`.
4. Either person can play, pause, seek, change episode or source; everyone follows.

### Your own media

Put files in `syncroom/media` (or set the folder in **Settings → My media folder**, or `SYNCROOM_MEDIA_DIR`):

```
Movies/Night of the Living Dead (1968).mp4
Movies/Sintel (2010) [tt1727587].mp4          ← optional IMDb tag = exact match
Movies/Sintel (2010) [tt1727587].en.srt       ← sidecar subtitles, any language
TV/Sherlock Holmes (1954)/Season 1/Sherlock Holmes - S01E02 - The Case of Lady Beryl.mp4
```

Files are streamed by your SyncRoom server with byte-range support, so your partner can play them too.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `4300` / `0.0.0.0` | Listen address |
| `SYNCROOM_DATA_DIR` | `./data` | SQLite database + caches |
| `SYNCROOM_DB` | `data/syncroom.db` | Database file (`:memory:` for tests) |
| `SYNCROOM_MEDIA_DIR` | `./media` | Your media folder |
| `SYNCROOM_PUBLIC_URL` | – | Public base URL used in invite links |
| `TMDB_API_KEY` | – | Optional TMDB v3 key or v4 read token (also settable in Settings) |
| `SYNCROOM_NO_SEED` | – | Disable background seeding of the playable index |

Jellyfin, Plex and OpenSubtitles are configured in **Settings → Playback sources** (URL + API key/token).

## Architecture

```
syncroom/
  shared/types.ts          domain + WebSocket protocol types, shared timeline math
  server/
    index.ts               Express + ws on one port (Vite middleware in dev, static build in prod)
    db.ts                  node:sqlite (WAL) + migrations
    metadata/              MetadataProvider: cinemeta.ts (keyless default), tmdb.ts (with key), SWR cache
    sources/               SourceProvider adapters + registry, verification, health, seeding
    rooms/roomManager.ts   authoritative room state machine
    routes/                REST API
  web/src/
    player/engines/        PlayerEngine: html5, hls (hls.js), dash (Shaka), youtube (IFrame API), vimeo (SDK)
    player/Player.tsx      controls, subtitles, quality, speed, episodes, PiP, keyboard
    sync/                  clock sync, room client, SyncController (drift correction)
    rtc/                   WebRTC calling (perfect negotiation over the room socket)
    pages/                 Home, Browse, Search, Title, Watch, Room, Library, Free, Settings, Rooms
  scripts/verify-sources.ts  bulk verification of the public-domain library
  tests/unit, tests/e2e      Vitest + Playwright
```

### Provider adapters

A provider is split in two halves:

- **Server `SourceProvider`** (`server/sources/types.ts`): `search`, `resolveTitle`, `getAvailableSources`,
  `getPlaybackUrl`, `getSubtitles`, `healthCheck`, `isConfigured`, and config fields. Adding a provider means
  implementing this interface and adding it to the `providers` array in `registry.ts`.
- **Client `PlayerEngine`** (`web/src/player/engines/types.ts`), selected by the source's `kind`: `play`, `pause`,
  `seek`, `getCurrentTime`, `getDuration`, `getPlaybackState`, `getBufferingState`, `setPlaybackRate`, quality and
  text-track selection, and `destroy`.

Each source carries `capabilities` (including `syncGrade`). Unsupported features are reported as such and never
simulated: YouTube has discrete rates only and no caption API; arbitrary embeds without a control API can't be synced
and are not offered.

### Synchronization

The server holds the authoritative timeline `{position, updatedAt, rate, playing, waitingFor, seq}`. Clients estimate
the server clock offset from the lowest-RTT ping samples, then continuously compute
`expected = position + (serverNow − updatedAt) × rate`:

- **Small drift** (> 30 ms): playback-rate nudging, up to ±8%, for native/HLS/DASH sources.
- **Large drift** (> 0.6 s): seek, with learned seek latency.
- **Play/resume:** scheduled 350 ms ahead, so both players start on the same server instant.
- **Buffering, loading, seeks:** with "wait for each other" on, the room holds until every player acknowledges
  readiness for the current `seq`. A timeout means a stalled partner can't freeze the room.
- **Episode end:** idempotent, so only the first `ended` for the current media advances the room.
- **Conflicting commands:** applied in server-arrival order, and the last one wins.
- **Reconnect:** a per-member token restores the room. When the last person leaves, the room freezes at the
  current position.

## Tests

```bash
npm run typecheck          # TypeScript
npm test                   # unit tests (Vitest)
npm run test:e2e           # Playwright end-to-end (starts its own server on :4310 with data/e2e.db)
```

The E2E suite plays real public-domain media: two-browser sync with measured drift (including a simulated
300 ms RTT link with jitter), episode transitions, reconnect, access control, a WebRTC call, playback fallback,
subtitles, progress and lists, and mobile layout. See `docs/IMPLEMENTATION_REPORT.md` for results.

## Content & legal

SyncRoom shows no advertising. It integrates only sources you are entitled to use: your files and servers, links you
add, Creative Commons open movies, and works in the public domain (curated Internet Archive collections; public-domain
TV only for series whose public-domain scope is documented). It does not integrate unlicensed streaming aggregators,
and does not bypass DRM, authentication or provider restrictions. Metadata: Cinemeta (Stremio's IMDb-keyed catalogue)
or, with a key, TMDB — *"This product uses the TMDB API but is not endorsed or certified by TMDB."*
