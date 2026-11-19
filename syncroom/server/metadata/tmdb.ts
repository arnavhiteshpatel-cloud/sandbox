// TMDB provider — used automatically when a TMDB API key (v3 key or v4 read token) is configured.
// "This product uses the TMDB API but is not endorsed or certified by TMDB."
import type { CatalogSection, Episode, MediaType, Person, TitleDetail, TitleSummary } from '../../shared/types.ts';
import { cached, DAY, fetchJson, HOUR, mapLimit } from '../lib/http.ts';
import { isFuture, sortEpisodes, type BrowseQuery, type BrowseResult, type MetadataProvider } from './types.ts';

const API = process.env.TMDB_API_BASE ?? 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

interface TmItem {
  id: number; media_type?: string; title?: string; name?: string; release_date?: string; first_air_date?: string;
  poster_path?: string | null; backdrop_path?: string | null; vote_average?: number; genre_ids?: number[];
  genres?: { id: number; name: string }[]; overview?: string; runtime?: number; episode_run_time?: number[];
  origin_country?: string[]; production_countries?: { name: string }[]; imdb_id?: string; external_ids?: { imdb_id?: string };
  status?: string; seasons?: { season_number: number; episode_count: number }[];
  credits?: { cast: { name: string; character?: string; profile_path?: string | null }[]; crew: { name: string; job: string; profile_path?: string | null }[] };
  created_by?: { name: string; profile_path?: string | null }[];
  videos?: { results: { key: string; site: string; type: string; name: string; official?: boolean }[] };
  images?: { logos?: { file_path: string; iso_639_1: string | null }[] };
}

const tmType = (t: MediaType) => (t === 'series' ? 'tv' : 'movie');

export class TmdbProvider implements MetadataProvider {
  id = 'tmdb';
  name = 'TMDB';
  attribution = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';
  private genreMap: Record<string, Record<number, string>> = {};

  constructor(private key: string) {}

  private async get<T>(path: string, params: Record<string, string | number | undefined> = {}, ttl = 6 * HOUR): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const isV4 = this.key.length > 40; // v4 read access tokens are JWTs
    if (!isV4) qs.set('api_key', this.key);
    const url = `${API}${path}?${qs}`;
    return cached(`tmdb:${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][])}`, ttl, () =>
      fetchJson<T>(url, { headers: isV4 ? { authorization: `Bearer ${this.key}` } : {} }),
    );
  }

  private async genresFor(type: MediaType) {
    if (!this.genreMap[type]) {
      const r = await this.get<{ genres: { id: number; name: string }[] }>(`/genre/${tmType(type)}/list`, {}, 7 * DAY);
      this.genreMap[type] = Object.fromEntries(r.genres.map((g) => [g.id, g.name]));
    }
    return this.genreMap[type];
  }

  genres(type: MediaType) {
    return Object.values(this.genreMap[type] ?? {});
  }

  private summary(i: TmItem, type: MediaType, genres: Record<number, string> = {}): TitleSummary {
    const date = i.release_date || i.first_air_date || undefined;
    const year = date ? parseInt(date.slice(0, 4), 10) : undefined;
    const imdb = i.imdb_id ?? i.external_ids?.imdb_id ?? undefined;
    return {
      id: `tmdb-${type}-${i.id}`,
      imdbId: imdb || undefined,
      type,
      name: i.title ?? i.name ?? 'Untitled',
      year,
      releaseInfo: year ? String(year) : undefined,
      releaseDate: date,
      poster: i.poster_path ? `${IMG}/w342${i.poster_path}` : undefined,
      background: i.backdrop_path ? `${IMG}/w1280${i.backdrop_path}` : undefined,
      rating: i.vote_average ? Math.round(i.vote_average * 10) / 10 : undefined,
      genres: i.genres?.map((g) => g.name) ?? (i.genre_ids ?? []).map((g) => genres[g]).filter(Boolean),
      description: i.overview,
      runtime: i.runtime ? `${i.runtime} min` : i.episode_run_time?.[0] ? `${i.episode_run_time[0]} min` : undefined,
      country: i.production_countries?.map((c) => c.name).join(', ') || i.origin_country?.join(', '),
      upcoming: isFuture(date) || undefined,
    };
  }

  private async list(path: string, type: MediaType, params: Record<string, string | number | undefined> = {}) {
    const genres = await this.genresFor(type);
    const r = await this.get<{ results: TmItem[]; page: number; total_pages: number }>(path, params);
    return { items: r.results.map((i) => this.summary(i, type, genres)).filter((t) => t.poster), hasMore: r.page < r.total_pages };
  }

  async browse(q: BrowseQuery): Promise<BrowseResult> {
    const genres = await this.genresFor(q.type);
    const genreId = q.genre ? Object.entries(genres).find(([, n]) => n === q.genre)?.[0] : undefined;
    const today = new Date().toISOString().slice(0, 10);
    const sort = q.sort === 'rating' ? 'vote_average.desc' : q.sort === 'new' ? (q.type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc') : 'popularity.desc';
    return this.list(`/discover/${tmType(q.type)}`, q.type, {
      sort_by: sort,
      with_genres: genreId,
      page: (q.page ?? 0) + 1,
      'vote_count.gte': q.sort === 'rating' ? 500 : q.sort === 'new' ? 20 : undefined,
      [q.type === 'movie' ? 'primary_release_year' : 'first_air_date_year']: q.year,
      [q.type === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte']: q.sort === 'new' ? today : undefined,
    });
  }

  async home(): Promise<CatalogSection[]> {
    const [trend, trendTv, nowPlaying, upcoming, topRated, topTv, indian, korean, anim, docs] = await Promise.all([
      this.list('/trending/movie/week', 'movie'),
      this.list('/trending/tv/week', 'series'),
      this.list('/movie/now_playing', 'movie'),
      this.list('/movie/upcoming', 'movie'),
      this.list('/movie/top_rated', 'movie'),
      this.list('/tv/top_rated', 'series'),
      this.list('/discover/movie', 'movie', { with_origin_country: 'IN', sort_by: 'popularity.desc' }),
      this.list('/discover/tv', 'series', { with_origin_country: 'KR', sort_by: 'popularity.desc' }),
      this.list('/discover/movie', 'movie', { with_genres: 16, sort_by: 'popularity.desc' }),
      this.list('/discover/movie', 'movie', { with_genres: 99, sort_by: 'popularity.desc' }),
    ]);
    return [
      { id: 'trending-movies', title: 'Trending Movies', items: trend.items, href: '/browse/movie?sort=popular' },
      { id: 'popular-series', title: 'Popular Series', items: trendTv.items, href: '/browse/series?sort=popular' },
      { id: 'new-releases', title: 'Now Playing', items: nowPlaying.items.filter((t) => !t.upcoming) },
      { id: 'top-rated', title: 'Critically Acclaimed', items: topRated.items },
      { id: 'indian', title: 'Indian Cinema', items: indian.items },
      { id: 'korean', title: 'Korean Series', items: korean.items },
      { id: 'animation', title: 'Animation', items: anim.items },
      { id: 'documentary', title: 'Documentaries', items: docs.items },
      { id: 'top-series', title: 'Acclaimed Series', items: topTv.items },
      { id: 'coming-soon', title: 'Coming Soon', subtitle: 'Not yet released — catalogue only', items: upcoming.items.filter((t) => t.upcoming) },
    ].filter((s) => s.items.length);
  }

  async search(query: string, type?: MediaType): Promise<TitleSummary[]> {
    if (!query.trim()) return [];
    const [mg, tg] = await Promise.all([this.genresFor('movie'), this.genresFor('series')]);
    const r = await this.get<{ results: TmItem[] }>('/search/multi', { query, include_adult: 'false' }, DAY);
    return r.results
      .filter((i) => i.media_type === 'movie' || i.media_type === 'tv')
      .map((i) => (i.media_type === 'tv' ? this.summary(i, 'series', tg) : this.summary(i, 'movie', mg)))
      .filter((t) => !type || t.type === type);
  }

  /** Accepts tmdb-<type>-<id> ids and IMDb tt ids (resolved via /find). */
  private async resolveId(type: MediaType, id: string): Promise<number | null> {
    const m = id.match(/^tmdb-(movie|series)-(\d+)$/);
    if (m) return Number(m[2]);
    if (/^tt\d+$/.test(id)) {
      const r = await this.get<{ movie_results: TmItem[]; tv_results: TmItem[] }>(`/find/${id}`, { external_source: 'imdb_id' }, 7 * DAY);
      return (type === 'series' ? r.tv_results : r.movie_results)[0]?.id ?? null;
    }
    return null;
  }

  async detail(type: MediaType, id: string): Promise<TitleDetail | null> {
    const tid = await this.resolveId(type, id);
    if (tid == null) return null;
    const i = await this.get<TmItem>(`/${tmType(type)}/${tid}`, { append_to_response: 'credits,videos,external_ids,images', include_image_language: 'en,null' }, 2 * DAY);
    const s = this.summary(i, type);
    if (/^tt\d+$/.test(id)) s.id = id; // keep the id the user navigated with
    const people: Person[] = [
      ...(i.created_by ?? []).map((c) => ({ name: c.name, role: 'creator' as const, photo: c.profile_path ? `${IMG}/w185${c.profile_path}` : undefined })),
      ...(i.credits?.crew ?? []).filter((c) => c.job === 'Director').map((c) => ({ name: c.name, role: 'director' as const, photo: c.profile_path ? `${IMG}/w185${c.profile_path}` : undefined })),
      ...(i.credits?.cast ?? []).slice(0, 20).map((c) => ({ name: c.name, role: 'cast' as const, character: c.character, photo: c.profile_path ? `${IMG}/w185${c.profile_path}` : undefined })),
      ...(i.credits?.crew ?? []).filter((c) => c.job === 'Screenplay' || c.job === 'Writer').slice(0, 4).map((c) => ({ name: c.name, role: 'writer' as const })),
    ];
    const logo = i.images?.logos?.find((l) => l.iso_639_1 === 'en') ?? i.images?.logos?.[0];
    let episodes: Episode[] | undefined;
    let seasons: number[] | undefined;
    if (type === 'series') {
      seasons = (i.seasons ?? []).filter((x) => x.episode_count > 0).map((x) => x.season_number);
      const seasonData = await mapLimit(seasons, 4, (n) =>
        this.get<{ episodes: { episode_number: number; season_number: number; name: string; overview: string; still_path: string | null; air_date: string | null; vote_average: number }[] }>(`/tv/${tid}/season/${n}`, {}, DAY).catch(() => ({ episodes: [] })),
      );
      episodes = sortEpisodes(
        seasonData.flatMap((sd) =>
          sd.episodes.map((e) => ({
            id: `${s.id}:${e.season_number}:${e.episode_number}`,
            season: e.season_number,
            episode: e.episode_number,
            name: e.name,
            overview: e.overview || undefined,
            thumbnail: e.still_path ? `${IMG}/w500${e.still_path}` : undefined,
            released: e.air_date ?? undefined,
            rating: e.vote_average || undefined,
            upcoming: isFuture(e.air_date ?? undefined) || undefined,
          })),
        ),
      );
      seasons.sort((a, b) => (a === 0 ? 1e6 : a) - (b === 0 ? 1e6 : b));
    }
    return {
      ...s,
      logo: logo ? `${IMG}/w500${logo.file_path}` : undefined,
      background: i.backdrop_path ? `${IMG}/original${i.backdrop_path}` : s.background,
      people,
      trailers: (i.videos?.results ?? []).filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser')).map((v) => ({ ytId: v.key, name: v.name })),
      status: i.status,
      seasons,
      episodes,
      metadataProvider: this.id,
      fetchedAt: Date.now(),
    };
  }

  async recommendations(d: TitleDetail): Promise<TitleSummary[]> {
    const tid = await this.resolveId(d.type, d.id);
    if (tid == null) return [];
    return (await this.list(`/${tmType(d.type)}/${tid}/recommendations`, d.type)).items.slice(0, 18);
  }
}
