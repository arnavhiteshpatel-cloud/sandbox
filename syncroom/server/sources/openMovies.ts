// Blender Foundation open movies (Creative Commons Attribution). Curated, stable adaptive streams + official subtitles.
import type { PlaybackSource, SourceKind, SubtitleTrack } from '../../shared/types.ts';
import { caps, langName, stableId, subtitleProxyUrl, type ResolveContext, type SourceProvider } from './types.ts';

interface Rendition { kind: SourceKind; url: string; label: string; host: string }
interface OpenMovie { imdbId: string; title: string; year: number; license: string; renditions: Rendition[]; subtitles: { lang: string; url: string; label?: string }[] }

const SINTEL_SUBS = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'ru', 'pl'].map((l) => ({ lang: l, url: `https://durian.blender.org/wp-content/content/subtitles/sintel_${l}.srt` }));
const TOS = 'https://download.blender.org/demo/movies/ToS/subtitles/';
const TOS_SUBS = [
  ['en', 'TOS-en.srt'], ['de', 'TOS-de.srt'], ['es', 'TOS-es.srt'], ['fr', 'TOS-fr-orig.srt'], ['it', 'TOS-it.srt'], ['nl', 'TOS-nl.srt'], ['ru', 'TOS-ru.srt'],
  ['pt', 'TOS-PT-BR.srt', 'Portuguese (Brazil)'], ['ja', 'TOS-JP.srt'], ['zh', 'TOS-CH.srt'], ['cs', 'TOS-CZ.srt'], ['hu', 'TOS-HU.srt'], ['he', 'TOS-HE.srt'], ['no', 'TOS-no.srt'], ['da', 'TOS-Dansk.srt'],
].map(([lang, f, label]) => ({ lang, url: TOS + f, label }));

export const OPEN_MOVIES: OpenMovie[] = [
  {
    imdbId: 'tt1727587', title: 'Sintel', year: 2010, license: 'CC BY 3.0 — © Blender Foundation | durian.blender.org',
    renditions: [
      { kind: 'dash', url: 'https://storage.googleapis.com/shaka-demo-assets/sintel/dash.mpd', label: 'Adaptive (DASH)', host: 'Shaka demo CDN' },
    ],
    subtitles: SINTEL_SUBS,
  },
  {
    imdbId: 'tt2285752', title: 'Tears of Steel', year: 2012, license: 'CC BY 3.0 — © Blender Foundation | mango.blender.org',
    renditions: [
      { kind: 'hls', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8', label: 'Adaptive (HLS)', host: 'Unified Streaming' },
      { kind: 'dash', url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.mpd', label: 'Adaptive (DASH)', host: 'Unified Streaming' },
      { kind: 'file', url: 'https://download.blender.org/demo/movies/ToS/tears_of_steel_720p.mov', label: '720p file', host: 'download.blender.org' },
    ],
    subtitles: TOS_SUBS,
  },
  {
    imdbId: 'tt1254207', title: 'Big Buck Bunny', year: 2008, license: 'CC BY 3.0 — © Blender Foundation | bigbuckbunny.org',
    renditions: [
      { kind: 'hls', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', label: 'Adaptive (HLS)', host: 'Mux test streams' },
      { kind: 'dash', url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd', label: 'Adaptive (DASH)', host: 'Akamai DASH test' },
    ],
    subtitles: [],
  },
];

export class OpenMoviesProvider implements SourceProvider {
  id = 'openmovies';
  name = 'Open Movies';
  description = 'Blender Foundation open movies (CC BY) streamed as adaptive HLS/DASH with official multi-language subtitles.';
  kinds: SourceKind[] = ['hls', 'dash', 'file'];
  requiresConfig = false;
  configFields = [];
  isConfigured() { return true; }

  async healthCheck() {
    const r = await fetch(OPEN_MOVIES[1].renditions[0].url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }

  async getAvailableSources(ctx: ResolveContext): Promise<PlaybackSource[]> {
    const m = OPEN_MOVIES.find((o) => o.imdbId === ctx.imdbId || o.imdbId === ctx.ref.titleId);
    if (!m || ctx.type !== 'movie') return [];
    const subs: SubtitleTrack[] = m.subtitles.map((s) => ({ id: stableId('om-sub', s.url), label: s.label ?? langName(s.lang), lang: s.lang, url: subtitleProxyUrl(ctx.origin, s.url), origin: 'Blender Foundation' }));
    return m.renditions.map((r) => ({
      id: `openmovies:${stableId(r.url)}`,
      providerId: this.id,
      providerName: this.name,
      label: `${r.label} · ${r.host}`,
      kind: r.kind,
      url: r.url,
      qualities: [],
      subtitles: subs,
      capabilities: caps(r.kind, { qualitySelection: r.kind !== 'file' }),
      verify: { status: 'unverified', checkedAt: 0 },
      match: 'curated',
      adFree: true,
      license: m.license,
      attribution: 'Blender Foundation',
    }));
  }
}
