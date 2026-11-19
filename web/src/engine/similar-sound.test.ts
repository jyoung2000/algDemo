import { describe, expect, it } from 'vitest';
import { DIM } from './audio';
import { isSimilarityPercent, selectSimilar, soundMatch } from './similar-sound';
const song = (key: string, title: string, artist = 'Actual Artist', duration = 201) => ({ key, title, artists: [artist], duration });
const vec = (x: number) => Float64Array.from({ length: DIM }, (_, i) => i === 0 ? x : i === 1 ? Math.sqrt(1-x*x) : 0);
describe('measured sound matches', () => {
  it('uses two actual 512-element vectors, not a genre or title guess, and reports the calibrated percentage', () => {
    expect(soundMatch(vec(1), vec(1))).toBe(100);
    expect(soundMatch(vec(1), vec(0.85))).toBe(100);
    expect(soundMatch(vec(1), vec(0.575))).toBe(50);
    expect(soundMatch(vec(1), vec(0.3))).toBe(0);
    expect(soundMatch(vec(1), null)).toBeNull();
    expect(soundMatch(new Float64Array(3), vec(1))).toBeNull();
  });
  it('enforces a real slider bound; never treats missing/NaN/metadata-only data as a match', () => {
    for (const n of [40, 70, 95]) expect(isSimilarityPercent(n)).toBe(true);
    for (const n of [0, 39, 95.5, 101, NaN, undefined, '70']) expect(isSimilarityPercent(n)).toBe(false);
    expect(() => selectSimilar(song('s', 'Seed'), [], [], 101)).toThrow(RangeError);
  });
  it('sorts by measured score, excludes the seed/queue/same recording on another provider and never repeats a recording', () => {
    const seed = song('deezer|1', 'Seed');
    const hits = [
      { track: song('audius|1', 'Match'), match: 84 },
      { track: song('bandcamp|5', 'Seed'), match: 100 },
      { track: song('ytmusic|2', 'Already'), match: 98 },
      { track: song('deezer|30', 'Other'), match: 93 },
      { track: song('soundcloud|7', 'Match'), match: 90 },
      { track: song('hearthis|9', 'Not enough'), match: 64 },
      { track: song('archive|9', 'Another'), match: NaN },
    ];
    expect(selectSimilar(seed, [song('deezer|2', 'Already')], hits, 70).map((h) => [h.track.key,h.match]))
      .toEqual([['deezer|30',93],['soundcloud|7',90],['hearthis|9',64]]); // SIMILAR-MIN-001: the third is the closest below
    expect(selectSimilar(seed, [song('deezer|2', 'Already')], hits, 70)[2]!.below).toBe(true);
    // SIMILAR-MIN-001: none reach 95%, so the three closest measured songs are added, marked below it.
    expect(selectSimilar(seed, [song('deezer|2', 'Already')], hits, 95).map((h) => [h.track.key, h.match, h.below]))
      .toEqual([['deezer|30', 93, true], ['soundcloud|7', 90, true], ['hearthis|9', 64, true]]);
  });
  it('SIMILAR-MIN-001: tops two matches up to three with the closest below, and never adds a guessed (NaN) score', () => {
    const seed = song('deezer|1', 'Seed');
    const hits = [{ track: song('a|1', 'One'), match: 91 }, { track: song('b|1', 'Two'), match: 88 }, { track: song('c|1', 'Three'), match: 52 }, { track: song('d|1', 'Four'), match: NaN }];
    expect(selectSimilar(seed, [], hits, 80).map((h) => [h.track.key, h.below ?? false])).toEqual([['a|1', false], ['b|1', false], ['c|1', true]]);
    expect(selectSimilar(seed, [], hits.slice(0, 1).concat(hits.slice(3)), 80)).toHaveLength(1);
  });
});
