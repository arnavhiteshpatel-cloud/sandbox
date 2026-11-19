import { Router } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import { config } from '../config.ts';
import { cached, DAY } from '../lib/http.ts';
import { checkSig } from '../lib/sign.ts';
import { looksLikeSubtitle, srtToVtt } from '../lib/subtitles.ts';
import { localLibrary } from '../sources/localLibrary.ts';
import { openSubtitlesDownload } from '../sources/opensubtitles.ts';
import { providerConfigView, providerInfo, providers, runHealthChecks, setProviderConfig } from '../sources/registry.ts';
import { userSources } from '../sources/userSources.ts';
import { metadata } from '../metadata/index.ts';
import { db, setSetting, getSetting } from '../db.ts';

export const media = Router();

// ---- local files with HTTP range support (required for seeking + sync)
media.get('/local/stream/:id', (req, res) => {
  const f = localLibrary.file(req.params.id);
  if (!f || !fs.existsSync(f.abs)) return res.status(404).end();
  const size = fs.statSync(f.abs).size;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
    if (start >= size || start > end) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
    end = Math.min(end, size - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f.abs, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', String(size));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(f.abs).pipe(res);
  }
});

media.get('/local/subtitle/:id', (req, res) => {
  const s = localLibrary.subtitle(req.params.id);
  if (!s) return res.status(404).end();
  res.type('text/vtt').send(srtToVtt(fs.readFileSync(s.abs, 'utf8')));
});

media.get('/local/library', (_req, res) => {
  const files = localLibrary.scan();
  res.json({ dir: localLibrary.dir(), exists: fs.existsSync(localLibrary.dir()), files: files.map((f) => ({ id: f.id, rel: f.rel, size: f.size, parsed: f.parsed, subtitles: f.subtitles.map((s) => s.lang) })) });
});
media.post('/local/rescan', (_req, res) => res.json({ count: localLibrary.scan(true).length }));

// ---- subtitles: fetched server-side (no CORS issues), SRT → WebVTT, cached. Signed URLs only.
media.get('/subtitles/proxy', async (req, res) => {
  const url = String(req.query.url ?? '');
  if (!/^https?:\/\//.test(url) || !checkSig(url, req.query.sig as string)) return res.status(403).send('bad signature');
  try {
    const vtt = await cached(`sub:${url}`, 7 * DAY, async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
      if (!r.ok) throw new Error(`subtitle HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 4_000_000) throw new Error('subtitle too large');
      let text = buf.toString('utf8');
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
      if (!looksLikeSubtitle(text)) throw new Error('not a subtitle file');
      return srtToVtt(text);
    });
    res.type('text/vtt').setHeader('Cache-Control', 'public, max-age=86400');
    res.send(vtt);
  } catch (e) {
    res.status(502).send((e as Error).message);
  }
});

media.get('/subtitles/opensubtitles/:fileId', async (req, res) => {
  if (!checkSig(req.params.fileId, req.query.sig as string)) return res.status(403).end();
  try {
    const vtt = await cached(`os:file:${req.params.fileId}`, 30 * DAY, async () => srtToVtt(await openSubtitlesDownload(req.params.fileId)));
    res.type('text/vtt').send(vtt);
  } catch (e) {
    res.status(502).send((e as Error).message);
  }
});

// ---- user-added links
media.post('/user-sources', async (req, res) => {
  const { titleId, mediaKey, url, label, subtitles, userId } = req.body ?? {};
  if (!titleId || !mediaKey || !url) return res.status(400).json({ error: 'titleId, mediaKey and url are required' });
  try {
    res.json(await userSources.add({ titleId, mediaKey, url, label, subtitles, addedBy: userId }));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});
media.delete('/user-sources/:id', (req, res) => { userSources.remove(req.params.id); res.json({ ok: true }); });

// ---- providers / settings
media.get('/providers', (_req, res) => {
  res.json({
    providers: providerInfo().map((p) => ({ ...p, config: providerConfigView(p.id) })),
    metadata: { id: metadata().id, name: metadata().name, attribution: metadata().attribution, tmdbConfigured: !!(getSetting('tmdb.key', '') || config.tmdbKey) },
  });
});
media.put('/providers/:id', async (req, res) => {
  const known = [...providers.map((p) => p.id), 'opensubtitles'];
  if (!known.includes(req.params.id)) return res.status(404).end();
  setProviderConfig(req.params.id, req.body ?? {});
  if (req.params.id === 'local') localLibrary.scan(true);
  db.prepare('DELETE FROM source_cache WHERE provider = ?').run(req.params.id);
  await runHealthChecks().catch(() => {});
  res.json({ ok: true, provider: providerInfo().find((p) => p.id === req.params.id) });
});
media.put('/settings/tmdb', (req, res) => {
  setSetting('tmdb.key', String(req.body?.key ?? '').trim());
  res.json({ ok: true, provider: metadata().id });
});
media.post('/providers/health', async (_req, res) => { await runHealthChecks(); res.json({ providers: providerInfo() }); });

// ---- network info for invitation links (LAN addresses so a partner on the same Wi‑Fi can join)
media.get('/network', (req, res) => {
  const port = req.get('host')?.split(':')[1] ?? String(config.port);
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i!.address}:${port}`);
  res.json({ publicUrl: config.publicUrl ?? null, lan });
});

media.get('/stats', (_req, res) => {
  const p = db.prepare('SELECT COUNT(DISTINCT title_id) AS titles, COUNT(DISTINCT media_key) AS units FROM playable_index').get() as { titles: number; units: number };
  const byProvider = db.prepare('SELECT provider, COUNT(DISTINCT media_key) AS units FROM playable_index GROUP BY provider').all();
  const cachedMeta = db.prepare("SELECT COUNT(*) AS n FROM meta_cache WHERE key LIKE 'cm:%meta%' OR key LIKE 'tmdb:/movie/%' OR key LIKE 'tmdb:/tv/%'").get() as { n: number };
  res.json({ playable: p, byProvider, cachedTitleRecords: cachedMeta.n, localFiles: localLibrary.scan().length });
});
