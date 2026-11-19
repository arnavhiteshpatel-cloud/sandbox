// OpenSubtitles.com REST API — optional subtitle provider for any source. Requires a (free) API key.
import type { SubtitleTrack } from '../../shared/types.ts';
import { getSetting } from '../db.ts';
import { cached, DAY, fetchJson } from '../lib/http.ts';
import { sign } from '../lib/sign.ts';
import { langName, type ResolveContext } from './types.ts';

const API = 'https://api.opensubtitles.com/api/v1';
const UA = 'SyncRoom v0.1';

export const openSubtitlesConfigFields = [
  { key: 'apiKey', label: 'API key', secret: true, help: 'opensubtitles.com → Consumers → create a free API consumer' },
  { key: 'languages', label: 'Languages', placeholder: 'en,es,hi', help: 'Comma-separated ISO 639-1 codes' },
];

export function openSubtitlesConfig() {
  return getSetting<{ apiKey?: string; languages?: string; enabled?: boolean }>('provider.opensubtitles', {});
}

export async function openSubtitlesSearch(ctx: ResolveContext): Promise<SubtitleTrack[]> {
  const cfg = openSubtitlesConfig();
  if (!cfg.apiKey || !ctx.imdbId || cfg.enabled === false) return [];
  const params = new URLSearchParams({ languages: cfg.languages || 'en', order_by: 'download_count' });
  if (ctx.type === 'series') {
    params.set('parent_imdb_id', ctx.imdbId.replace(/^tt/, ''));
    params.set('season_number', String(ctx.season));
    params.set('episode_number', String(ctx.episode));
  } else params.set('imdb_id', ctx.imdbId.replace(/^tt/, ''));
  const r = await cached(`os:${params}`, DAY, () =>
    fetchJson<{ data: { id: string; attributes: { language: string; release: string; files: { file_id: number }[] } }[] }>(`${API}/subtitles?${params}`, { headers: { 'Api-Key': cfg.apiKey!, 'User-Agent': UA } }),
  );
  const perLang = new Map<string, number>();
  return r.data
    .filter((d) => d.attributes.files[0])
    .filter((d) => { const n = perLang.get(d.attributes.language) ?? 0; perLang.set(d.attributes.language, n + 1); return n < 3; })
    .map((d) => {
      const fid = String(d.attributes.files[0].file_id);
      return { id: `os-${fid}`, label: `${langName(d.attributes.language)} · ${d.attributes.release.slice(0, 40)}`, lang: d.attributes.language, url: `${ctx.origin}/api/subtitles/opensubtitles/${fid}?sig=${sign(fid)}`, origin: 'OpenSubtitles' };
    });
}

export async function openSubtitlesDownload(fileId: string): Promise<string> {
  const cfg = openSubtitlesConfig();
  if (!cfg.apiKey) throw new Error('OpenSubtitles not configured');
  const r = await fetchJson<{ link: string }>(`${API}/download`, { method: 'POST', headers: { 'Api-Key': cfg.apiKey, 'User-Agent': UA, 'Content-Type': 'application/json' }, body: JSON.stringify({ file_id: Number(fileId), sub_format: 'webvtt' }) });
  const res = await fetch(r.link);
  if (!res.ok) throw new Error(`download ${res.status}`);
  return res.text();
}
