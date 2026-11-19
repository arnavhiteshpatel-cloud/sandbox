export interface Cue { start: number; end: number; text: string }

function ts(s: string): number {
  const m = s.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** Parse WebVTT (or SRT) into cues. Tags other than <i>/<b>/<u> are stripped. */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, rest] = lines[i].split('-->');
    const start = ts(a), end = ts(rest);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const body = lines.slice(i + 1).join('\n').replace(/<(?!\/?(i|b|u)>)[^>]+>/g, '').trim();
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Binary search for cues active at time t. */
export function activeCues(cues: Cue[], t: number): Cue[] {
  let lo = 0, hi = cues.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].start <= t) lo = mid + 1; else hi = mid; }
  const out: Cue[] = [];
  for (let k = lo - 1; k >= 0 && k >= lo - 8; k--) if (cues[k].end > t) out.unshift(cues[k]);
  return out;
}

const cache = new Map<string, Promise<Cue[]>>();
export function loadCues(url: string): Promise<Cue[]> {
  if (!cache.has(url)) {
    cache.set(url, fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Subtitles unavailable (${r.status})`);
      return parseVtt(await r.text());
    }).catch((e) => { cache.delete(url); throw e; }));
  }
  return cache.get(url)!;
}
