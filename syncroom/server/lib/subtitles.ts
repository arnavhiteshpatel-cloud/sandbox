/** Convert SubRip (SRT) — including sloppy variants like 2-digit milliseconds — to WebVTT. */
export function srtToVtt(srt: string): string {
  const text = srt.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('WEBVTT')) return text + '\n';
  const fix = (ts: string) => {
    const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
    if (!m) return ts.trim();
    const [, h = '0', mi, s, ms = '0'] = m;
    // "18,83" in sloppy SRT means 830 ms, so right-pad
    return `${h.padStart(2, '0')}:${mi.padStart(2, '0')}:${s.padStart(2, '0')}.${ms.padEnd(3, '0').slice(0, 3)}`;
  };
  const blocks = text.split(/\n{2,}/).map((block) => {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) return '';
    const [a, b] = lines[idx].split('-->');
    const rest = b.trim().split(/\s+/);
    const end = rest.shift() ?? '';
    const cue = lines.slice(idx + 1).join('\n').replace(/\{\\[^}]*\}/g, '');
    return `${fix(a)} --> ${fix(end)}${rest.length ? ' ' + rest.join(' ') : ''}\n${cue}`;
  });
  return 'WEBVTT\n\n' + blocks.filter(Boolean).join('\n\n') + '\n';
}

export function looksLikeSubtitle(text: string) {
  return /-->/.test(text.slice(0, 5000));
}
