import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Contract test: a fake TMDB v3 API returning documented response shapes. (No live key was available.)
let server: http.Server;
const hits: string[] = [];
let Provider: typeof import('../../server/metadata/tmdb.ts').TmdbProvider;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    hits.push(u.pathname + '?' + u.searchParams.toString());
    const j = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.searchParams.get('api_key') !== 'k123') { res.statusCode = 401; return res.end('{}'); }
    if (u.pathname === '/genre/movie/list') return j({ genres: [{ id: 35, name: 'Comedy' }, { id: 18, name: 'Drama' }] });
    if (u.pathname === '/genre/tv/list') return j({ genres: [{ id: 18, name: 'Drama' }] });
    if (u.pathname === '/search/multi') return j({ results: [
      { id: 20453, media_type: 'movie', title: '3 Idiots', release_date: '2009-12-23', poster_path: '/p.jpg', backdrop_path: '/b.jpg', vote_average: 7.96, genre_ids: [35, 18] },
      { id: 1, media_type: 'person', name: 'Someone' },
    ] });
    if (u.pathname === '/find/tt1187043') return j({ movie_results: [{ id: 20453 }], tv_results: [] });
    if (u.pathname === '/movie/20453') return j({
      id: 20453, title: '3 Idiots', release_date: '2009-12-23', runtime: 170, poster_path: '/p.jpg', backdrop_path: '/b.jpg', vote_average: 8, imdb_id: 'tt1187043',
      genres: [{ id: 35, name: 'Comedy' }], production_countries: [{ name: 'India' }], overview: 'Two friends…',
      credits: { cast: [{ name: 'Aamir Khan', character: 'Rancho', profile_path: '/a.jpg' }], crew: [{ name: 'Rajkumar Hirani', job: 'Director' }] },
      videos: { results: [{ key: 'K0eDlFX9GMc', site: 'YouTube', type: 'Trailer', name: 'Trailer' }] }, images: { logos: [{ file_path: '/l.png', iso_639_1: 'en' }] },
    });
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.TMDB_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Provider = (await import('../../server/metadata/tmdb.ts')).TmdbProvider;
});
afterAll(() => server.close());

describe('TMDB provider', () => {
  it('searches movies/series only and maps genres', async () => {
    const r = await new Provider('k123').search('3 idiots');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'tmdb-movie-20453', name: '3 Idiots', year: 2009, rating: 8, genres: ['Comedy', 'Drama'] });
    expect(r[0].poster).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
  });
  it('resolves IMDb ids via /find and returns full detail with cast photos and trailers', async () => {
    const d = await new Provider('k123').detail('movie', 'tt1187043');
    expect(d).toMatchObject({ id: 'tt1187043', imdbId: 'tt1187043', name: '3 Idiots', runtime: '170 min', country: 'India' });
    expect(d!.people.find((p) => p.role === 'director')?.name).toBe('Rajkumar Hirani');
    expect(d!.people.find((p) => p.role === 'cast')?.photo).toBe('https://image.tmdb.org/t/p/w185/a.jpg');
    expect(d!.trailers[0].ytId).toBe('K0eDlFX9GMc');
    expect(d!.logo).toContain('/l.png');
  });
});
