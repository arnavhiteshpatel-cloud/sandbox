import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSetting } from '../../server/db.ts';
import { JellyfinProvider } from '../../server/sources/jellyfin.ts';
import { PlexProvider } from '../../server/sources/plex.ts';
import { pickRenditions } from '../../server/sources/archive.ts';
import { detectKind } from '../../server/sources/userSources.ts';
import { verifyMediaUrl } from '../../server/sources/verify.ts';
import type { ResolveContext } from '../../server/sources/types.ts';

let server: http.Server;
let base = '';
const seen: string[] = [];

/** Fake media servers implementing the documented Jellyfin / Plex response shapes used by the adapters. */
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    seen.push(`${req.method} ${u.pathname}${u.search}`);
    const json = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (u.pathname === '/media.mp4') { res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1023/99999' }); const b = Buffer.alloc(1024); b.write('ftypisom', 4, 'latin1'); return res.end(b); }
    if (u.pathname === '/junk.mp4') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>' + 'x'.repeat(2000)); }
    // Jellyfin
    if (u.pathname === '/Users') return json([{ Id: 'u1', Policy: { IsAdministrator: true } }]);
    if (u.pathname === '/Items' && u.searchParams.get('AnyProviderIdEquals') === 'Imdb.tt1727587') return json({ Items: [{ Id: 'm1', Name: 'Sintel', Type: 'Movie', ProductionYear: 2010, ProviderIds: { Imdb: 'tt1727587' } }] });
    if (u.pathname === '/Items' && u.searchParams.get('Ids') === 'm1') return json({ Items: [{ Id: 'm1', Name: 'Sintel', Type: 'Movie', ProviderIds: { Imdb: 'tt1727587' }, MediaSources: [{ Id: 'ms1', Container: 'mov,mp4,m4a', RunTimeTicks: 8880000000, MediaStreams: [{ Type: 'Video', Index: 0, Height: 1080 }, { Type: 'Subtitle', Index: 2, Language: 'eng', DisplayTitle: 'English', IsTextSubtitleStream: true }, { Type: 'Subtitle', Index: 3, Language: 'eng', IsTextSubtitleStream: false }] }] }] });
    if (u.pathname === '/Items') return json({ Items: [] });
    // Plex
    if (u.pathname === '/search') return json({ MediaContainer: { Metadata: [{ ratingKey: '42', key: '/library/metadata/42', title: 'Sintel', type: 'movie', year: 2010, Guid: [{ id: 'imdb://tt1727587' }] }] } });
    if (u.pathname === '/library/metadata/42') return json({ MediaContainer: { Metadata: [{ ratingKey: '42', key: '/library/metadata/42', title: 'Sintel', type: 'movie', Media: [{ id: 1, videoResolution: '1080', container: 'mp4', Part: [{ id: 7, key: '/library/parts/7/1/file.mp4', container: 'mp4', duration: 888000, Stream: [{ id: 9, streamType: 3, key: '/library/streams/9', languageCode: 'eng', displayTitle: 'English (SRT)' }] }] }] }] } });
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const ctx: ResolveContext = { ref: { titleId: 'tt1727587', type: 'movie' }, type: 'movie', imdbId: 'tt1727587', title: 'Sintel', year: 2010, origin: '' };

describe('Jellyfin adapter (contract test against a fake server)', () => {
  it('matches by IMDb id and offers direct play + HLS transcode with text subtitles only', async () => {
    setSetting('provider.jellyfin', { url: base, apiKey: 'KEY' });
    const p = new JellyfinProvider();
    expect(p.isConfigured()).toBe(true);
    const s = await p.getAvailableSources(ctx);
    expect(s.map((x) => x.kind)).toEqual(['file', 'hls']);
    expect(s[0].url).toBe(`${base}/Videos/m1/stream?static=true&mediaSourceId=ms1&api_key=KEY`);
    expect(s[1].url).toContain('/Videos/m1/master.m3u8?mediaSourceId=ms1&api_key=KEY&VideoCodec=h264');
    expect(s[0].subtitles).toHaveLength(1); // image-based subtitle stream excluded
    expect(decodeURIComponent(s[0].subtitles[0].url)).toContain('/Videos/m1/ms1/Subtitles/2/0/Stream.vtt');
    expect(s[0].durationSec).toBe(888);
    expect(s[0].match).toBe('exact-id');
  });
});

describe('Plex adapter (contract test against a fake server)', () => {
  it('matches by imdb:// guid and builds direct + transcode URLs with the token', async () => {
    setSetting('provider.plex', { url: base, token: 'TOK' });
    const s = await new PlexProvider().getAvailableSources(ctx);
    expect(s.map((x) => x.kind)).toEqual(['file', 'hls']);
    expect(s[0].url).toBe(`${base}/library/parts/7/1/file.mp4?X-Plex-Token=TOK`);
    expect(s[1].url).toContain('/video/:/transcode/universal/start.m3u8?');
    expect(s[0].subtitles[0].label).toBe('English (SRT)');
  });
});

describe('verification', () => {
  it('marks real MP4 bytes as verified and HTML as failed', async () => {
    expect((await verifyMediaUrl(`${base}/media.mp4`, 'file')).status).toBe('verified');
    const bad = await verifyMediaUrl(`${base}/junk.mp4`, 'file');
    expect(bad.status).toBe('failed');
    expect(bad.detail).toMatch(/not a recognised video container/);
    expect((await verifyMediaUrl(`${base}/missing.mp4`, 'file')).status).toBe('failed');
  });
  it('detects source kinds from URLs', () => {
    expect(detectKind('https://youtu.be/abc')).toBe('youtube');
    expect(detectKind('https://vimeo.com/76979871')).toBe('vimeo');
    expect(detectKind('https://x.y/a/master.m3u8')).toBe('hls');
    expect(detectKind('https://x.y/a/.m3u8')).toBe('hls');
    expect(detectKind('https://x.y/manifest.mpd')).toBe('dash');
    expect(detectKind('https://x.y/movie.mp4')).toBe('file');
  });
});

describe('Internet Archive renditions', () => {
  it('groups derivatives under their original and prefers the highest-resolution MP4', () => {
    const r = pickRenditions({ files: [
      { name: 'film.avi', format: 'Cinepack', source: 'original', length: '5400' },
      { name: 'film.mp4', format: 'h.264', source: 'derivative', original: 'film.avi', height: '480', length: '5400' },
      { name: 'film_512kb.mp4', format: '512Kb MPEG4', source: 'derivative', original: 'film.avi', height: '240' },
      { name: 'trailer.mp4', format: 'h.264', source: 'original', length: '120' },
    ] }, 'x');
    expect(r).toHaveLength(2);
    const film = r.find((x) => x.key === 'film.avi')!;
    expect(film.files.map((f) => f.name)).toEqual(['film.mp4', 'film_512kb.mp4']);
    expect(film.duration).toBe(5400);
  });
});
