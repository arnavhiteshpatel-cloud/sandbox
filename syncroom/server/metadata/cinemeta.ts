// Cinemeta — the public, keyless metadata service used by Stremio clients (IMDb-keyed; posters/backdrops via metahub).
// Used as the default catalogue provider when no TMDB key is configured.
import type { CatalogSection, Episode, MediaType, Person, TitleDetail, TitleSummary } from '../../shared/types.ts';
import { cached, DAY, fetchJson, HOUR, mapLimit } from '../lib/http.ts';
import { isFuture, sortEpisodes, type BrowseQuery, type BrowseResult, type MetadataProvider } from './types.ts';

const BASE = 'https://v3-cinemeta.strem.io';
const PAGE = 50;

const MOVIE_GENRES = ['Action', 'Adventure', 'Animation', 'Biography', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Sport', 'Thriller', 'War', 'Western'];
const SERIES_GENRES = [...MOVIE_GENRES, 'Reality-TV', 'Talk-Show', 'Game-Show'];

interface CmVideo { id: string; season?: number; episode?: number; number?: number; name?: string; title?: string; overview?: string; description?: string; thumbnail?: string; released?: string; firstAired?: string; rating?: string | number }
interface CmMeta {
  id: string; imdb_id?: string; type: string; name: string; year?: string; releaseInfo?: string; released?: string;
  poster?: string; background?: string; logo?: string; imdbRating?: string; genres?: string[]; genre?: string[];
  description?: string; runtime?: string; country?: string; cast?: string[]; director?: string[] | null; writer?: string[] | null;
  trailers?: { source: string; type: string }[]; trailerStreams?: { title: string; ytId: string }[]; awards?: string; status?: string;
  videos?: CmVideo[];
}

const img = (u: string | undefined, size: 'small' | 'medium' | 'large') => u?.replace(/\/(small|medium|large)\//, `/${size}/`);

function parseYear(m: CmMeta): number | undefined {
  const y = parseInt(m.year ?? m.releaseInfo ?? '', 10);
  return Number.isFinite(y) ? y : undefined;
}

export function toSummary(m: CmMeta): TitleSummary {
  const type: MediaType = m.type === 'series' ? 'series' : 'movie';
  const year = parseYear(m);
  const rating = parseFloat(m.imdbRating ?? '');
  const upcoming = m.released ? isFuture(m.released) : year != null ? year > new Date().getFullYear() : false;
  return {
    id: m.imdb_id ?? m.id,
    imdbId: (m.imdb_id ?? m.id)?.startsWith('tt') ? (m.imdb_id ?? m.id) : undefined,
    type,
    name: m.name,
    year,
    releaseInfo: m.releaseInfo ?? m.year,
    releaseDate: m.released ?? undefined,
    poster: img(m.poster, 'medium'),
    background: img(m.background, 'medium'),
    logo: img(m.logo, 'medium'),
    rating: Number.isFinite(rating) ? rating : undefined,
    genres: m.genres ?? m.genre ?? [],
    description: m.description,
    runtime: m.runtime,
    country: m.country,
    upcoming: upcoming || undefined,
  };
}

const cmType = (t: MediaType) => (t === 'series' ? 'series' : 'movie');

async function catalog(type: MediaType, id: 'top' | 'year' | 'imdbRating', extra: Record<string, string | number> = {}): Promise<{ metas: CmMeta[] }> {
  const parts = Object.entries(extra).filter(([, v]) => v !== undefined && v !== '' && v !== 0).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  const url = `${BASE}/catalog/${cmType(type)}/${id}${parts.length ? '/' + parts.join('&') : ''}.json`;
  return cached(`cm:${url}`, 6 * HOUR, () => fetchJson<{ metas: CmMeta[] }>(url));
}

function dedupe(items: TitleSummary[]): TitleSummary[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

const usable = (t: TitleSummary) => !!t.poster && !!t.name;

export class CinemetaProvider implements MetadataProvider {
  id = 'cinemeta';
  name = 'Cinemeta (IMDb-keyed public catalogue)';
  attribution = 'Metadata from Cinemeta (Stremio) — IMDb-keyed. Images via metahub.';

  genres(type: MediaType) {
    return type === 'series' ? SERIES_GENRES : MOVIE_GENRES;
  }

  async browse(q: BrowseQuery): Promise<BrowseResult> {
    const skip = (q.page ?? 0) * PAGE;
    let metas: CmMeta[];
    if (q.year) {
      metas = (await catalog(q.type, 'year', { genre: q.year, skip })).metas;
      if (q.genre) metas = metas.filter((m) => (m.genres ?? m.genre ?? []).includes(q.genre!));
    } else {
      const id = q.sort === 'rating' ? 'imdbRating' : q.sort === 'new' ? 'year' : 'top';
      metas = (await catalog(q.type, id, id === 'year' ? { genre: new Date().getFullYear(), skip } : { genre: q.genre ?? '', skip })).metas;
      if (id === 'year' && q.genre) metas = metas.filter((m) => (m.genres ?? m.genre ?? []).includes(q.genre!));
    }
    return { items: dedupe(metas.map(toSummary).filter(usable)), hasMore: metas.length >= PAGE - 5 };
  }

  async home(): Promise<CatalogSection[]> {
    const yr = new Date().getFullYear();
    const pages = (type: MediaType, id: 'top' | 'year' | 'imdbRating', n: number, extra: Record<string, string | number> = {}) =>
      Promise.all(Array.from({ length: n }, (_, i) => catalog(type, id, { ...extra, skip: i * PAGE }).catch(() => ({ metas: [] as CmMeta[] })))).then((r) =>
        dedupe(r.flatMap((x) => x.metas).map(toSummary)),
      );

    const [topMovies, topSeries, newMovies, prevYear, nextYear, rated, ratedSeries, anim, docs, newSeries, horror, comedy] = await Promise.all([
      pages('movie', 'top', 6),
      pages('series', 'top', 3),
      pages('movie', 'year', 3, { genre: yr }),
      pages('movie', 'year', 1, { genre: yr - 1 }),
      pages('movie', 'year', 1, { genre: yr + 1 }),
      pages('movie', 'imdbRating', 1),
      pages('series', 'imdbRating', 1),
      pages('movie', 'top', 1, { genre: 'Animation' }),
      pages('movie', 'top', 1, { genre: 'Documentary' }),
      pages('series', 'year', 1, { genre: yr }),
      pages('movie', 'top', 1, { genre: 'Horror' }),
      pages('movie', 'top', 1, { genre: 'Comedy' }),
    ]);

    const released = (t: TitleSummary) => !t.upcoming;
    const byDateDesc = (a: TitleSummary, b: TitleSummary) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '');
    const pool = dedupe([...topMovies, ...newMovies, ...prevYear, ...rated]);
    const primary = (c?: string) => c?.split(',')[0].trim() ?? '';
    const international = pool.filter((t) => t.country && !/United States|United Kingdom|Canada|Australia/.test(primary(t.country)) && released(t));
    const indian = pool.filter((t) => primary(t.country) === 'India');

    const sections: CatalogSection[] = [
      { id: 'trending-movies', title: 'Trending Movies', items: topMovies.filter(usable).filter(released).slice(0, 30), href: '/browse/movie?sort=popular' },
      { id: 'popular-series', title: 'Popular Series', items: topSeries.filter(usable).slice(0, 30), href: '/browse/series?sort=popular' },
      { id: 'new-releases', title: 'New Releases', subtitle: `Released in ${yr}`, items: newMovies.filter(usable).filter(released).sort(byDateDesc).slice(0, 30), href: '/browse/movie?sort=new' },
      { id: 'new-series', title: 'New Seasons & Series', items: newSeries.filter(usable).slice(0, 30), href: `/browse/series?year=${yr}` },
      { id: 'top-rated', title: 'Critically Acclaimed', items: rated.filter(usable).slice(0, 30), href: '/browse/movie?sort=rating' },
      { id: 'international', title: 'World Cinema', subtitle: 'Beyond Hollywood', items: international.filter(usable).slice(0, 30) },
      ...(indian.length >= 4 ? [{ id: 'indian', title: 'Indian Cinema', items: indian.filter(usable).slice(0, 30) }] : []),
      { id: 'animation', title: 'Animation', items: anim.filter(usable).filter(released).slice(0, 30), href: '/browse/movie?genre=Animation' },
      { id: 'documentary', title: 'Documentaries', items: docs.filter(usable).filter(released).slice(0, 30), href: '/browse/movie?genre=Documentary' },
      { id: 'top-series', title: 'Acclaimed Series', items: ratedSeries.filter(usable).slice(0, 30), href: '/browse/series?sort=rating' },
      { id: 'horror', title: 'Horror Nights', items: horror.filter(usable).filter(released).slice(0, 30), href: '/browse/movie?genre=Horror' },
      { id: 'comedy', title: 'Comedy', items: comedy.filter(usable).filter(released).slice(0, 30), href: '/browse/movie?genre=Comedy' },
      {
        id: 'coming-soon', title: 'Coming Soon', subtitle: 'Not yet released — catalogue only',
        items: dedupe([...newMovies, ...nextYear, ...topMovies]).filter((t) => t.upcoming && usable(t)).sort((a, b) => (a.releaseDate ?? '9').localeCompare(b.releaseDate ?? '9')).slice(0, 30),
      },
    ];
    return sections.filter((s) => s.items.length > 0);
  }

  async search(query: string, type?: MediaType): Promise<TitleSummary[]> {
    const q = query.trim();
    if (!q) return [];
    const types: MediaType[] = type ? [type] : ['movie', 'series'];
    const results = await Promise.all(
      types.map((t) => {
        const url = `${BASE}/catalog/${cmType(t)}/top/search=${encodeURIComponent(q)}.json`;
        return cached(`cm:${url}`, DAY, () => fetchJson<{ metas: CmMeta[] }>(url)).then((r) => r.metas.map(toSummary)).catch(() => [] as TitleSummary[]);
      }),
    );
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const nq = norm(q);
    // Interleave and rank: exact title matches first, then providers' relevance order.
    const scored = results.flatMap((list) =>
      list.map((t, idx) => {
        const n = norm(t.name);
        const exact = n === nq ? 0 : n.startsWith(nq) ? 1 : 2;
        return { t, s: exact * 1000 + idx * 2 + (t.poster ? 0 : 500) };
      }),
    );
    return dedupe(scored.sort((a, b) => a.s - b.s).map((x) => x.t));
  }

  async detail(type: MediaType, id: string): Promise<TitleDetail | null> {
    const url = `${BASE}/meta/${cmType(type)}/${encodeURIComponent(id)}.json`;
    const res = await cached(`cm:${url}`, 3 * DAY, () => fetchJson<{ meta: CmMeta | null }>(url));
    const m = res.meta;
    if (!m || !m.name) return null;
    const s = toSummary(m);
    const people: Person[] = [
      ...(m.director ?? []).map((name) => ({ name, role: 'director' as const })),
      ...(m.cast ?? []).map((name) => ({ name, role: 'cast' as const })),
      ...(m.writer ?? []).map((name) => ({ name, role: 'writer' as const })),
    ];
    const trailers = m.trailerStreams?.length
      ? m.trailerStreams.map((t) => ({ ytId: t.ytId, name: t.title }))
      : (m.trailers ?? []).filter((t) => t.type === 'Trailer').map((t) => ({ ytId: t.source, name: 'Trailer' }));
    let episodes: Episode[] | undefined;
    let seasons: number[] | undefined;
    if (s.type === 'series') {
      episodes = sortEpisodes(
        (m.videos ?? [])
          .filter((v) => v.season != null && (v.episode ?? v.number) != null)
          .map((v) => {
            const released = v.released ?? v.firstAired;
            const rating = parseFloat(String(v.rating ?? ''));
            return {
              id: `${s.id}:${v.season}:${v.episode ?? v.number}`,
              season: v.season!,
              episode: (v.episode ?? v.number)!,
              name: v.name || v.title || `Episode ${v.episode ?? v.number}`,
              overview: v.overview || v.description || undefined,
              thumbnail: v.thumbnail,
              released,
              rating: Number.isFinite(rating) ? rating : undefined,
              upcoming: isFuture(released) || undefined,
            };
          }),
      );
      // de-duplicate (some feeds repeat an episode)
      const seen = new Set<string>();
      episodes = episodes.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
      seasons = [...new Set(episodes.map((e) => e.season))].sort((a, b) => (a === 0 ? 1e6 : a) - (b === 0 ? 1e6 : b));
    }
    return {
      ...s,
      poster: img(m.poster, 'medium'),
      background: img(m.background, 'large') ?? s.background,
      people,
      trailers: trailers.filter((t) => !!t.ytId),
      awards: m.awards,
      status: m.status,
      seasons,
      episodes,
      metadataProvider: this.id,
      fetchedAt: Date.now(),
    };
  }

  async recommendations(d: TitleDetail): Promise<TitleSummary[]> {
    const genres = (d.genres ?? []).slice(0, 3);
    if (!genres.length) return [];
    const lists = await mapLimit(genres, 3, (g) => catalog(d.type, 'top', { genre: g }).then((r) => r.metas.map(toSummary)).catch(() => []));
    const all = dedupe(lists.flat()).filter((t) => t.id !== d.id && usable(t) && !t.upcoming);
    const set = new Set(d.genres);
    const score = (t: TitleSummary) =>
      (t.genres ?? []).filter((g) => set.has(g)).length * 10 + (t.rating ?? 5) - (d.year && t.year ? Math.min(Math.abs(d.year - t.year), 30) / 6 : 0);
    return all.sort((a, b) => score(b) - score(a)).slice(0, 18);
  }
}
