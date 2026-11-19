import { describe, expect, it } from 'vitest';
import { parseMediaName } from '../../server/sources/localLibrary.ts';

describe('parseMediaName', () => {
  it.each([
    ['Night of the Living Dead (1968).mp4', { kind: 'movie', title: 'Night of the Living Dead', year: 1968 }],
    ['Movies/Sintel (2010) [tt1727587]/Sintel (2010) [tt1727587].mp4', { kind: 'movie', title: 'Sintel', year: 2010, imdbId: 'tt1727587' }],
    ['His.Girl.Friday.1940.1080p.BluRay.x264.mkv', { kind: 'movie', title: 'His Girl Friday', year: 1940 }],
    ['3 Idiots (2009) {imdb-tt1187043}.mp4', { kind: 'movie', title: '3 Idiots', year: 2009, imdbId: 'tt1187043' }],
    ['TV/Sherlock Holmes (1954)/Season 1/Sherlock Holmes - S01E02 - The Case of Lady Beryl.mp4', { kind: 'episode', title: 'Sherlock Holmes', year: 1954, season: 1, episode: 2 }],
    ['Breaking.Bad.S05E14.720p.WEB-DL.mkv', { kind: 'episode', title: 'Breaking Bad', season: 5, episode: 14 }],
    ['Show Name/Season 2/S02E03.mp4', { kind: 'episode', title: 'Show Name', season: 2, episode: 3 }],
    ['The Office 2x05.mp4', { kind: 'episode', title: 'The Office', season: 2, episode: 5 }],
  ])('%s', (path, want) => {
    expect(parseMediaName(path)).toMatchObject(want);
  });
});
