import type { CatalogSection, MediaRef, MediaType, PlaybackSource, ProgressEntry, ProviderInfo, SourcesResponse, TitleDetail, TitleSummary } from '@shared/types';
import { userId } from './identity';

export type Title = TitleSummary & { playable?: boolean };

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = (await r.json()).error ?? msg; } catch { /* */ }
    throw new Error(msg);
  }
  return r.json();
}
const body = (method: string, data: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
const qs = (o: Record<string, unknown>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  home: () => j<{ sections: CatalogSection[]; provider: string; attribution: string }>('/api/catalog/home'),
  browse: (q: { type: MediaType; genre?: string; year?: number; sort?: string; page?: number }) => j<{ items: Title[]; hasMore: boolean }>(`/api/catalog/browse?${qs(q)}`),
  genres: (type: MediaType) => j<{ genres: string[] }>(`/api/catalog/genres?type=${type}`),
  search: (q: Record<string, unknown>) => j<{ items: Title[] }>(`/api/catalog/search?${qs(q)}`),
  suggest: (q: string, signal?: AbortSignal) => j<{ items: Title[] }>(`/api/catalog/suggest?q=${encodeURIComponent(q)}`, { signal }),
  title: (type: MediaType, id: string) => j<TitleDetail>(`/api/title/${type}/${encodeURIComponent(id)}`),
  recommendations: (type: MediaType, id: string) => j<{ items: Title[] }>(`/api/title/${type}/${encodeURIComponent(id)}/recommendations`),
  sources: (ref: MediaRef) => j<SourcesResponse>(`/api/sources/${ref.type}/${encodeURIComponent(ref.titleId)}?${qs({ season: ref.season, episode: ref.episode })}`),
  episodeAvailability: (id: string) => j<{ episodes: string[] }>(`/api/sources/series/${encodeURIComponent(id)}/episodes`),
  report: (s: PlaybackSource, ok: boolean, detail?: string) => fetch('/api/sources/report', body('POST', { sourceId: s.id, providerId: s.providerId, ok, detail })).catch(() => {}),
  free: (offset = 0, limit = 60) => j<{ items: Title[]; totals: { titles: number; units: number } }>(`/api/free?offset=${offset}&limit=${limit}`),
  addSource: (d: { titleId: string; mediaKey: string; url: string; label?: string; subtitles?: { url: string; lang: string }[] }) => j<{ id: string; verify: { status: string; detail: string } }>('/api/user-sources', body('POST', { ...d, userId: userId() })),
  removeSource: (id: string) => j('/api/user-sources/' + encodeURIComponent(id), { method: 'DELETE' }),

  progress: () => j<{ continueWatching: ProgressEntry[]; completed: ProgressEntry[]; history: ProgressEntry[] }>(`/api/progress?userId=${userId()}`),
  titleProgress: (titleId: string) => j<{ entries: ProgressEntry[] }>(`/api/progress/title/${encodeURIComponent(titleId)}?userId=${userId()}`),
  saveProgress: (d: { ref: MediaRef; title: TitleSummary; episodeName?: string; position: number; duration: number; sourceId?: string }) =>
    fetch('/api/progress', { ...body('PUT', { ...d, userId: userId() }), keepalive: true }).catch(() => {}),
  removeProgress: (key: string) => j(`/api/progress/${encodeURIComponent(key)}?userId=${userId()}`, { method: 'DELETE' }),
  library: () => j<{ watchlist: TitleSummary[]; favorite: TitleSummary[] }>(`/api/library?userId=${userId()}`),
  addToLibrary: (list: 'watchlist' | 'favorite', title: TitleSummary) => j(`/api/library/${list}`, body('PUT', { userId: userId(), title })),
  removeFromLibrary: (list: 'watchlist' | 'favorite', id: string) => j(`/api/library/${list}/${encodeURIComponent(id)}?userId=${userId()}`, { method: 'DELETE' }),

  createRoom: (name: string) => j<{ roomId: string; key: string }>('/api/rooms', body('POST', { userId: userId(), name })),
  rooms: () => j<{ rooms: { id: string; name: string; updatedAt: number; online: number; media: { title: TitleSummary; episodeName?: string; ref: MediaRef } | null }[] }>(`/api/rooms?userId=${userId()}`),
  network: () => j<{ publicUrl: string | null; lan: string[] }>('/api/network'),

  providers: () => j<{ providers: (ProviderInfo & { config: Record<string, unknown> })[]; metadata: { id: string; name: string; attribution: string; tmdbConfigured: boolean } }>('/api/providers'),
  saveProvider: (id: string, config: Record<string, unknown>) => j<{ ok: boolean; provider: ProviderInfo }>(`/api/providers/${id}`, body('PUT', config)),
  saveTmdb: (key: string) => j('/api/settings/tmdb', body('PUT', { key })),
  checkHealth: () => j<{ providers: ProviderInfo[] }>('/api/providers/health', { method: 'POST' }),
  localLibrary: () => j<{ dir: string; exists: boolean; files: { id: string; rel: string; size: number; parsed: { kind: string; title: string; year?: number; season?: number; episode?: number; imdbId?: string }; subtitles: string[] }[] }>('/api/local/library'),
  rescan: () => j<{ count: number }>('/api/local/rescan', { method: 'POST' }),
  stats: () => j<{ playable: { titles: number; units: number }; byProvider: { provider: string; units: number }[]; cachedTitleRecords: number; localFiles: number }>('/api/stats'),
};

export const titleHref = (t: Pick<TitleSummary, 'type' | 'id'>) => `/title/${t.type}/${encodeURIComponent(t.id)}`;
export const watchHref = (ref: MediaRef, extra = '') =>
  `/watch/${ref.type}/${encodeURIComponent(ref.titleId)}${ref.type === 'series' ? `/${ref.season}/${ref.episode}` : ''}${extra}`;
