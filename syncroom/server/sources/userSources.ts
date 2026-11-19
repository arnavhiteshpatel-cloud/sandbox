// Sources you add yourself: any MP4/WebM/HLS/DASH URL you are entitled to play, or a YouTube / Vimeo link.
// Each is verified (real bytes / oEmbed) when added and periodically re-checked.
import type { PlaybackSource, SourceKind, SubtitleTrack } from '../../shared/types.ts';
import { db } from '../db.ts';
import { randomId } from '../lib/sign.ts';
import { caps, langName, stableId, subtitleProxyUrl, type ResolveContext, type SourceProvider } from './types.ts';
import { verifyMediaUrl, type VerifyResult } from './verify.ts';

export function detectKind(url: string): SourceKind {
  const u = new URL(url);
  if (/(^|\.)youtube(-nocookie)?\.com$|^youtu\.be$/.test(u.hostname)) return 'youtube';
  if (/(^|\.)vimeo\.com$/.test(u.hostname)) return 'vimeo';
  if (/\.m3u8$/i.test(u.pathname) || u.pathname.endsWith('/.m3u8')) return 'hls';
  if (/\.mpd$/i.test(u.pathname)) return 'dash';
  return 'file';
}

interface Row { id: string; title_id: string; media_key: string; url: string; kind: string; label: string; subtitles_json: string; verify_json: string | null; created_at: number }

export class UserSourcesProvider implements SourceProvider {
  id = 'user';
  name = 'Added links';
  description = 'Direct MP4/WebM, HLS (.m3u8), DASH (.mpd), YouTube or Vimeo links you attach to a title or episode.';
  kinds: SourceKind[] = ['file', 'hls', 'dash', 'youtube', 'vimeo'];
  requiresConfig = false;
  configFields = [];
  isConfigured() { return true; }
  async healthCheck() {}

  async add(input: { titleId: string; mediaKey: string; url: string; label?: string; subtitles?: { url: string; lang: string }[]; addedBy?: string }) {
    const url = new URL(input.url).toString();
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error('Only http(s) URLs are supported');
    const kind = detectKind(url);
    const verify = await verifyMediaUrl(url, kind);
    const id = randomId(8);
    db.prepare('INSERT INTO user_sources (id, title_id, media_key, url, kind, label, subtitles_json, added_by, verify_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id, input.titleId, input.mediaKey, url, kind, input.label?.trim() || defaultLabel(kind, url), JSON.stringify(input.subtitles ?? []), input.addedBy ?? null, JSON.stringify(verify), Date.now(),
    );
    return { id, kind, verify };
  }

  remove(id: string) {
    db.prepare('DELETE FROM user_sources WHERE id = ?').run(id);
  }

  async getAvailableSources(ctx: ResolveContext): Promise<PlaybackSource[]> {
    const key = ctx.ref.type === 'series' ? `${ctx.ref.titleId}:${ctx.season}:${ctx.episode}` : ctx.ref.titleId;
    const rows = db.prepare('SELECT * FROM user_sources WHERE media_key = ? ORDER BY created_at').all(key) as unknown as Row[];
    return rows.map((r) => {
      const kind = r.kind as SourceKind;
      const v = r.verify_json ? (JSON.parse(r.verify_json) as VerifyResult) : null;
      const subtitles: SubtitleTrack[] = (JSON.parse(r.subtitles_json) as { url: string; lang: string }[]).map((s) => ({
        id: stableId('user-sub', s.url), label: langName(s.lang || 'en'), lang: s.lang || 'en', url: subtitleProxyUrl(ctx.origin, s.url), origin: 'Added link',
      }));
      return {
        id: `user:${r.id}`,
        providerId: this.id,
        providerName: this.name,
        label: r.label,
        kind,
        url: r.url,
        qualities: [],
        subtitles,
        capabilities: caps(kind, { qualitySelection: kind === 'hls' || kind === 'dash' }),
        verify: v ? { status: v.status, checkedAt: v.checkedAt, detail: v.detail } : { status: 'unverified', checkedAt: 0 },
        match: 'user',
        adFree: kind !== 'youtube',
        notes: kind === 'youtube' ? 'YouTube may show its own ads; SyncRoom adds none. Sync is seek-based (±0.5 s).' : kind === 'vimeo' ? 'Vimeo sync is seek-based (±0.5 s).' : undefined,
      };
    });
  }
}

function defaultLabel(kind: SourceKind, url: string) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return { file: 'Direct file', hls: 'HLS stream', dash: 'DASH stream', youtube: 'YouTube', vimeo: 'Vimeo' }[kind] + ` · ${host}`;
}

export const userSources = new UserSourcesProvider();
