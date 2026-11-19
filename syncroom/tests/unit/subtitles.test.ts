import { describe, expect, it } from 'vitest';
import { srtToVtt } from '../../server/lib/subtitles.ts';
import { activeCues, parseVtt } from '../../web/src/player/subtitles.ts';

describe('subtitles', () => {
  it('converts SRT to WebVTT, fixing comma decimals and sloppy 2-digit milliseconds', () => {
    const vtt = srtToVtt('﻿1\r\n00:00:18,83 --> 00:00:25,24\r\nPoor poor.\r\n\r\n2\r\n00:01:02,500 --> 00:01:04,000\r\n<i>Hello</i>\r\n');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:18.830 --> 00:00:25.240');
    expect(vtt).toContain('00:01:02.500 --> 00:01:04.000');
  });
  it('passes WebVTT through unchanged', () => {
    expect(srtToVtt('WEBVTT\n\n00:00.000 --> 00:01.000\nx')).toContain('00:00.000 --> 00:01.000');
  });
  it('parses cues and finds active ones by time (with overlaps)', () => {
    const cues = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nA\n\n00:00:03.000 --> 00:00:05.000\n<c.yellow>B</c>\n\n00:00:10.000 --> 00:00:11.000\nC');
    expect(cues).toHaveLength(3);
    expect(cues[1].text).toBe('B');
    expect(activeCues(cues, 3.5).map((c) => c.text)).toEqual(['A', 'B']);
    expect(activeCues(cues, 7)).toEqual([]);
    expect(activeCues(cues, 10.5).map((c) => c.text)).toEqual(['C']);
  });
});
