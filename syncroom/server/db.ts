import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });
const file = process.env.SYNCROOM_DB ?? path.join(config.dataDir, 'syncroom.db');
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

const migrations: string[] = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL);
   CREATE TABLE meta_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE source_cache (key TEXT PRIMARY KEY, provider TEXT NOT NULL, json TEXT NOT NULL, checked_at INTEGER NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE progress (
     user_id TEXT NOT NULL, media_key TEXT NOT NULL, title_id TEXT NOT NULL, ref_json TEXT NOT NULL, title_json TEXT NOT NULL,
     episode_name TEXT, position REAL NOT NULL, duration REAL NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
     source_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, media_key));
   CREATE INDEX progress_user_updated ON progress(user_id, updated_at DESC);
   CREATE TABLE library (user_id TEXT NOT NULL, list TEXT NOT NULL, title_id TEXT NOT NULL, title_json TEXT NOT NULL, added_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, list, title_id));
   CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL, created_by TEXT NOT NULL,
     state_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE room_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, joined_at INTEGER NOT NULL,
     PRIMARY KEY (room_id, user_id));
   CREATE TABLE user_sources (id TEXT PRIMARY KEY, title_id TEXT NOT NULL, media_key TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL,
     label TEXT NOT NULL, subtitles_json TEXT NOT NULL DEFAULT '[]', added_by TEXT, verify_json TEXT, created_at INTEGER NOT NULL);
   CREATE INDEX user_sources_key ON user_sources(media_key);
   CREATE TABLE playable_index (title_id TEXT NOT NULL, provider TEXT NOT NULL, media_key TEXT NOT NULL, source_json TEXT NOT NULL,
     title_json TEXT, verified_at INTEGER NOT NULL, PRIMARY KEY (provider, media_key, title_id));
   CREATE INDEX playable_title ON playable_index(title_id);
   CREATE TABLE playback_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, provider TEXT NOT NULL, ok INTEGER NOT NULL,
     detail TEXT, at INTEGER NOT NULL);`,
];

db.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)');
const done = new Set((db.prepare('SELECT n FROM _migrations').all() as { n: number }[]).map((r) => r.n));
migrations.forEach((sql, i) => {
  if (done.has(i)) return;
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (n) VALUES (?)').run(i);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
