import { db } from '../db.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15000, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'SyncRoom/0.1 (+local)', accept: 'application/json', ...(rest.headers ?? {}) } });
      if (!res.ok) {
        // 4xx (other than 429) are not worth retrying
        if (res.status < 500 && res.status !== 429) throw new HttpError(res.status, `${res.status} ${res.statusText} for ${redact(url)}`);
        throw new Error(`${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1) ** 2));
    }
  }
  throw lastErr;
}

export function redact(url: string) {
  return url.replace(/(api_key|apikey|api-key|X-Plex-Token|token)=[^&]+/gi, '$1=***');
}

const inflight = new Map<string, Promise<unknown>>();
const refreshing = new Set<string>();

/**
 * Persistent stale-while-revalidate cache backed by SQLite.
 * Fresh → return. Stale → return immediately and refresh in background ("automatic metadata updates").
 * Missing → fetch (deduplicated across concurrent callers).
 */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const row = db.prepare('SELECT json, expires_at FROM meta_cache WHERE key = ?').get(key) as { json: string; expires_at: number } | undefined;
  const now = Date.now();
  const store = (v: T) => {
    db.prepare('INSERT INTO meta_cache (key, json, fetched_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at')
      .run(key, JSON.stringify(v), Date.now(), Date.now() + ttlMs);
    return v;
  };
  if (row) {
    if (row.expires_at < now && !refreshing.has(key)) {
      refreshing.add(key);
      loader().then(store).catch(() => {}).finally(() => refreshing.delete(key));
    }
    return JSON.parse(row.json) as T;
  }
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = loader().then(store).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
