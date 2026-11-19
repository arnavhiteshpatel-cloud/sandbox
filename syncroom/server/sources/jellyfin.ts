// Jellyfin — your own media server. Matches by IMDb provider id (falls back to name + year), offers direct play
// and an HLS transcode (works for any codec), plus text subtitles converted to WebVTT by Jellyfin.
import type { PlaybackSource, SubtitleTrack } from '../../shared/types.ts';
import { getSetting } from '../db.ts';
import { fetchJson } from '../lib/http.ts';
import { caps, langName, stableId, subtitleProxyUrl, type ProviderSearchHit, type ResolveContext, type SourceProvider } from './types.ts';

interface JfStream { Type: string; Index: number; Language?: string; DisplayTitle?: string; Title?: string; IsTextSubtitleStream?: boolean; IsExternal?: boolean; Codec?: string; Height?: number }
interface JfMediaSource { Id: string; Container?: string; Name?: string; Size?: number; RunTimeTicks?: number; MediaStreams?: JfStream[]; SupportsDirectPlay?: boolean }
interface JfItem { Id: string; Name: string; Type: string; ProductionYear?: number; ProviderIds?: Record<string, string>; IndexNumber?: number; ParentIndexNumber?: number; MediaSources?: JfMediaSource[]; RunTimeTicks?: number; SeriesId?: string }

const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm']);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export class JellyfinProvider implements SourceProvider {
  id = 'jellyfin';
  name = 'Jellyfin';
  description = 'Stream from your own Jellyfin server. Direct play when the browser supports the file, otherwise Jellyfin transcodes to HLS.';
  kinds = ['file' as const, 'hls' as const];
  requiresConfig = true;
  configFields = [
    { key: 'url', label: 'Server URL', placeholder: 'http://192.168.1.10:8096', help: 'Must be reachable from every participant\'s browser (use a LAN IP or tunnel, not localhost, for remote partners).' },
    { key: 'apiKey', label: 'API key', secret: true, help: 'Dashboard → API Keys → +' },
    { key: 'userId', label: 'User ID (optional)', help: 'Restrict to one user\'s libraries. Defaults to the first administrator.' },
  ];

  private cfg() {
    return getSetting<{ url?: string; apiKey?: string; userId?: string }>('provider.jellyfin', {});
  }
  isConfigured() {
    const c = this.cfg();
    return !!(c.url && c.apiKey);
  }
  private base() {
    return this.cfg().url!.replace(/\/+$/, '');
  }
  private async api<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return fetchJson<T>(`${this.base()}${path}?${qs}`, { headers: { Authorization: `MediaBrowser Token="${this.cfg().apiKey}"`, 'X-Emby-Token': this.cfg().apiKey! }, timeoutMs: 15000 });
  }
  private userIdCache?: string;
  private async userId() {
    const c = this.cfg();
    if (c.userId) return c.userId;
    if (this.userIdCache) return this.userIdCache;
    const users = await this.api<{ Id: string; Policy?: { IsAdministrator?: boolean } }[]>('/Users');
    this.userIdCache = (users.find((u) => u.Policy?.IsAdministrator) ?? users[0])?.Id;
    return this.userIdCache;
  }

  async healthCheck() {
    await this.api('/System/Info/Public');
  }

  private async items(params: Record<string, string | number | boolean | undefined>) {
    const uid = await this.userId();
    const r = await this.api<{ Items: JfItem[] }>('/Items', { Recursive: true, Fields: 'ProviderIds,MediaSources,MediaStreams', userId: uid, Limit: 50, ...params });
    return r.Items;
  }

  async search(query: string): Promise<ProviderSearchHit[]> {
    const items = await this.items({ searchTerm: query, IncludeItemTypes: 'Movie,Series' });
    return items.map((i) => ({ providerItemId: i.Id, title: i.Name, year: i.ProductionYear, imdbId: i.ProviderIds?.Imdb, type: i.Type === 'Series' ? 'series' : 'movie' }));
  }

  async resolveTitle(ctx: ResolveContext): Promise<ProviderSearchHit[]> {
    const type = ctx.type === 'series' ? 'Series' : 'Movie';
    let items: JfItem[] = [];
    if (ctx.imdbId) items = (await this.items({ IncludeItemTypes: type, AnyProviderIdEquals: `Imdb.${ctx.imdbId}` })).filter((i) => i.ProviderIds?.Imdb === ctx.imdbId);
    if (!items.length) {
      items = (await this.items({ IncludeItemTypes: type, searchTerm: ctx.title })).filter(
        (i) => (ctx.imdbId && i.ProviderIds?.Imdb ? i.ProviderIds.Imdb === ctx.imdbId : norm(i.Name) === norm(ctx.title) && (!ctx.year || !i.ProductionYear || Math.abs(i.ProductionYear - ctx.year) <= 1)),
      );
    }
    return items.map((i) => ({ providerItemId: i.Id, title: i.Name, year: i.ProductionYear, imdbId: i.ProviderIds?.Imdb, type: ctx.type }));
  }

  async getAvailableSources(ctx: ResolveContext): Promise<PlaybackSource[]> {
    const hits = await this.resolveTitle(ctx);
    let playable: JfItem[] = [];
    if (ctx.type === 'movie') {
      playable = (await Promise.all(hits.map((h) => this.items({ Ids: h.providerItemId })))).flat();
    } else {
      for (const h of hits) {
        const uid = await this.userId();
        const eps = await this.api<{ Items: JfItem[] }>(`/Shows/${h.providerItemId}/Episodes`, { season: ctx.season, userId: uid, Fields: 'MediaSources,MediaStreams,ProviderIds' });
        playable.push(...eps.Items.filter((e) => e.IndexNumber === ctx.episode && (e.ParentIndexNumber ?? ctx.season) === ctx.season));
      }
    }
    const key = this.cfg().apiKey!;
    const out: PlaybackSource[] = [];
    for (const item of playable) {
      for (const ms of item.MediaSources ?? []) {
        const streams = ms.MediaStreams ?? [];
        const video = streams.find((s) => s.Type === 'Video');
        const subtitles: SubtitleTrack[] = streams
          .filter((s) => s.Type === 'Subtitle' && s.IsTextSubtitleStream)
          .map((s) => {
            const u = `${this.base()}/Videos/${item.Id}/${ms.Id}/Subtitles/${s.Index}/0/Stream.vtt?api_key=${key}`;
            return { id: stableId('jf-sub', item.Id, ms.Id, s.Index), label: s.DisplayTitle ?? langName(s.Language ?? 'und'), lang: s.Language ?? 'und', url: subtitleProxyUrl(ctx.origin, u), origin: 'Jellyfin' };
          });
        const duration = ms.RunTimeTicks ? ms.RunTimeTicks / 1e7 : undefined;
        const common = { providerId: this.id, providerName: this.name, subtitles, verify: { status: 'unverified' as const, checkedAt: 0 }, match: (hits[0]?.imdbId ? 'exact-id' : 'title-year') as PlaybackSource['match'], adFree: true, license: 'Your Jellyfin library', durationSec: duration, sizeBytes: ms.Size };
        const containers = (ms.Container ?? '').split(',');
        if (containers.some((c) => DIRECT_CONTAINERS.has(c.trim()))) {
          out.push({
            ...common, id: `jellyfin:${stableId(item.Id, ms.Id, 'direct')}`, label: `Jellyfin · Direct${video?.Height ? ` ${video.Height}p` : ''}`, kind: 'file',
            url: `${this.base()}/Videos/${item.Id}/stream?static=true&mediaSourceId=${ms.Id}&api_key=${key}`, qualities: [], capabilities: caps('file'),
          });
        }
        out.push({
          ...common, id: `jellyfin:${stableId(item.Id, ms.Id, 'hls')}`, label: `Jellyfin · Transcoded HLS${video?.Height ? ` (${video.Height}p source)` : ''}`, kind: 'hls',
          url: `${this.base()}/Videos/${item.Id}/master.m3u8?mediaSourceId=${ms.Id}&api_key=${key}&VideoCodec=h264&AudioCodec=aac&TranscodingMaxAudioChannels=2&SegmentContainer=ts&MaxStreamingBitrate=12000000&DeviceId=syncroom-${stableId(ctx.origin)}&PlaySessionId=${stableId(item.Id, Date.now())}`,
          qualities: [], capabilities: caps('hls', { qualitySelection: false }),
          notes: 'Transcoded by your Jellyfin server; seeking far ahead may take a moment while segments are produced.',
        });
      }
    }
    return out;
  }
}
