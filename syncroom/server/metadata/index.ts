import { config } from '../config.ts';
import { getSetting } from '../db.ts';
import { CinemetaProvider } from './cinemeta.ts';
import { TmdbProvider } from './tmdb.ts';
import type { MetadataProvider } from './types.ts';

const cinemeta = new CinemetaProvider();
let tmdb: TmdbProvider | null = null;
let tmdbKey: string | undefined;

/** TMDB when a key is configured (env TMDB_API_KEY or Settings), otherwise the keyless Cinemeta catalogue. */
export function metadata(): MetadataProvider {
  const key = getSetting<string | undefined>('tmdb.key', undefined) || config.tmdbKey;
  if (key) {
    if (!tmdb || key !== tmdbKey) {
      tmdb = new TmdbProvider(key);
      tmdbKey = key;
    }
    return tmdb;
  }
  return cinemeta;
}

/** Cinemeta stays available as a fallback (e.g. if TMDB rejects the key). */
export async function withFallback<T>(fn: (p: MetadataProvider) => Promise<T>): Promise<T> {
  const p = metadata();
  try {
    return await fn(p);
  } catch (e) {
    if (p === cinemeta) throw e;
    console.warn('[metadata] primary provider failed, falling back to Cinemeta:', (e as Error).message);
    return fn(cinemeta);
  }
}

export { cinemeta };
