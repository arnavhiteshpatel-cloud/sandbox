import { Router } from 'express';
import type { MediaRef, MediaType, TitleSummary } from '../../shared/types.ts';
import { db } from '../db.ts';
import { metadata, withFallback } from '../metadata/index.ts';
import { localLibrary } from '../sources/localLibrary.ts';
import { archive, getSources, reportPlayback } from '../sources/registry.ts';
import type { ResolveContext } from '../sources/types.ts';

export const catalog = Router();

const asType = (t: unknown): MediaType => (t === 'series' || t === 'tv' ? 'series' : 'movie');
const wrap = (fn: (req: any, res: any) => Promise<unknown>) => (req: any, res: any) =>
  fn(req, res).catch((e: Error) => {
    console.error('[api]', req.method, req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ error: e.message });
  });

catalog.get('/catalog/home', wrap(async (_req, res) => {
  const sections = await withFallback((p) => p.home());
  res.json({ sections, provider: metadata().id, attribution: metadata().attribution });
}));

catalog.get('/catalog/genres', wrap(async (req, res) => {
  res.json({ genres: metadata().genres(asType(req.query.type)) });
}));

catalog.get('/catalog/browse', wrap(async (req, res) => {
  const q = { type: asType(req.query.type), genre: (req.query.genre as string) || undefined, year: Number(req.query.year) || undefined, sort: (req.query.sort as 'popular' | 'new' | 'rating') || 'popular', page: Number(req.query.page) || 0 };
  res.json(await withFallback((p) => p.browse(q)));
}));

catalog.get('/catalog/search', wrap(async (req, res) => {
  const query = String(req.query.q ?? '').slice(0, 100);
  const type = req.query.type ? asType(req.query.type) : undefined;
  let items = await withFallback((p) => p.search(query, type));
  const genre = req.query.genre as string | undefined;
  const yFrom = Number(req.query.yearFrom) || 0;
  const yTo = Number(req.query.yearTo) || 9999;
  if (genre) items = items.filter((t) => t.genres?.includes(genre));
  if (yFrom || yTo < 9999) items = items.filter((t) => t.year != null && t.year >= yFrom && t.year <= yTo);
  if (req.query.minRating) items = items.filter((t) => (t.rating ?? 0) >= Number(req.query.minRating));
  if (req.query.playable === '1') {
    const ids = new Set((db.prepare('SELECT DISTINCT title_id FROM playable_index').all() as { title_id: string }[]).map((r) => r.title_id));
    items = items.filter((t) => ids.has(t.id));
  }
  res.json({ items: annotatePlayable(items) });
}));

catalog.get('/catalog/suggest', wrap(async (req, res) => {
  const query = String(req.query.q ?? '').slice(0, 100);
  if (query.trim().length < 2) return res.json({ items: [] });
  const items = await withFallback((p) => p.search(query));
  res.json({ items: annotatePlayable(items.slice(0, 8)) });
}));

catalog.get('/title/:type/:id', wrap(async (req, res) => {
  const d = await withFallback((p) => p.detail(asType(req.params.type), req.params.id));
  if (!d) return res.status(404).json({ error: 'Title not found' });
  res.json(d);
}));

catalog.get('/title/:type/:id/recommendations', wrap(async (req, res) => {
  const p = metadata();
  const d = await p.detail(asType(req.params.type), req.params.id);
  res.json({ items: d ? annotatePlayable(await p.recommendations(d)) : [] });
}));

export async function contextFor(type: MediaType, id: string, season?: number, episode?: number): Promise<{ ctx: ResolveContext; title: TitleSummary } | null> {
  const d = await withFallback((p) => p.detail(type, id));
  if (!d) return null;
  const ep = type === 'series' ? d.episodes?.find((e) => e.season === season && e.episode === episode) : undefined;
  const ref: MediaRef = type === 'series' ? { titleId: d.id, type, season, episode } : { titleId: d.id, type };
  const { people, trailers, episodes, seasons, ...title } = d;
  void people; void trailers; void episodes; void seasons;
  return {
    ctx: { ref, type, imdbId: d.imdbId ?? (d.id.startsWith('tt') ? d.id : undefined), title: d.name, year: d.year, season, episode, episodeName: ep?.name, origin: '' },
    title: title as TitleSummary,
  };
}

catalog.get('/sources/:type/:id', wrap(async (req, res) => {
  const type = asType(req.params.type);
  const season = req.query.season != null ? Number(req.query.season) : undefined;
  const episode = req.query.episode != null ? Number(req.query.episode) : undefined;
  if (type === 'series' && (season == null || episode == null)) return res.status(400).json({ error: 'season and episode are required for series' });
  const c = await contextFor(type, req.params.id, season, episode);
  if (!c) return res.status(404).json({ error: 'Title not found' });
  res.json(await getSources(c.ctx, c.title));
}));

/** Which episodes of a series have (or are likely to have) sources, without verifying each one. */
catalog.get('/sources/series/:id/episodes', wrap(async (req, res) => {
  const c = await contextFor('series', req.params.id, 1, 1);
  if (!c) return res.status(404).json({ error: 'Title not found' });
  const keys = new Set<string>();
  for (const r of db.prepare("SELECT media_key FROM playable_index WHERE title_id = ?").all(c.ctx.ref.titleId) as { media_key: string }[]) keys.add(r.media_key.split(':').slice(1).join(':'));
  for (const r of db.prepare("SELECT media_key FROM user_sources WHERE title_id = ?").all(c.ctx.ref.titleId) as { media_key: string }[]) keys.add(r.media_key.split(':').slice(1).join(':'));
  for (const f of localLibrary.scan()) {
    if (f.parsed.kind === 'episode' && localLibrary.matches(f, { ...c.ctx, season: f.parsed.season, episode: f.parsed.episode, ref: { ...c.ctx.ref, season: f.parsed.season, episode: f.parsed.episode } })) keys.add(`${f.parsed.season}:${f.parsed.episode}`);
  }
  try { (await archive.availableEpisodes(c.ctx)).forEach((k) => keys.add(k)); } catch { /* best effort */ }
  res.json({ episodes: [...keys], note: 'Episodes listed here have a known source; each is verified when opened.' });
}));

catalog.post('/sources/report', (req, res) => {
  const { sourceId, providerId, ok, detail } = req.body ?? {};
  if (typeof sourceId !== 'string' || typeof providerId !== 'string') return res.status(400).end();
  reportPlayback(sourceId, providerId, !!ok, typeof detail === 'string' ? detail : undefined);
  res.json({ ok: true });
});

/** Titles with at least one verified playable source. */
catalog.get('/free', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 60);
  const offset = Number(req.query.offset) || 0;
  const provider = req.query.provider as string | undefined;
  const rows = db.prepare(`SELECT title_id, MAX(title_json) AS title_json, MAX(verified_at) AS v, GROUP_CONCAT(DISTINCT provider) AS providers, COUNT(DISTINCT media_key) AS units
    FROM playable_index WHERE title_json IS NOT NULL ${provider ? 'AND provider = ?' : ''} GROUP BY title_id ORDER BY v DESC LIMIT ? OFFSET ?`)
    .all(...(provider ? [provider, limit, offset] : [limit, offset])) as { title_id: string; title_json: string; providers: string; units: number }[];
  const totals = db.prepare('SELECT COUNT(DISTINCT title_id) AS titles, COUNT(DISTINCT media_key) AS units FROM playable_index').get() as { titles: number; units: number };
  res.json({ items: rows.map((r) => ({ ...(JSON.parse(r.title_json) as TitleSummary), playable: true, providers: r.providers.split(','), units: r.units })), totals });
});

export function annotatePlayable<T extends TitleSummary>(items: T[]): (T & { playable?: boolean })[] {
  if (!items.length) return items;
  const ids = items.map((i) => i.id);
  const rows = db.prepare(`SELECT DISTINCT title_id FROM playable_index WHERE title_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { title_id: string }[];
  const set = new Set(rows.map((r) => r.title_id));
  for (const f of localLibrary.scan()) if (f.parsed.imdbId) set.add(f.parsed.imdbId);
  return items.map((i) => (set.has(i.id) ? { ...i, playable: true } : i));
}

