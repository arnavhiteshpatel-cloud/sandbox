// Source registry: adding a provider = implementing SourceProvider and listing it here.
import type { PlaybackSource, ProviderHealth, ProviderInfo, SourcesResponse, TitleSummary } from '../../shared/types.ts';
import { mediaKey } from '../../shared/types.ts';
import { db, getSetting, setSetting } from '../db.ts';
import { HOUR, mapLimit } from '../lib/http.ts';
import { ArchiveProvider } from './archive.ts';
import { JellyfinProvider } from './jellyfin.ts';
import { localLibrary } from './localLibrary.ts';
import { OpenMoviesProvider } from './openMovies.ts';
import { openSubtitlesConfig, openSubtitlesConfigFields, openSubtitlesSearch } from './opensubtitles.ts';
import { PlexProvider } from './plex.ts';
import type { ResolveContext, SourceProvider } from './types.ts';
import { userSources } from './userSources.ts';
import { verifyMediaUrl } from './verify.ts';

export const archive = new ArchiveProvider();

/** Order = default ranking priority (your own media first). */
export const providers: SourceProvider[] = [localLibrary, new JellyfinProvider(), new PlexProvider(), new OpenMoviesProvider(), archive, userSources];

const health = new Map<string, ProviderHealth>();
const h = (id: string) => {
  if (!health.has(id)) health.set(id, { ok: null, successes: 0, failures: 0 });
  return health.get(id)!;
};

function providerSettings(id: string) {
  return getSetting<Record<string, string | boolean | undefined>>(`provider.${id}`, {});
}
function isEnabled(p: SourceProvider) {
  return providerSettings(p.id).enabled !== false;
}

export function providerInfo(): ProviderInfo[] {
  const list: ProviderInfo[] = providers.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    kinds: p.kinds,
    requiresConfig: p.requiresConfig,
    configured: p.isConfigured(),
    enabled: isEnabled(p),
    configFields: p.configFields,
    status: !isEnabled(p) ? 'disabled' : p.isConfigured() ? 'live-verified' : 'needs-authorization',
    health: h(p.id),
  }));
  const os = openSubtitlesConfig();
  list.push({
    id: 'opensubtitles', name: 'OpenSubtitles (subtitles)', description: 'Adds community subtitles in your languages to every movie/episode with an IMDb id.', kinds: [],
    requiresConfig: true, configured: !!os.apiKey, enabled: os.enabled !== false, configFields: openSubtitlesConfigFields,
    status: os.enabled === false ? 'disabled' : os.apiKey ? 'live-verified' : 'needs-authorization', health: h('opensubtitles'),
  });
  // "live-verified" only means the provider *can* run; per-source verification is tracked separately.
  return list.map((p) => ({ ...p, status: p.status === 'live-verified' && p.health.ok === false ? 'needs-authorization' : p.status }));
}

/** Public view of provider settings (secrets masked). */
export function providerConfigView(id: string) {
  const s = providerSettings(id);
  const p = providers.find((x) => x.id === id);
  const fields = p?.configFields ?? (id === 'opensubtitles' ? openSubtitlesConfigFields : []);
  const out: Record<string, unknown> = { enabled: s.enabled !== false };
  for (const f of fields) out[f.key] = f.secret ? (s[f.key] ? '••••••••' : '') : s[f.key] ?? '';
  return out;
}

export function setProviderConfig(id: string, values: Record<string, unknown>) {
  const current = providerSettings(id);
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(values)) {
    if (v === '••••••••') continue; // masked secret left unchanged
    next[k] = typeof v === 'string' ? v.trim() : v;
  }
  setSetting(`provider.${id}`, next);
  h(id).ok = null;
}

function cacheGet<T>(key: string, maxAge: number): T | null {
  const row = db.prepare('SELECT json, checked_at FROM source_cache WHERE key = ?').get(key) as { json: string; checked_at: number } | undefined;
  return row && Date.now() - row.checked_at < maxAge ? (JSON.parse(row.json) as T) : null;
}
function cacheSet(key: string, provider: string, value: unknown) {
  db.prepare('INSERT INTO source_cache (key, provider, json, checked_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, checked_at=excluded.checked_at, provider=excluded.provider')
    .run(key, provider, JSON.stringify(value), Date.now());
}

const REMOTE_CACHE: Record<string, number> = { archive: 12 * HOUR, openmovies: 24 * HOUR };

async function verify(source: PlaybackSource): Promise<PlaybackSource> {
  if (source.providerId === 'user' && source.verify.checkedAt > Date.now() - 24 * HOUR) return source;
  const key = `verify:${source.id}`;
  const prev = cacheGet<PlaybackSource['verify']>(key, 7 * 24 * HOUR);
  const maxAge = prev?.status === 'verified' ? 12 * HOUR : 30 * 60_000;
  let v = prev && Date.now() - prev.checkedAt < maxAge ? prev : null;
  if (!v) {
    const r = await verifyMediaUrl(source.url, source.kind);
    v = { status: r.status, checkedAt: r.checkedAt, detail: r.detail };
    cacheSet(key, source.providerId, v);
  }
  // Recent in-browser playback failures override a server-side "verified".
  const fails = db.prepare('SELECT COUNT(*) AS n FROM playback_reports WHERE source_id = ? AND ok = 0 AND at > ? AND at > (SELECT COALESCE(MAX(at),0) FROM playback_reports WHERE source_id = ? AND ok = 1)').get(source.id, Date.now() - 6 * HOUR, source.id) as { n: number };
  if (v.status === 'verified' && fails.n >= 2) v = { ...v, status: 'failed', detail: `${fails.n} recent playback failures reported by browsers` };
  return { ...source, verify: v };
}

const syncRank = { frame: 0, precise: 1, coarse: 2, none: 3 };
const matchRank = { 'exact-id': 0, curated: 0, user: 1, 'episode-title': 2, 'title-year': 2 };
const statusRank = { verified: 0, unverified: 1, failed: 2 };

export async function getSources(ctx: ResolveContext, title?: TitleSummary): Promise<SourcesResponse> {
  const checked: SourcesResponse['checked'] = [];
  const key = mediaKey(ctx.ref);
  const lists = await Promise.all(
    providers.map(async (p) => {
      if (!isEnabled(p)) { checked.push({ providerId: p.id, providerName: p.name, found: 0, skipped: 'disabled' }); return []; }
      if (!p.isConfigured()) { checked.push({ providerId: p.id, providerName: p.name, found: 0, skipped: 'not configured' }); return []; }
      const t0 = Date.now();
      try {
        const ttl = REMOTE_CACHE[p.id];
        const cacheKey = `resolve:${p.id}:${key}:${ctx.origin}`;
        let list = ttl ? cacheGet<PlaybackSource[]>(cacheKey, ttl) : null;
        // "nothing found" is re-checked much sooner than a positive result
        if (list && list.length === 0 && !cacheGet<PlaybackSource[]>(cacheKey, 20 * 60_000)) list = null;
        if (!list) {
          list = await Promise.race([
            p.getAvailableSources(ctx),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out after 25s')), 25000)),
          ]);
          if (ttl) cacheSet(cacheKey, p.id, list);
        }
        const hh = h(p.id);
        hh.ok = true; hh.successes++; hh.latencyMs = Date.now() - t0; hh.lastCheck = Date.now();
        checked.push({ providerId: p.id, providerName: p.name, found: list.length });
        return list;
      } catch (e) {
        const hh = h(p.id);
        hh.ok = false; hh.failures++; hh.lastError = (e as Error).message; hh.lastCheck = Date.now();
        checked.push({ providerId: p.id, providerName: p.name, found: 0, error: (e as Error).message });
        return [];
      }
    }),
  );
  let sources = await mapLimit(lists.flat(), 6, verify);

  // Optional extra subtitles (OpenSubtitles) for every source
  try {
    const extra = await openSubtitlesSearch(ctx);
    if (extra.length) {
      h('opensubtitles').ok = true;
      sources = sources.map((s) => (s.capabilities.subtitles ? { ...s, subtitles: [...s.subtitles, ...extra] } : s));
    }
  } catch (e) {
    const hh = h('opensubtitles');
    hh.ok = false; hh.lastError = (e as Error).message; hh.failures++;
  }

  const prio = (id: string) => providers.findIndex((p) => p.id === id);
  sources.sort(
    (a, b) =>
      statusRank[a.verify.status] - statusRank[b.verify.status] ||
      syncRank[a.capabilities.syncGrade] - syncRank[b.capabilities.syncGrade] ||
      matchRank[a.match] - matchRank[b.match] ||
      prio(a.providerId) - prio(b.providerId),
  );

  // Remember verified-playable titles (powers "Watch Free Now" and catalogue availability badges).
  const now = Date.now();
  const upsert = db.prepare('INSERT INTO playable_index (title_id, provider, media_key, source_json, title_json, verified_at) VALUES (?,?,?,?,?,?) ON CONFLICT(provider, media_key, title_id) DO UPDATE SET source_json=excluded.source_json, title_json=COALESCE(excluded.title_json, playable_index.title_json), verified_at=excluded.verified_at');
  const del = db.prepare('DELETE FROM playable_index WHERE provider = ? AND media_key = ?');
  for (const p of new Set(sources.map((s) => s.providerId))) {
    const best = sources.find((s) => s.providerId === p && s.verify.status === 'verified');
    if (best && p !== 'local' && p !== 'jellyfin' && p !== 'plex' && p !== 'user') upsert.run(ctx.ref.titleId, p, key, JSON.stringify(best), title ? JSON.stringify(title) : null, now);
    else if (!best) del.run(p, key);
  }
  return { ref: ctx.ref, sources, checked };
}

export function reportPlayback(sourceId: string, providerId: string, ok: boolean, detail?: string) {
  db.prepare('INSERT INTO playback_reports (source_id, provider, ok, detail, at) VALUES (?,?,?,?,?)').run(sourceId, providerId, ok ? 1 : 0, detail?.slice(0, 500) ?? null, Date.now());
  const hh = h(providerId);
  if (ok) { hh.successes++; } else { hh.failures++; hh.lastError = detail; }
}

export async function runHealthChecks() {
  await Promise.all(
    providers.filter((p) => isEnabled(p) && p.isConfigured()).map(async (p) => {
      const t0 = Date.now();
      const hh = h(p.id);
      try {
        await p.healthCheck();
        hh.ok = true; hh.latencyMs = Date.now() - t0;
      } catch (e) {
        hh.ok = false; hh.lastError = (e as Error).message;
      }
      hh.lastCheck = Date.now();
    }),
  );
}
