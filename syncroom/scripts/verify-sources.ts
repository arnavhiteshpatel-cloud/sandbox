// Builds the verified-playable index: resolves sources for authorized libraries and test-fetches each one.
// Usage: npm run verify:sources -- [--limit 300] [--skip-archive] [--concurrency 6]
import { contextFor } from '../server/routes/catalog.ts';
import { archive, getSources } from '../server/sources/registry.ts';
import { findCatalogId, seedCurated } from '../server/sources/seed.ts';
import { fetchJson, mapLimit } from '../server/lib/http.ts';
import { db } from '../server/db.ts';

const args = process.argv.slice(2);
const arg = (k: string, d: number) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const LIMIT = arg('--limit', 100000);
const CONC = arg('--concurrency', 6);


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


console.log('1/2 Open movies, public-domain features and public-domain TV episodes');
await seedCurated(indexTitle, CONC, archive);

if (!args.includes('--skip-archive')) {
  console.log('2/2 Internet Archive items with explicit IMDb ids');
  const r = await fetchJson<{ items: { 'external-identifier'?: string | string[]; collection?: string | string[] }[] }>(
    `https://archive.org/services/search/v1/scrape?q=${encodeURIComponent('collection:feature_films AND external-identifier:urn\\:imdb*')}&fields=identifier,external-identifier,collection&count=10000`, { timeoutMs: 120000 });
  const ids = [...new Set(r.items.flatMap((i) => [i['external-identifier'] ?? []].flat()).map((x) => x.match(/urn:imdb:(tt\d+)/)?.[1]).filter((x): x is string => !!x))].slice(0, LIMIT);
  console.log(`  ${ids.length} distinct IMDb ids`);
  await mapLimit(ids, CONC, (id) => indexTitle('movie', id));
}

const totals = db.prepare('SELECT COUNT(DISTINCT title_id) AS titles, COUNT(DISTINCT media_key) AS units FROM playable_index').get();
const byProvider = db.prepare('SELECT provider, COUNT(DISTINCT title_id) AS titles, COUNT(DISTINCT media_key) AS units FROM playable_index GROUP BY provider').all();
console.log('\nDone in', Math.round((Date.now() - t0) / 1000), 's');
console.log('This run:', stats);
console.log('Playable index totals:', totals, byProvider);
process.exit(0);
