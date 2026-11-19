// Internet Archive — public-domain / openly licensed films and TV episodes, served as direct MP4 with byte ranges.
// Only curated collections are used. Community "open source movies" uploads are excluded because their
// licensing is unverified. Movies match by explicit IMDb id (exact) or strict title + year.
import type { Episode, PlaybackSource, QualityOption, SubtitleTrack } from '../../shared/types.ts';
import { cached, DAY, fetchJson, mapLimit } from '../lib/http.ts';
import { caps, langName, stableId, subtitleProxyUrl, type ProviderSearchHit, type ResolveContext, type SourceProvider } from './types.ts';
import { verifyMediaUrl } from './verify.ts';

const SEARCH = 'https://archive.org/advancedsearch.php';
const SCRAPE = 'https://archive.org/services/search/v1/scrape';

const MOVIE_COLLECTIONS = ['feature_films', 'silent_films'];
const EXCLUDED_COLLECTIONS = new Set(['feature_films_unsorted', 'opensource_movies', 'opensource', 'community']);

/**
 * Series with documented public-domain episodes (copyright not renewed / lapsed). Only these are matched
 * against the Internet Archive "classic_tv" collection; most other shows there are still under copyright.
 */
export const PD_SERIES: { name: string; year: number; note: string; includes: (season: number, episode: number) => boolean }[] = [
  // Only series whose public-domain scope is documented precisely enough to apply per episode.
  { name: 'Sherlock Holmes', year: 1954, note: 'all 39 episodes of the 1954 series are in the public domain', includes: () => true },
  { name: 'Flash Gordon', year: 1954, note: 'the 1954–55 series is in the public domain', includes: () => true },
  { name: 'The Beverly Hillbillies', year: 1962, note: 'the first 55 episodes (S1 + S2 E1–19) are in the public domain', includes: (s, e) => s === 1 || (s === 2 && e <= 19) },
];

interface IaDoc { identifier: string; title?: string; year?: string | number; date?: string; collection?: string | string[]; downloads?: number; 'external-identifier'?: string | string[] }
interface IaFile { name: string; format?: string; size?: string; length?: string; height?: string; width?: string; source?: string; original?: string }
interface IaMeta { is_dark?: boolean; metadata?: { title?: string; year?: string; date?: string; licenseurl?: string; collection?: string | string[]; runtime?: string }; files?: IaFile[] }

const VIDEO_FORMATS = ['h.264', 'h.264 IA', 'h.264 HD', 'MPEG4', '512Kb MPEG4', 'HiRes MPEG4', 'MPEG-4', 'Matroska', 'WebM'];
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
const arr = <T,>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const dl = (id: string, file: string) => `https://archive.org/download/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`;

function lengthSec(l?: string) {
  if (!l) return undefined;
  if (l.includes(':')) return l.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  const n = Number(l);
  return Number.isFinite(n) ? n : undefined;
}

function itemYear(d: IaDoc): number | undefined {
  const y = Number(d.year ?? d.date?.slice(0, 4));
  if (Number.isFinite(y) && y > 1880) return y;
  const m = (d.title ?? d.identifier).match(/(18|19|20)\d{2}/);
  return m ? Number(m[0]) : undefined;
}

async function iaMeta(id: string) {
  return cached(`ia:meta:${id}`, 3 * DAY, () => fetchJson<IaMeta>(`https://archive.org/metadata/${encodeURIComponent(id)}`, { timeoutMs: 20000 }));
}

async function iaSearch(q: string, rows = 50, fields = ['identifier', 'title', 'year', 'date', 'collection', 'downloads']) {
  const params = new URLSearchParams({ q, rows: String(rows), output: 'json' });
  fields.forEach((f) => params.append('fl[]', f));
  params.append('sort[]', 'downloads desc');
  const url = `${SEARCH}?${params}`;
  return cached(`ia:search:${url}`, DAY, () => fetchJson<{ response: { docs: IaDoc[]; numFound: number } }>(url, { timeoutMs: 25000 })).then((r) => r.response.docs);
}

const curated = (d: { collection?: string | string[] }) => {
  const cols = arr(d.collection);
  return !cols.some((c) => EXCLUDED_COLLECTIONS.has(c));
};

/** Pick playable renditions from an item: best h.264 MP4 per original, plus lighter renditions as quality options. */
export function pickRenditions(meta: IaMeta, id: string) {
  const files = (meta.files ?? []).filter((f) => VIDEO_FORMATS.includes(f.format ?? '') && /\.(mp4|m4v|webm|mkv)$/i.test(f.name));
  // group by the original file they derive from
  const groups = new Map<string, IaFile[]>();
  for (const f of files) {
    const key = f.source === 'derivative' && f.original ? f.original : f.name;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const out: { key: string; files: IaFile[]; duration?: number }[] = [];
  for (const [key, group] of groups) {
    // Prefer .mp4 (universally playable); order by height desc, then size desc
    const playable = group
      .filter((f) => /\.(mp4|m4v)$/i.test(f.name) || /\.webm$/i.test(f.name))
      .sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0) || Number(b.size ?? 0) - Number(a.size ?? 0));
    if (!playable.length) continue;
    const duration = playable.map((f) => lengthSec(f.length)).find((x) => x && x > 0) ?? lengthSec((meta.files ?? []).find((f) => f.name === key)?.length);
    out.push({ key, files: playable, duration });
  }

  return out;
}

function subtitlesFor(meta: IaMeta, id: string, videoKey: string, origin: string): SubtitleTrack[] {
  const base = videoKey.replace(/\.[^.]+$/, '').toLowerCase();
  return (meta.files ?? [])
    .filter((f) => /\.(srt|vtt)$/i.test(f.name) && !/\.asr\.(srt|vtt)$/i.test(f.name)) // .asr = low quality auto speech recognition
    .filter((f, _, all) => all.length <= 3 || f.name.toLowerCase().startsWith(base.slice(0, Math.max(4, base.length - 4))))
    .map((f) => {
      const m = f.name.match(/[._-]([a-z]{2,3})\.(srt|vtt)$/i);
      const lang = m && langName(m[1]) !== m[1].toUpperCase() ? m[1].toLowerCase() : 'en';
      return { id: stableId('ia-sub', id, f.name), label: `${langName(lang)}${m ? '' : ''}`, lang, url: subtitleProxyUrl(origin, dl(id, f.name)), origin: 'Internet Archive' };
    });
}

function toSource(id: string, meta: IaMeta, r: { key: string; files: IaFile[]; duration?: number }, match: PlaybackSource['match'], origin: string, label?: string): PlaybackSource {
  const main = r.files[0];
  const qualities: QualityOption[] = r.files.map((f) => ({
    id: f.name,
    label: f.height ? `${f.height}p` : f.format === '512Kb MPEG4' ? 'Low (512 kb/s)' : f.format ?? 'Original',
    height: f.height ? Number(f.height) : undefined,
    url: dl(id, f.name),
  }));
  const lic = meta.metadata?.licenseurl;
  return {
    id: `archive:${stableId(id, r.key)}`,
    providerId: 'archive',
    providerName: 'Internet Archive',
    label: label ?? (main.height ? `Internet Archive · ${main.height}p` : 'Internet Archive'),
    kind: 'file',
    url: dl(id, main.name),
    mimeType: /\.webm$/i.test(main.name) ? 'video/webm' : 'video/mp4',
    qualities: qualities.length > 1 ? qualities : [],
    subtitles: subtitlesFor(meta, id, r.key, origin),
    capabilities: caps('file', { qualitySelection: qualities.length > 1 }),
    verify: { status: 'unverified', checkedAt: 0 },
    match,
    adFree: true,
    license: lic ? lic : 'Public domain (Internet Archive curated collection)',
    attribution: `archive.org/details/${id}`,
    sizeBytes: main.size ? Number(main.size) : undefined,
    durationSec: r.duration,
  };
}

export class ArchiveProvider implements SourceProvider {
  id = 'archive';
  name = 'Internet Archive';
  description = 'Public-domain feature films, silent classics and public-domain TV episodes from curated archive.org collections. Direct MP4, ad-free, fully syncable.';
  kinds = ['file' as const];
  requiresConfig = false;
  configFields = [];
  isConfigured() { return true; }

  async healthCheck() {
    await fetchJson(`${SEARCH}?q=identifier%3Anight_of_the_living_dead&fl%5B%5D=identifier&rows=1&output=json`, { timeoutMs: 10000 });
  }

  async search(query: string): Promise<ProviderSearchHit[]> {
    const docs = await iaSearch(`title:(${query.replace(/[^\w\s]/g, ' ')}) AND mediatype:movies AND collection:(${MOVIE_COLLECTIONS.join(' OR ')})`, 40);
    return docs.filter(curated).map((d) => ({ providerItemId: d.identifier, title: d.title ?? d.identifier, year: itemYear(d), type: 'movie' as const }));
  }

  async resolveTitle(ctx: ResolveContext): Promise<ProviderSearchHit[]> {
    const hits: (ProviderSearchHit & { match: PlaybackSource['match'] })[] = [];
    if (ctx.imdbId) {
      const url = `${SCRAPE}?q=${encodeURIComponent(`external-identifier:"urn:imdb:${ctx.imdbId}" AND mediatype:movies`)}&fields=identifier,title,collection,year&count=100`;
      const r = await cached(`ia:imdb:${ctx.imdbId}`, DAY, () => fetchJson<{ items: IaDoc[] }>(url, { timeoutMs: 25000 }));
      for (const d of r.items.filter(curated)) hits.push({ providerItemId: d.identifier, title: d.title ?? d.identifier, year: itemYear(d), imdbId: ctx.imdbId, type: 'movie', match: 'exact-id' });
    }
    if (!hits.length && ctx.year && ctx.type === 'movie') {
      const words = ctx.title.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
      if (words) {
        const docs = await iaSearch(`title:("${words}") AND mediatype:movies AND collection:(${MOVIE_COLLECTIONS.join(' OR ')})`, 30);
        const want = norm(ctx.title);
        for (const d of docs.filter(curated)) {
          const t = norm((d.title ?? '').replace(/[-–(]?\s*(18|19|20)\d{2}\s*\)?\s*$/, ''));
          const y = itemYear(d);
          if (/\b(trailer|preview|ipod|double feature|teaser|clip|excerpt)\b/i.test(`${d.title} ${d.identifier}`)) continue;
          if (t !== want) continue;
          if (y == null || Math.abs(y - ctx.year) > 1) continue;
          hits.push({ providerItemId: d.identifier, title: d.title ?? d.identifier, year: y, type: 'movie', match: 'title-year' });
        }
      }
    }
    return hits.slice(0, 4);
  }

  async getAvailableSources(ctx: ResolveContext): Promise<PlaybackSource[]> {
    if (ctx.type === 'series') return this.episodeSources(ctx);
    const hits = (await this.resolveTitle(ctx)) as (ProviderSearchHit & { match: PlaybackSource['match'] })[];
    let failures = 0;
    const sources = await mapLimit(hits, 4, async (h) => {
      const meta = await iaMeta(h.providerItemId).catch(() => { failures++; return null; });
      if (!meta || meta.is_dark || !meta.files) return [];
      const all = pickRenditions(meta, h.providerItemId);
      // Keep full-length renditions only. Items with several full-length files are alternative encodes;
      // short files (trailers, DVD chunks, reels) are dropped. Unknown durations are kept only if alone.
      const longest = Math.max(0, ...all.map((r) => r.duration ?? 0));
      const minLen = Math.max(20 * 60, longest * 0.6);
      const renditions = all.filter((r) => (r.duration == null ? all.length === 1 : r.duration >= minLen));
      if (renditions.length === 0 || renditions.length > 4) return [];
      return renditions.map((r) => toSource(h.providerItemId, meta, r, h.match, ctx.origin));
    });
    // A transient archive.org failure must not look like "no sources" (it would be cached).
    if (failures && failures === hits.length) throw new Error('archive.org metadata unavailable, try again shortly');
    // de-duplicate identical files and keep the best few
    const seen = new Set<string>();
    return sources.flat().filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true))).slice(0, 6);
  }

  private async episodeSources(ctx: ResolveContext): Promise<PlaybackSource[]> {
    const series = PD_SERIES.find((s) => norm(s.name) === norm(ctx.title) && (!ctx.year || Math.abs(ctx.year - s.year) <= 1));
    if (!series || ctx.season == null || ctx.episode == null) return [];
    if (!series.includes(ctx.season, ctx.episode)) return [];
    const index = await this.seriesIndex(series.name, ctx);
    const key = `${ctx.season}:${ctx.episode}`;
    return (index[key] ?? []).map((s) => ({ ...s, subtitles: s.subtitles.map((t) => ({ ...t })), license: `Public domain episode — ${series.note}` }));
  }

  /** Build (and cache) a map "season:episode" → sources for an allowlisted PD series. */
  private async seriesIndex(name: string, ctx: ResolveContext): Promise<Record<string, PlaybackSource[]>> {
    return cached(`ia:series:${norm(name)}:${ctx.ref.titleId}:v2`, 3 * DAY, async () => {
      const { metadata } = await import('../metadata/index.ts');
      const detail = await metadata().detail('series', ctx.ref.titleId).catch(() => null);
      const episodes = (detail?.episodes ?? []).filter((e) => e.season > 0 && norm(e.name).length >= 4 && !/^episode \d+$/.test(norm(e.name)));
      const docs = (await iaSearch(`collection:classic_tv AND title:(${name.replace(/[^\w\s]/g, ' ')})`, 150)).filter(curated);
      const wantWords = norm(name).split(' ').filter((w) => w.length > 2);
      const relevant = docs.filter((d) => { const t = norm(`${d.title} ${d.identifier}`); return wantWords.every((w) => t.includes(w)); }).slice(0, 80);
      const index: Record<string, PlaybackSource[]> = {};
      await mapLimit(relevant, 6, async (d) => {
        const meta = await iaMeta(d.identifier).catch(() => null);
        if (!meta || meta.is_dark) return;
        for (const r of pickRenditions(meta, d.identifier)) {
          if (r.duration != null && r.duration < 10 * 60) continue;
          const label = norm(`${relevant.length && pickRenditions(meta, d.identifier).length === 1 ? d.title ?? '' : ''} ${r.key.replace(/\.[^.]+$/, '').replace(/_/g, ' ')}`);
          let ep: Episode | undefined = episodes.filter((e) => label.includes(norm(e.name)) && norm(e.name).split(' ').length >= 2).sort((a, b) => norm(b.name).length - norm(a.name).length)[0];
          if (!ep) {
            const se = label.match(/\bs(\d{1,2}) ?e(\d{1,3})\b/);
            if (se) ep = episodes.find((e) => e.season === Number(se[1]) && e.episode === Number(se[2]));
          }
          if (!ep) continue;
          const k = `${ep.season}:${ep.episode}`;
          const src = toSource(d.identifier, meta, r, 'episode-title', ctx.origin, `Internet Archive · ${ep.name}`);
          if (!(index[k] ?? []).some((x) => x.id === src.id)) index[k] = [...(index[k] ?? []), src];
        }
      });
      return index;
    });
  }

  /** Which episodes of a PD series have sources (for the episode list availability badges). */
  async availableEpisodes(ctx: ResolveContext): Promise<string[]> {
    const series = PD_SERIES.find((s) => norm(s.name) === norm(ctx.title) && (!ctx.year || Math.abs(ctx.year - s.year) <= 1));
    if (!series) return [];
    return Object.keys(await this.seriesIndex(series.name, ctx)).filter((k) => { const [se, ep] = k.split(':').map(Number); return series.includes(se, ep); });
  }

  async verify(source: PlaybackSource) {
    return verifyMediaUrl(source.url, 'file');
  }
}


