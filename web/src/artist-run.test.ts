// ARTIST-RUN-001 (owner, 2026-11-24): "On shuffle ensure the same artist cant be played more than 4 times in a row on
// the discover tab if the discover / now playing queue has multiple artist".
import { beforeEach, describe, expect, it } from 'vitest';
import { resetShuffleNextForTests, stepQueue } from './util';
import { MAX_ARTIST_RUN, runArtist } from './engine/artist-variety';
import type { RecItem } from './api';

const row = (key: string, artist: string): RecItem => ({ track: { key, title: key, artists: [artist] }, rank: 0, reasons: [], playback: { kind: 'preview', preview: `https://p.test/${key}.mp3`, open: [] } } as unknown as RecItem);
const opts = (recent: string[], inOrder = true) => ({ shuffle: true, repeat: 'off' as const, heard: new Set<string>(), inOrder, recentArtists: recent, rand: () => 0 });

beforeEach(() => resetShuffleNextForTests());

describe('no artist plays more than four times in a row under shuffle (ARTIST-RUN-001)', () => {
  it('the limit is four', () => expect(MAX_ARTIST_RUN).toBe(4));
  it('after four songs by one artist the next is by another, even if the order says otherwise', () => {
    const items = [row('p', 'Slayr'), row('s5', 'Slayr'), row('s6', 'Slayr'), row('k', 'Ken Carson')];
    const r = stepQueue(items, 'p', 1, new Set(), opts(['Slayr', 'Slayr', 'Slayr', 'Slayr']));
    expect(r?.item.track.key).toBe('k');
  });
  it('three in a row may still be followed by a fourth', () => {
    const items = [row('p', 'Slayr'), row('s5', 'Slayr'), row('k', 'Ken Carson')];
    expect(stepQueue(items, 'p', 1, new Set(), opts(['Ken Carson', 'Slayr', 'Slayr', 'Slayr']))?.item.track.key).toBe('s5');
  });
  it('with only that artist left, the queue carries on with them', () => {
    const items = [row('p', 'Slayr'), row('s5', 'Slayr')];
    expect(stepQueue(items, 'p', 1, new Set(), opts(['Slayr', 'Slayr', 'Slayr', 'Slayr']))?.item.track.key).toBe('s5');
  });
  it('holds for a random draw too, and names artists however they are spelt', () => {
    const items = [row('p', 'SLAYR'), row('s5', 'slayr'), row('s6', 'Slayr'), row('k', 'Ken Carson')];
    for (const r0 of [0, 0.5, 0.99]) {
      resetShuffleNextForTests();
      const r = stepQueue(items, 'p', 1, new Set(), { ...opts(['Slayr', 'slayr', 'SLAYR', 'Slayr'], false), rand: () => r0 });
      expect(r?.item.track.key).toBe('k');
    }
  });
  it('runArtist names the artist of a run of four or more, else nothing', () => {
    expect(runArtist(['A', 'B', 'B', 'B', 'B'])).toBe(runArtist(['B', 'B', 'B', 'B']));
    expect(runArtist(['B', 'B', 'B', 'B'])).not.toBe('');
    expect(runArtist(['B', 'B', 'A', 'B'])).toBe('');
    expect(runArtist(['B', 'B', 'B'])).toBe('');
  });
});
