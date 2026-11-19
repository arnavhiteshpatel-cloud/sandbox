// Shared domain + protocol types used by both the server and the web client.

export type MediaType = 'movie' | 'series';

export interface TitleSummary {
  /** Canonical catalogue id. IMDb id (tt…) when known, otherwise provider-prefixed (e.g. tmdb-movie-123). */
  id: string;
  imdbId?: string;
  type: MediaType;
  name: string;
  year?: number;
  /** e.g. "2008–2013" for series */
  releaseInfo?: string;
  releaseDate?: string;
  poster?: string;
  background?: string;
  logo?: string;
  rating?: number;
  genres?: string[];
  description?: string;
  runtime?: string;
  country?: string;
  /** Release date is in the future — never watchable yet. */
  upcoming?: boolean;
}

export interface Person {
  name: string;
  role: 'cast' | 'director' | 'writer' | 'creator';
  character?: string;
  photo?: string;
}

export interface Episode {
  /** `${titleId}:${season}:${episode}` */
  id: string;
  season: number;
  episode: number;
  name: string;
  overview?: string;
  thumbnail?: string;
  released?: string;
  rating?: number;
  upcoming?: boolean;
}

export interface Trailer {
  ytId: string;
  name: string;
}

export interface TitleDetail extends TitleSummary {
  people: Person[];
  trailers: Trailer[];
  awards?: string;
  status?: string;
  seasons?: number[];
  episodes?: Episode[];
  metadataProvider: string;
  fetchedAt: number;
}

export interface CatalogSection {
  id: string;
  title: string;
  subtitle?: string;
  items: TitleSummary[];
  /** Link to a browse page for the full list */
  href?: string;
}

/** Identifies one playable unit: a movie, or one episode of a series. */
export interface MediaRef {
  titleId: string;
  type: MediaType;
  season?: number;
  episode?: number;
}

export function mediaKey(ref: MediaRef): string {
  return ref.type === 'series' && ref.season != null && ref.episode != null
    ? `${ref.titleId}:${ref.season}:${ref.episode}`
    : ref.titleId;
}

// ---------------------------------------------------------------- sources

/** How the client must play the source. Each kind maps to a client playback engine. */
export type SourceKind = 'file' | 'hls' | 'dash' | 'youtube' | 'vimeo';

/**
 * How precisely a source can be synchronised.
 *  frame   – direct media element: seek + fine playback-rate nudging (<~100 ms achievable)
 *  precise – full control API incl. arbitrary rate (Vimeo)
 *  coarse  – control API but only seek correction / discrete rates (YouTube) (~0.3–0.6 s)
 *  none    – no control API: cannot be synchronised; we never pretend otherwise
 */
export type SyncGrade = 'frame' | 'precise' | 'coarse' | 'none';

export interface SourceCapabilities {
  play: boolean;
  pause: boolean;
  seek: boolean;
  getCurrentTime: boolean;
  getDuration: boolean;
  getPlaybackState: boolean;
  getBufferingState: boolean;
  setPlaybackRate: boolean | 'discrete';
  subtitles: boolean;
  qualitySelection: boolean;
  pictureInPicture: boolean;
  syncGrade: SyncGrade;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  lang: string;
  /** WebVTT url (always served through our /api/subtitles proxy) or 'embedded' for in-manifest tracks */
  url: string;
  origin: string;
}

export interface QualityOption {
  id: string;
  label: string;
  height?: number;
  /** Separate url for file sources with multiple renditions */
  url?: string;
}

export type VerifyStatus = 'verified' | 'unverified' | 'failed';

export interface PlaybackSource {
  id: string;
  providerId: string;
  providerName: string;
  label: string;
  kind: SourceKind;
  url: string;
  mimeType?: string;
  qualities: QualityOption[];
  subtitles: SubtitleTrack[];
  capabilities: SourceCapabilities;
  verify: { status: VerifyStatus; checkedAt: number; detail?: string };
  /** How the source was matched to the catalogue title */
  match: 'exact-id' | 'title-year' | 'episode-title' | 'user' | 'curated';
  adFree: boolean;
  license?: string;
  attribution?: string;
  notes?: string;
  sizeBytes?: number;
  durationSec?: number;
}

export interface ProviderConfigField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderHealth {
  ok: boolean | null;
  lastCheck?: number;
  latencyMs?: number;
  lastError?: string;
  successes: number;
  failures: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  description: string;
  kinds: SourceKind[];
  requiresConfig: boolean;
  configured: boolean;
  enabled: boolean;
  configFields: ProviderConfigField[];
  status: 'live-verified' | 'needs-authorization' | 'disabled';
  health: ProviderHealth;
}

export interface SourcesResponse {
  ref: MediaRef;
  sources: PlaybackSource[];
  /** providers that were checked and how they answered */
  checked: { providerId: string; providerName: string; found: number; error?: string; skipped?: string }[];
}

// ---------------------------------------------------------------- personal

export interface ProgressEntry {
  mediaKey: string;
  ref: MediaRef;
  title: TitleSummary;
  episodeName?: string;
  position: number;
  duration: number;
  completed: boolean;
  updatedAt: number;
  sourceId?: string;
}

export type LibraryList = 'watchlist' | 'favorite';

// ---------------------------------------------------------------- rooms / sync

export interface RoomMedia {
  ref: MediaRef;
  sourceId: string;
  /** Full source descriptor so joiners don't need to re-resolve before starting */
  source: PlaybackSource;
  title: TitleSummary;
  episodeName?: string;
}

export interface RoomSettings {
  /** Pause everyone while any participant buffers */
  pauseOnBuffer: boolean;
  autoplayNext: boolean;
  /** Only the host may control playback */
  hostOnly: boolean;
}

export interface RoomState {
  roomId: string;
  name: string;
  hostId: string;
  media: RoomMedia | null;
  playing: boolean;
  /** Media position (seconds) at server time `updatedAt` */
  position: number;
  rate: number;
  /** Server epoch ms at which `position` is valid. May be slightly in the future for scheduled starts. */
  updatedAt: number;
  seq: number;
  /** Participant ids we are waiting on (loading/buffering). While non-empty playback is held. */
  waitingFor: string[];
  settings: RoomSettings;
  lastAction?: { by: string; byName: string; type: string; at: number };
}

export interface Participant {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  buffering: boolean;
  ready: boolean;
  driftMs?: number;
  rttMs?: number;
  sourceError?: string;
  media?: { mic: boolean; cam: boolean };
  lastSeen: number;
}

export type ControlCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; position: number }
  | { type: 'rate'; rate: number }
  | { type: 'restart' }
  | { type: 'load'; media: RoomMedia; position?: number; autoplay?: boolean }
  | { type: 'ended'; mediaKey: string; next?: RoomMedia | null }
  | { type: 'settings'; settings: Partial<RoomSettings> }
  | { type: 'transferHost'; to: string };

export type ClientMessage =
  | { t: 'hello'; roomId: string; userId: string; name: string; token?: string; key?: string }
  | { t: 'ping'; c: number }
  | { t: 'cmd'; cmd: ControlCommand; baseSeq: number }
  | { t: 'status'; seq: number; buffering: boolean; ready: boolean; position?: number; driftMs?: number; rttMs?: number; error?: string }
  | { t: 'rtc'; to: string; data: unknown }
  | { t: 'media'; mic: boolean; cam: boolean }
  | { t: 'chat'; text: string };

export type ServerMessage =
  | { t: 'welcome'; you: string; token: string; state: RoomState; participants: Participant[]; serverTime: number }
  | { t: 'state'; state: RoomState; serverTime: number }
  | { t: 'participants'; participants: Participant[] }
  | { t: 'pong'; c: number; s: number }
  | { t: 'rtc'; from: string; data: unknown }
  | { t: 'chat'; from: string; name: string; text: string; at: number }
  | { t: 'error'; code: string; message: string };

/** Expected media position for a room state at a given server time. */
export function expectedPosition(state: Pick<RoomState, 'playing' | 'position' | 'rate' | 'updatedAt' | 'waitingFor'>, serverNow: number): number {
  if (!state.playing || state.waitingFor.length > 0) return state.position;
  const elapsed = (serverNow - state.updatedAt) / 1000;
  // Before a scheduled start the position is held.
  return elapsed <= 0 ? state.position : state.position + elapsed * state.rate;
}
