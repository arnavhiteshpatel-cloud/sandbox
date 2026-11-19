// Your own media files. Point SyncRoom at a folder (Settings → Sources, or SYNCROOM_MEDIA_DIR) and files are
// matched to catalogue titles by name, year, SxxEyy, or an explicit IMDb tag such as "[tt0063350]" / "{imdb-tt0063350}".
// Files are streamed by this server with HTTP range support, so every room participant can play them.
import fs from 'node:fs';
import path from 'node:path';
import type { PlaybackSource, SubtitleTrack } from '../../shared/types.ts';
import { config } from '../config.ts';
import { getSetting } from '../db.ts';
import { caps, langName, stableId, type ProviderSearchHit, type ResolveContext, type SourceProvider } from './types.ts';

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv']);
const SUB_EXT = new Set(['.srt', '.vtt']);
const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg' };

export interface ParsedName {
  kind: 'movie' | 'episode';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
  imdbId?: string;
}

const JUNK = /\b(2160p|1080p|720p|480p|4k|uhd|hdr|bluray|blu ray|brrip|bdrip|web ?dl|webrip|web|hdtv|dvdrip|x264|x265|h264|h 264|hevc|aac|ac3|dts|remux|proper|repack|extended|unrated|imax)\b.*$/i;

function clean(s: string) {
  return s.replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ').replace(/[._]+/g, ' ').replace(JUNK, ' ').replace(/[-–\s(]+$/, '').replace(/\s+/g, ' ').trim();
}

/** Parse a relative path like "Movies/Night of the Living Dead (1968).mp4" or "Show/Season 1/Show - S01E02 - Name.mkv". */
export function parseMediaName(relPath: string): ParsedName | null {
  const parts = relPath.split(/[\\/]/);
  const file = parts.pop()!;
  const base = file.replace(/\.[^.]+$/, '');
  const imdb = relPath.match(/\b(tt\d{6,9})\b/)?.[1];
  const se = base.match(/^(.*?)[\s._-]*\b[Ss](\d{1,2})[\s._-]?[Ee](\d{1,3})\b/) ?? base.match(/^(.*?)[\s._-]*\b(\d{1,2})x(\d{2,3})\b/);
  if (se) {
    let title = clean(se[1]);
    if (!title) {
      const parent = [...parts].reverse().find((p) => !/^(season|series|s)\s*\d+$/i.test(p.trim()) && !/^specials?$/i.test(p.trim()));
      title = parent ? clean(parent.replace(/\((19|20)\d{2}\)/, '')) : '';
    }
    const year = Number(se[1].match(/\b(19|20)\d{2}\b/)?.[0]) || Number(parts.join(' ').match(/\((19|20)\d{2}\)/)?.[0]?.slice(1, 5)) || undefined;
    if (!title) return null;
    return { kind: 'episode', title: title.replace(/\s*\(?(19|20)\d{2}\)?$/, '').trim(), year, season: Number(se[2]), episode: Number(se[3]), imdbId: imdb };
  }
  const ym = base.match(/^(.*?)[\s._([-]+((?:19|20)\d{2})(?:[\s._)\]-]|$)/);
  if (ym && clean(ym[1])) return { kind: 'movie', title: clean(ym[1]), year: Number(ym[2]), imdbId: imdb };
  const title = clean(base);
  return title ? { kind: 'movie', title, imdbId: imdb } : null;
}

export interface LocalFile {
  id: string;
  abs: string;
  rel: string;
  size: number;
  mime: string;
  parsed: ParsedName;
  subtitles: { id: string; abs: string; lang: string }[];
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/^(the|a|an) /, '').trim();

export class LocalLibraryProvider implements SourceProvider {
  id = 'local';
  name = 'My Media Folder';
  description = 'Video files on this computer (MP4/WebM/MOV; MKV in Chromium browsers). Streamed by your SyncRoom server to everyone in the room.';
  kinds = ['file' as const];
  requiresConfig = false;
  configFields = [{ key: 'mediaDir', label: 'Media folder path', placeholder: config.mediaDir, help: 'Absolute path. Movies as "Title (Year).mp4", episodes as "Show - S01E02.mp4". Sidecar .srt/.vtt subtitles are picked up automatically.' }];
  private files = new Map<string, LocalFile>();
  private subs = new Map<string, { abs: string }>();
  private scannedAt = 0;
  private scannedDir = '';

  dir() {
    return getSetting<{ mediaDir?: string }>('provider.local', {}).mediaDir || config.mediaDir;
  }
  isConfigured() {
    return fs.existsSync(this.dir());
  }
  async healthCheck() {
    await fs.promises.access(this.dir(), fs.constants.R_OK);
  }

  scan(force = false) {
    const dir = this.dir();
    if (!force && dir === this.scannedDir && Date.now() - this.scannedAt < 60_000) return [...this.files.values()];
    this.files.clear();
    this.subs.clear();
    this.scannedDir = dir;
    this.scannedAt = Date.now();
    if (!fs.existsSync(dir)) return [];
    const walk = (d: string, depth: number) => {
      if (depth > 6) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      const subsHere = entries.filter((e) => e.isFile() && SUB_EXT.has(path.extname(e.name).toLowerCase()));
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs, depth + 1); continue; }
        const ext = path.extname(e.name).toLowerCase();
        if (!VIDEO_EXT.has(ext)) continue;
        const rel = path.relative(dir, abs);
        const parsed = parseMediaName(rel);
        if (!parsed) continue;
        const stem = e.name.slice(0, -ext.length).toLowerCase();
        const subtitles = subsHere
          .filter((s) => s.name.toLowerCase().startsWith(stem))
          .map((s) => {
            const extra = s.name.slice(stem.length, -path.extname(s.name).length).replace(/^[._-]/, '');
            const lang = (extra.match(/^([a-z]{2,3})\b/i)?.[1] ?? 'en').toLowerCase();
            const sabs = path.join(d, s.name);
            const id = stableId('local-sub', sabs);
            this.subs.set(id, { abs: sabs });
            return { id, abs: sabs, lang };
          });
        const id = stableId('local', abs);
        this.files.set(id, { id, abs, rel, size: fs.statSync(abs).size, mime: MIME[ext] ?? 'video/mp4', parsed, subtitles });
      }
    };
    walk(dir, 0);
    return [...this.files.values()];
  }

  file(id: string) {
    if (!this.files.size) this.scan();
    return this.files.get(id);
  }
  subtitle(id: string) {
    if (!this.subs.size) this.scan();
    return this.subs.get(id);
  }

  async search(query: string): Promise<ProviderSearchHit[]> {
    const q = norm(query);
    return this.scan()
      .filter((f) => norm(f.parsed.title).includes(q))
      .map((f) => ({ providerItemId: f.id, title: f.parsed.title, year: f.parsed.year, imdbId: f.parsed.imdbId, type: f.parsed.kind === 'episode' ? ('series' as const) : ('movie' as const) }));
  }

  matches(f: LocalFile, ctx: ResolveContext) {
    const p = f.parsed;
    if (ctx.type === 'movie' && p.kind !== 'movie') return false;
    if (ctx.type === 'series' && (p.kind !== 'episode' || p.season !== ctx.season || p.episode !== ctx.episode)) return false;
    if (p.imdbId && ctx.imdbId) return p.imdbId === ctx.imdbId;
    if (norm(p.title) !== norm(ctx.title)) return false;
    if (p.year && ctx.year && Math.abs(p.year - ctx.year) > 1) return false;
    return true;
  }

  async getAvailableSources(ctx: ResolveContext): Promise<PlaybackSource[]> {
    return this.scan()
      .filter((f) => this.matches(f, ctx))
      .map((f) => {
        const subtitles: SubtitleTrack[] = f.subtitles.map((s) => ({ id: s.id, label: langName(s.lang), lang: s.lang, url: `${ctx.origin}/api/local/subtitle/${s.id}`, origin: 'Sidecar file' }));
        const isMkv = f.mime === 'video/x-matroska';
        return {
          id: `local:${f.id}`,
          providerId: this.id,
          providerName: this.name,
          label: `My media · ${path.basename(f.rel)}`,
          kind: 'file' as const,
          url: `${ctx.origin}/api/local/stream/${f.id}`,
          mimeType: f.mime,
          qualities: [],
          subtitles,
          capabilities: caps('file'),
          verify: { status: 'unverified' as const, checkedAt: 0 },
          match: f.parsed.imdbId ? ('exact-id' as const) : ('title-year' as const),
          adFree: true,
          license: 'Your own file',
          notes: isMkv ? 'MKV plays in Chrome/Edge/Firefox only when the codecs are H.264/VP9/AV1 + AAC/Opus. Remux to MP4 for Safari.' : undefined,
          sizeBytes: f.size,
        };
      });
  }
}

export const localLibrary = new LocalLibraryProvider();
