import { Router } from 'express';
import type { LibraryList, MediaRef, ProgressEntry, TitleSummary } from '../../shared/types.ts';
import { mediaKey } from '../../shared/types.ts';
import { db } from '../db.ts';
import { createRoom, listUserRooms, roomExists } from '../rooms/roomManager.ts';

export const personal = Router();

const uid = (req: any): string | null => {
  const id = (req.query.userId ?? req.body?.userId ?? req.get('x-user-id')) as string | undefined;
  return id && /^[\w-]{8,64}$/.test(id) ? id : null;
};

personal.post('/users', (req, res) => {
  const id = uid(req);
  const name = String(req.body?.name ?? '').trim().slice(0, 32);
  if (!id || !name) return res.status(400).json({ error: 'userId and name required' });
  db.prepare('INSERT INTO users (id, name, created_at, seen_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, seen_at=excluded.seen_at').run(id, name, Date.now(), Date.now());
  res.json({ id, name });
});

interface ProgRow { media_key: string; ref_json: string; title_json: string; episode_name: string | null; position: number; duration: number; completed: number; updated_at: number; source_id: string | null }
const toEntry = (r: ProgRow): ProgressEntry => ({
  mediaKey: r.media_key, ref: JSON.parse(r.ref_json), title: JSON.parse(r.title_json), episodeName: r.episode_name ?? undefined,
  position: r.position, duration: r.duration, completed: !!r.completed, updatedAt: r.updated_at, sourceId: r.source_id ?? undefined,
});

/** Continue Watching: latest unfinished entry per title (+ next episode when an episode was finished). */
personal.get('/progress', (req, res) => {
  const id = uid(req);
  if (!id) return res.status(400).end();
  const rows = (db.prepare('SELECT * FROM progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT 400').all(id) as unknown as ProgRow[]).map(toEntry);
  const perTitle = new Map<string, ProgressEntry>();
  for (const e of rows) if (!perTitle.has(e.ref.titleId)) perTitle.set(e.ref.titleId, e);
  const continueWatching = [...perTitle.values()].filter((e) => !e.completed || e.ref.type === 'series').slice(0, 30);
  const completed = [...perTitle.values()].filter((e) => e.completed && e.ref.type === 'movie');
  res.json({ continueWatching, completed, history: rows.slice(0, 100) });
});

personal.get('/progress/title/:titleId', (req, res) => {
  const id = uid(req);
  if (!id) return res.status(400).end();
  const rows = (db.prepare('SELECT * FROM progress WHERE user_id = ? AND title_id = ? ORDER BY updated_at DESC').all(id, req.params.titleId) as unknown as ProgRow[]).map(toEntry);
  res.json({ entries: rows });
});

personal.put('/progress', (req, res) => {
  const id = uid(req);
  const { ref, title, episodeName, position, duration, sourceId } = req.body ?? {};
  if (!id || !ref?.titleId || !title?.name || typeof position !== 'number') return res.status(400).json({ error: 'invalid' });
  const r = ref as MediaRef;
  const t = title as TitleSummary;
  const dur = Number(duration) || 0;
  const completed = dur > 0 && (position / dur > 0.92 || dur - position < 120) ? 1 : 0;
  db.prepare(`INSERT INTO progress (user_id, media_key, title_id, ref_json, title_json, episode_name, position, duration, completed, source_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, media_key) DO UPDATE SET position=excluded.position, duration=excluded.duration,
    completed=MAX(progress.completed, excluded.completed), title_json=excluded.title_json, episode_name=excluded.episode_name, source_id=excluded.source_id, updated_at=excluded.updated_at`)
    .run(id, mediaKey(r), r.titleId, JSON.stringify(r), JSON.stringify(t), episodeName ?? null, position, dur, completed, sourceId ?? null, Date.now());
  res.json({ ok: true, completed: !!completed });
});

personal.delete('/progress/:key', (req, res) => {
  const id = uid(req);
  if (!id) return res.status(400).end();
  db.prepare('DELETE FROM progress WHERE user_id = ? AND (media_key = ? OR title_id = ?)').run(id, req.params.key, req.params.key);
  res.json({ ok: true });
});

personal.get('/library', (req, res) => {
  const id = uid(req);
  if (!id) return res.status(400).end();
  const rows = db.prepare('SELECT list, title_json, added_at FROM library WHERE user_id = ? ORDER BY added_at DESC').all(id) as { list: LibraryList; title_json: string; added_at: number }[];
  res.json({
    watchlist: rows.filter((r) => r.list === 'watchlist').map((r) => JSON.parse(r.title_json)),
    favorite: rows.filter((r) => r.list === 'favorite').map((r) => JSON.parse(r.title_json)),
  });
});

personal.put('/library/:list', (req, res) => {
  const id = uid(req);
  const list = req.params.list as LibraryList;
  const t = req.body?.title as TitleSummary | undefined;
  if (!id || !['watchlist', 'favorite'].includes(list) || !t?.id) return res.status(400).end();
  db.prepare('INSERT INTO library (user_id, list, title_id, title_json, added_at) VALUES (?,?,?,?,?) ON CONFLICT DO UPDATE SET title_json=excluded.title_json').run(id, list, t.id, JSON.stringify(t), Date.now());
  res.json({ ok: true });
});

personal.delete('/library/:list/:titleId', (req, res) => {
  const id = uid(req);
  if (!id) return res.status(400).end();
  db.prepare('DELETE FROM library WHERE user_id = ? AND list = ? AND title_id = ?').run(id, req.params.list, req.params.titleId);
  res.json({ ok: true });
});

personal.post('/rooms', (req, res) => {
  const id = uid(req);
  if (!id) return res.status(400).json({ error: 'userId required' });
  res.json(createRoom(id, String(req.body?.name ?? '')));
});

personal.get('/rooms', (req, res) => {
  const id = uid(req);
  if (!id) return res.status(400).end();
  res.json({ rooms: listUserRooms(id) });
});

personal.get('/rooms/:id/exists', (req, res) => res.json({ exists: roomExists(req.params.id) }));
