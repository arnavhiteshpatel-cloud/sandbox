import { config } from '../config.ts';
import type { SourceKind, VerifyStatus } from '../../shared/types.ts';

export interface VerifyResult { status: VerifyStatus; detail: string; contentType?: string; sizeBytes?: number; checkedAt: number }

const MAGIC: [string, (b: Buffer) => boolean][] = [
  ['MP4/MOV (ftyp)', (b) => b.subarray(4, 8).toString('latin1') === 'ftyp'],
  ['Matroska/WebM (EBML)', (b) => b.readUInt32BE(0) === 0x1a45dfa3],
  ['Ogg', (b) => b.subarray(0, 4).toString('latin1') === 'OggS'],
  ['MPEG-TS', (b) => b[0] === 0x47 && b[188] === 0x47],
];

async function getHead(url: string, bytes: number, headers: Record<string, string> = {}) {
  // Relative URLs (our own /api/local/... streams) are checked against this server.
  if (url.startsWith('/')) url = `http://127.0.0.1:${config.port}${url}`;
  const res = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}`, 'user-agent': 'SyncRoom/0.1', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const reader = res.body?.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  if (reader) {
    while (total < bytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.length;
    }
    reader.cancel().catch(() => {});
  }
  return { res, buf: Buffer.concat(chunks) };
}

/**
 * Proves a source is actually reachable and looks like playable media by fetching real bytes.
 * A source is only ever labelled "verified" after this succeeds.
 */
export async function verifyMediaUrl(url: string, kind: SourceKind, headers: Record<string, string> = {}): Promise<VerifyResult> {
  const checkedAt = Date.now();
  try {
    if (kind === 'youtube' || kind === 'vimeo') {
      const oembed = kind === 'youtube' ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}` : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`;
      const r = await fetch(oembed, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return { status: 'failed', detail: `${kind} oEmbed ${r.status} (private, removed or not embeddable)`, checkedAt };
      return { status: 'verified', detail: `${kind} video exists and allows embedding`, checkedAt };
    }
    if (kind === 'hls' || kind === 'dash') {
      const { res, buf } = await getHead(url, 256 * 1024, headers);
      if (!res.ok) return { status: 'failed', detail: `manifest HTTP ${res.status}`, checkedAt };
      const text = buf.toString('utf8');
      if (kind === 'hls' && !text.startsWith('#EXTM3U')) return { status: 'failed', detail: 'not an HLS playlist', checkedAt };
      if (kind === 'dash' && !text.includes('<MPD')) return { status: 'failed', detail: 'not a DASH manifest', checkedAt };
      if (kind === 'hls') {
        // follow first variant / segment to make sure media is actually served
        const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        if (lines[0]) {
          const next = new URL(lines[0], res.url).toString();
          const r2 = await getHead(next, 4096, headers);
          if (!r2.res.ok) return { status: 'failed', detail: `variant/segment HTTP ${r2.res.status}`, checkedAt };
        }
      }
      return { status: 'verified', detail: `${kind.toUpperCase()} manifest and media reachable`, checkedAt };
    }
    const { res, buf } = await getHead(url, 64 * 1024, headers);
    if (!res.ok) return { status: 'failed', detail: `HTTP ${res.status}`, checkedAt };
    const ct = res.headers.get('content-type') ?? '';
    const range = res.headers.get('content-range');
    const sizeBytes = range ? Number(range.split('/')[1]) || undefined : Number(res.headers.get('content-length')) || undefined;
    if (buf.length < 512) return { status: 'failed', detail: `only ${buf.length} bytes returned`, checkedAt };
    const magic = MAGIC.find(([, test]) => { try { return test(buf); } catch { return false; } });
    if (!magic) return { status: 'failed', detail: `bytes are not a recognised video container (content-type ${ct || 'none'})`, checkedAt };
    return { status: 'verified', detail: `${magic[0]} bytes received${res.status === 206 ? ', range requests supported' : ''}`, contentType: ct, sizeBytes, checkedAt };
  } catch (e) {
    return { status: 'failed', detail: (e as Error).message, checkedAt };
  }
}
