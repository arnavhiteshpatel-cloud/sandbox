// Background seeding of the verified-playable index, so "Watch Free Now" is populated on a fresh install.
import { db } from '../db.ts';
import { cinemeta } from '../metadata/index.ts';
import { mapLimit } from '../lib/http.ts';
import { OPEN_MOVIES } from './openMovies.ts';
import { PD_SERIES, ArchiveProvider } from './archive.ts';

/** Well-known public-domain sound films (US) — resolved by exact title + year against curated IA collections. */
export const PD_FEATURES: [string, number][] = [
  ['Night of the Living Dead', 1968], ['His Girl Friday', 1940], ['Charade', 1963], ['Detour', 1945], ['Plan 9 from Outer Space', 1957],
  ['The Little Shop of Horrors', 1960], ['Carnival of Souls', 1962], ['House on Haunted Hill', 1959], ['D.O.A.', 1949], ['The Stranger', 1946],
  ['Scarlet Street', 1945], ['My Man Godfrey', 1936], ['Meet John Doe', 1941], ['Royal Wedding', 1951], ['McLintock!', 1963],
  ['The Last Man on Earth', 1964], ['Dementia 13', 1963], ['The Brain That Wouldn\'t Die', 1962], ['Kansas City Confidential', 1952], ['The Hitch-Hiker', 1953],
  ['Penny Serenade', 1941], ['Nothing Sacred', 1937], ['A Star Is Born', 1937], ['Gulliver\'s Travels', 1939], ['Reefer Madness', 1936],
  ['The Terror', 1963], ['Beat the Devil', 1953], ['Suddenly', 1954], ['Africa Screams', 1949], ['The Man with the Golden Arm', 1955],
  ['The 39 Steps', 1935], ['The Lady Vanishes', 1938], ['Sabotage', 1936], ['Jamaica Inn', 1939], ['Angel and the Badman', 1947],
  ['Topper Returns', 1941], ['The Amazing Mr. X', 1948], ['Quicksand', 1950], ['The Big Combo', 1955], ['Impact', 1949],
  ['The Bat', 1959], ['Teenagers from Outer Space', 1959], ['Robot Monster', 1953], ['The Killer Shrews', 1959], ['Bride of the Monster', 1955],
  ['Glen or Glenda', 1953], ['Santa Claus Conquers the Martians', 1964], ['The Thief of Bagdad', 1924], ['Nosferatu', 1922], ['Metropolis', 1927],
  ['The General', 1926], ['Sherlock Jr.', 1924], ['The Kid', 1921], ['The Phantom of the Opera', 1925], ['The Cabinet of Dr. Caligari', 1920],
  ['Battleship Potemkin', 1925], ['A Trip to the Moon', 1902], ['The Gold Rush', 1925], ['Safety Last!', 1923], ['Steamboat Bill, Jr.', 1928],
  ['Of Human Bondage', 1934], ['Rain', 1932], ['The Front Page', 1931], ['Father\'s Little Dividend', 1951], ['The Snows of Kilimanjaro', 1952],
  ['Algiers', 1938], ['Made for Each Other', 1939], ['Life with Father', 1947], ['The Outlaw', 1943], ['Jungle Book', 1942],
  ['The Hoodlum Priest', 1961], ['The Screaming Skull', 1958], ['Attack of the Giant Leeches', 1959], ['The Wasp Woman', 1959], ['Indestructible Man', 1956],
];

export async function findCatalogId(name: string, year: number, type: 'movie' | 'series') {
  const res = await cinemeta.search(name, type).catch(() => []);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return res.find((t) => norm(t.name) === norm(name) && t.year != null && Math.abs(t.year - year) <= 1)?.id;
}

type IndexFn = (type: 'movie' | 'series', id: string, season?: number, episode?: number) => Promise<void>;

/** Open movies + public-domain features + PD series episodes. */
export async function seedCurated(index: IndexFn, concurrency = 4, archive = new ArchiveProvider()) {
  await mapLimit(OPEN_MOVIES, 3, (m) => index('movie', m.imdbId));
  await mapLimit(PD_FEATURES, concurrency, async ([name, year]) => {
    const id = await findCatalogId(name, year, 'movie');
    if (id) await index('movie', id);
  });
  const { contextFor } = await import('../routes/catalog.ts');
  for (const s of PD_SERIES) {
    const id = await findCatalogId(s.name, s.year, 'series');
    if (!id) continue;
    const c = await contextFor('series', id, 1, 1);
    if (!c) continue;
    const eps = await archive.availableEpisodes(c.ctx).catch(() => [] as string[]);
    await mapLimit(eps, concurrency, (k) => { const [se, ep] = k.split(':').map(Number); return index('series', id, se, ep); });
  }
}

let running = false;
/** Runs on server start when the index is (nearly) empty, and daily afterwards to re-verify. */
export async function autoSeed(force = false) {
  if (running) return;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM playable_index').get() as { n: number }).n;
  if (n >= 20 && !force) return;
  running = true;
  const t0 = Date.now();
  try {
    const { contextFor } = await import('../routes/catalog.ts');
    const { getSources } = await import('./registry.ts');
    await seedCurated(async (type, id, season, episode) => {
      const c = await contextFor(type, id, season, episode).catch(() => null);
      if (c) await getSources(c.ctx, c.title).catch(() => {});
    }, 3);
    const after = (db.prepare('SELECT COUNT(DISTINCT title_id) AS t FROM playable_index').get() as { t: number }).t;
    console.log(`[seed] verified-playable index: ${after} titles (${Math.round((Date.now() - t0) / 1000)}s)`);
  } finally {
    running = false;
  }
}
