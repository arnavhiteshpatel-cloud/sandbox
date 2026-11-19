// Builds the verified-playable index: resolves sources for authorized libraries and test-fetches each one.
// Usage: npm run verify:sources -- [--limit 300] [--skip-archive] [--concurrency 6]
import { cinemeta } from '../server/metadata/index.ts';
import { contextFor } from '../server/routes/catalog.ts';
import { archive, getSources } from '../server/sources/registry.ts';
import { OPEN_MOVIES } from '../server/sources/openMovies.ts';
import { PD_SERIES } from '../server/sources/archive.ts';
import { fetchJson, mapLimit } from '../server/lib/http.ts';
import { db } from '../server/db.ts';

const args = process.argv.slice(2);
const arg = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const LIMIT = arg('--limit', 100000);
const CONC = arg('--concurrency', 6);

/** Well-known public-domain sound films (US) — resolved by exact title + year against curated IA collections. */
const PD_FEATURES: [string, number][] = [
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

const stats = { titles: 0, verifiedTitles: 0, units: 0, failed: 0, noSource: 0 };
const t0 = Date.now();

async function indexTitle(type: 'movie' | 'series', id: string, season?: number, episode?: number) {
  try {
    const c = await contextFor(type, id, season, episode);
    if (!c) return;
    stats.titles++;
    const r = await getSources(c.ctx, c.title);
    const ok = r.sources.filter((s) => s.verify.status === 'verified');
    if (ok.length) { stats.verifiedTitles++; stats.units++; } else if (r.sources.length) stats.failed++; else stats.noSource++;
    if (stats.titles % 25 === 0) console.log(`  … ${stats.titles} checked, ${stats.verifiedTitles} verified (${Math.round((Date.now() - t0) / 1000)}s)`);
  } catch (e) {
    console.warn(`  ! ${type} ${id}: ${(e as Error).message}`);
  }
}

async function findId(name: string, year: number, type: 'movie' | 'series') {
  const res = await cinemeta.search(name, type).catch(() => []);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return res.find((t) => norm(t.name) === norm(name) && t.year != null && Math.abs(t.year - year) <= 1)?.id;
}

console.log('1/4 Open movies');
await mapLimit(OPEN_MOVIES, 3, (m) => indexTitle('movie', m.imdbId));

console.log('2/4 Public-domain features (title + year)');
await mapLimit(PD_FEATURES, CONC, async ([name, year]) => {
  const id = await findId(name, year, 'movie');
  if (id) await indexTitle('movie', id); else console.log(`  - no catalogue match: ${name} (${year})`);
});

if (!args.includes('--skip-archive')) {
  console.log('3/4 Internet Archive items with explicit IMDb ids');
  const r = await fetchJson<{ items: { 'external-identifier'?: string | string[]; collection?: string | string[] }[] }>(
    `https://archive.org/services/search/v1/scrape?q=${encodeURIComponent('collection:feature_films AND external-identifier:urn\\:imdb*')}&fields=identifier,external-identifier,collection&count=10000`, { timeoutMs: 120000 });
  const ids = [...new Set(r.items.flatMap((i) => [i['external-identifier'] ?? []].flat()).map((x) => x.match(/urn:imdb:(tt\d+)/)?.[1]).filter((x): x is string => !!x))].slice(0, LIMIT);
  console.log(`  ${ids.length} distinct IMDb ids`);
  await mapLimit(ids, CONC, (id) => indexTitle('movie', id));
}

console.log('4/4 Public-domain TV episodes');
for (const s of PD_SERIES) {
  const id = await findId(s.name, s.year, 'series');
  if (!id) { console.log(`  - no catalogue match: ${s.name}`); continue; }
  const c = await contextFor('series', id, 1, 1);
  if (!c) continue;
  const eps = await archive.availableEpisodes(c.ctx).catch(() => [] as string[]);
  console.log(`  ${s.name}: ${eps.length} candidate episodes`);
  await mapLimit(eps, CONC, (k) => { const [se, ep] = k.split(':').map(Number); return indexTitle('series', id, se, ep); });
}

const totals = db.prepare('SELECT COUNT(DISTINCT title_id) AS titles, COUNT(DISTINCT media_key) AS units FROM playable_index').get();
const byProvider = db.prepare('SELECT provider, COUNT(DISTINCT title_id) AS titles, COUNT(DISTINCT media_key) AS units FROM playable_index GROUP BY provider').all();
console.log('\nDone in', Math.round((Date.now() - t0) / 1000), 's');
console.log('This run:', stats);
console.log('Playable index totals:', totals, byProvider);
process.exit(0);
