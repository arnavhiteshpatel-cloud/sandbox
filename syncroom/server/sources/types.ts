import { sign } from '../lib/sign.ts';
import type { MediaRef, MediaType, PlaybackSource, ProviderConfigField, SourceCapabilities, SourceKind, SubtitleTrack } from '../../shared/types.ts';

/** Everything a provider may use to locate a title. */
export interface ResolveContext {
  ref: MediaRef;
  type: MediaType;
  imdbId?: string;
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeName?: string;
  /** Base URL of this SyncRoom server as seen by the browser (for provider proxy URLs). */
  origin: string;
}

export interface ProviderSearchHit {
  providerItemId: string;
  title: string;
  year?: number;
  imdbId?: string;
  type: MediaType;
}

/**
 * Server half of a streaming-provider adapter: discovery + resolution.
 * The client half (play/pause/seek/getCurrentTime/getDuration/getPlaybackState/getBufferingState/
 * setPlaybackRate/destroy) lives in web/src/player/engines and is selected by PlaybackSource.kind.
 * Capabilities a provider/kind lacks are reported as false — never simulated.
 */
export interface SourceProvider {
  id: string;
  name: string;
  description: string;
  kinds: SourceKind[];
  requiresConfig: boolean;
  configFields: ProviderConfigField[];
  isConfigured(): boolean;
  /** Native search in the provider's own library (optional). */
  search?(query: string): Promise<ProviderSearchHit[]>;
  /** Locate provider items matching a catalogue title (optional, used by getAvailableSources). */
  resolveTitle?(ctx: ResolveContext): Promise<ProviderSearchHit[]>;
  getAvailableSources(ctx: ResolveContext): Promise<PlaybackSource[]>;
  /** Fresh playback URL for a source (for providers whose URLs expire). Defaults to source.url. */
  getPlaybackUrl?(source: PlaybackSource): Promise<string>;
  getSubtitles?(source: PlaybackSource, ctx: ResolveContext): Promise<SubtitleTrack[]>;
  /** Cheap reachability probe for health monitoring. */
  healthCheck(): Promise<void>;
}

const base = { play: true, pause: true, seek: true, getCurrentTime: true, getDuration: true, getPlaybackState: true, getBufferingState: true };

export const CAPS: Record<SourceKind, SourceCapabilities> = {
  file: { ...base, setPlaybackRate: true, subtitles: true, qualitySelection: false, pictureInPicture: true, syncGrade: 'frame' },
  hls: { ...base, setPlaybackRate: true, subtitles: true, qualitySelection: true, pictureInPicture: true, syncGrade: 'frame' },
  dash: { ...base, setPlaybackRate: true, subtitles: true, qualitySelection: true, pictureInPicture: true, syncGrade: 'frame' },
  // YouTube IFrame API: full transport control, discrete rates only, no caption-track API, buffering via state 3.
  youtube: { ...base, setPlaybackRate: 'discrete', subtitles: false, qualitySelection: false, pictureInPicture: false, syncGrade: 'coarse' },
  // Vimeo Player SDK: transport + text tracks; arbitrary rate only on PRO-owned videos, so treat as discrete.
  vimeo: { ...base, setPlaybackRate: 'discrete', subtitles: true, qualitySelection: false, pictureInPicture: true, syncGrade: 'coarse' },
};

export function caps(kind: SourceKind, extra: Partial<SourceCapabilities> = {}): SourceCapabilities {
  return { ...CAPS[kind], ...extra };
}

export function stableId(...parts: (string | number | undefined)[]) {
  const s = parts.filter((p) => p !== undefined).join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function subtitleProxyUrl(origin: string, url: string) {
  return `${origin}/api/subtitles/proxy?url=${encodeURIComponent(url)}&sig=${sign(url)}`;
}

export const LANG_NAMES: Record<string, string> = {
  en: 'English', eng: 'English', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French', de: 'German', ger: 'German', deu: 'German',
  it: 'Italian', ita: 'Italian', nl: 'Dutch', dut: 'Dutch', nld: 'Dutch', pt: 'Portuguese', por: 'Portuguese', ru: 'Russian', rus: 'Russian', pl: 'Polish', pol: 'Polish',
  hi: 'Hindi', hin: 'Hindi', ja: 'Japanese', jpn: 'Japanese', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese', ko: 'Korean', kor: 'Korean', ar: 'Arabic', ara: 'Arabic',
  sv: 'Swedish', swe: 'Swedish', da: 'Danish', dan: 'Danish', fi: 'Finnish', fin: 'Finnish', no: 'Norwegian', nor: 'Norwegian', tr: 'Turkish', tur: 'Turkish',
  he: 'Hebrew', heb: 'Hebrew', cs: 'Czech', cze: 'Czech', ces: 'Czech', hu: 'Hungarian', hun: 'Hungarian', el: 'Greek', gre: 'Greek', ro: 'Romanian', rum: 'Romanian',
  ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', bn: 'Bengali', ben: 'Bengali', ml: 'Malayalam', mr: 'Marathi', uk: 'Ukrainian', ukr: 'Ukrainian', vi: 'Vietnamese', id: 'Indonesian',
};
export const langName = (code: string) => LANG_NAMES[code.toLowerCase()] ?? code.toUpperCase();
