// Plex Media Server — matches by IMDb guid (falls back to title + year), direct file play and HLS transcode.
// Requires a Plex token. Implemented against the documented/observed PMS HTTP API; not live-verified in CI.
import type { PlaybackSource, SubtitleTrack } from '../../shared/types.ts';
import { getSetting } from '../db.ts';
import { fetchJson } from '../lib/http.ts';
import { caps, langName, stableId, subtitleProxyUrl, type ProviderSearchHit, type ResolveContext, type SourceProvider } from './types.ts';

interface PxStream { id: number; streamType: number; key?: string; languageCode?: string; displayTitle?: string; codec?: string }
interface PxPart { id: number; key: string; container?: string; size?: number; duration?: number; Stream?: PxStream[] }
interface PxMedia { id: number; videoResolution?: string; container?: string; Part: PxPart[] }
interface PxMeta { ratingKey: string; key: string; title: string; type: string; year?: number; index?: number; parentIndex?: number; Guid?: { id: string }[]; Media?: PxMedia[] }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class PlexProvider implements SourceProvider {
  id = 'plex';
  name = 'Plex';
  description = 'Stream from your own Plex Media Server (direct play or Plex HLS transcode).';
  kinds = ['file' as const, 'hls' as const];
  requiresConfig = true;
  configFields = [
    { key: 'url', label: 'Server URL', placeholder: 'http://192.168.1.10:32400', help: 'Must be reachable from every participant\'s browser.' },
    { key: 'token', label: 'X-Plex-Token', secret: true, help: 'See support.plex.tv "Finding an authentication token".' },
  ];
  private cfg() { return getSetting<{ url?: string; token?: string }>('provider.plex', {}); }
  isConfigured() { const c = this.cfg(); return !!(c.url && c.token); }
  private base() { return this.cfg().url!.replace(/\/+$/, ''); }
  private api<T>(path: string, params: Record<string, string | number> = {}) {
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), 'X-Plex-Token': this.cfg().token! });
    return fetchJson<T>(`${this.base()}${path}${path.includes('?') ? '&' : '?'}${qs}`, { headers: { Accept: 'application/json', 'X-Plex-Client-Identifier': 'syncroom', 'X-Plex-Product': 'SyncRoom' } });
  }
  async healthCheck() { await this.api('/identity'); }

  async search(query: string): Promise<ProviderSearchHit[]> {
    const r = await this.api<{ MediaContainer: { Metadata?: PxMeta[] } }>('/search', { query, limit: 30 });
    return (r.MediaContainer.Metadata ?? []).filter((m) => m.type === 'movie' || m.type === 'show').map((m) => ({
      providerItemId: m.ratingKey, title: m.title, year: m.year, imdbId: m.Guid?.find((g) => g.id.startsWith('imdb://'))?.id.slice(7), type: m.type === 'show' ? 'series' : 'movie',
    }));
  }

  async resolveTitle(ctx: ResolveContext): Promise<ProviderSearchHit[]> {
    const r = await this.api<{ MediaContainer: { Metadata?: PxMeta[] } }>('/search', { query: ctx.title, limit: 30, includeGuids: 1 });
    const want = ctx.type === 'series' ? 'show' : 'movie';
    return (r.MediaContainer.Metadata ?? [])
      .filter((m) => m.type === want)
      .filter((m) => {
        const imdb = m.Guid?.find((g) => g.id.startsWith('imdb://'))?.id.slice(7);
        if (imdb && ctx.imdbId) return imdb === ctx.imdbId;
        return norm(m.title) === norm(ctx.title) && (!ctx.year || !m.year || Math.abs(m.year - ctx.year) <= 1);
      })
      .map((m) => ({ providerItemId: m.ratingKey, title: m.title, year: m.year, type: ctx.type }));
  }

  async getAvailableSources(ctx: ResolveContext): Promise<PlaybackSource[]> {
    const hits = await this.resolveTitle(ctx);
    const items: PxMeta[] = [];
    for (const h of hits) {
      if (ctx.type === 'movie') {
        const r = await this.api<{ MediaContainer: { Metadata: PxMeta[] } }>(`/library/metadata/${h.providerItemId}`);
        items.push(...r.MediaContainer.Metadata);
      } else {
        const r = await this.api<{ MediaContainer: { Metadata?: PxMeta[] } }>(`/library/metadata/${h.providerItemId}/allLeaves`);
        items.push(...(r.MediaContainer.Metadata ?? []).filter((e) => e.parentIndex === ctx.season && e.index === ctx.episode));
      }
    }
    const token = this.cfg().token!;
    const out: PlaybackSource[] = [];
    for (const item of items) {
      for (const media of item.Media ?? []) {
        const part = media.Part[0];
        if (!part) continue;
        const subtitles: SubtitleTrack[] = (part.Stream ?? [])
          .filter((s) => s.streamType === 3 && s.key)
          .map((s) => ({ id: stableId('plex-sub', s.id), label: s.displayTitle ?? langName(s.languageCode ?? 'und'), lang: s.languageCode ?? 'und', url: subtitleProxyUrl(ctx.origin, `${this.base()}${s.key}?X-Plex-Token=${token}`), origin: 'Plex' }));
        const common = { providerId: this.id, providerName: this.name, subtitles, verify: { status: 'unverified' as const, checkedAt: 0 }, match: 'title-year' as const, adFree: true, license: 'Your Plex library', durationSec: part.duration ? part.duration / 1000 : undefined, sizeBytes: part.size };
        if (['mp4', 'm4v', 'mov', 'webm'].includes(part.container ?? media.container ?? '')) {
          out.push({ ...common, id: `plex:${stableId(part.id, 'direct')}`, label: `Plex · Direct ${media.videoResolution ?? ''}`.trim(), kind: 'file', url: `${this.base()}${part.key}?X-Plex-Token=${token}`, qualities: [], capabilities: caps('file') });
        }
        const qs = new URLSearchParams({ path: `/library/metadata/${item.ratingKey}`, mediaIndex: '0', partIndex: '0', protocol: 'hls', fastSeek: '1', directPlay: '0', directStream: '1', videoQuality: '100', maxVideoBitrate: '12000', 'X-Plex-Token': token, 'X-Plex-Client-Identifier': 'syncroom', 'X-Plex-Product': 'SyncRoom', 'X-Plex-Platform': 'Chrome', session: stableId(item.ratingKey, Date.now()) });
        out.push({ ...common, id: `plex:${stableId(part.id, 'hls')}`, label: 'Plex · Transcoded HLS', kind: 'hls', url: `${this.base()}/video/:/transcode/universal/start.m3u8?${qs}`, qualities: [], capabilities: caps('hls', { qualitySelection: false }) });
      }
    }
    return out;
  }
}
