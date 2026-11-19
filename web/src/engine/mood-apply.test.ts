import { describe, expect, it } from 'vitest';
import type { RecItem } from '../api';
import { moodMovable, placeMood } from './mood-apply';
import { stepQueue } from '../util';

const row = (key: string, added = false) => ({ track: { key, title: key, artists: ['a'] }, rank: 0, added } as unknown as RecItem);
const keys = (xs: RecItem[]) => xs.map((x) => x.track.key);

describe('what the listening mood may move', () => {
  const items = [row('p1'), row('now'), row('a'), row('mine', true), row('b'), row('c')];
  it('never the song playing, songs before it, played songs or songs added by hand', () => {
    expect(keys(moodMovable(items, { currentKey: 'now', played: new Set(['c']) }))).toEqual(['a', 'b']);
  });
  it('everything not added or played when nothing from this list is playing', () => {
    expect(keys(moodMovable(items, { currentKey: null, played: new Set(['p1']) }))).toEqual(['now', 'a', 'b', 'c']);
  });
});

describe('putting the mood order back', () => {
  it('moves only the movable songs, in their own slots, and renumbers ranks', () => {
    const items = [row('p1'), row('now'), row('a'), row('mine', true), row('b'), row('c')];
    const out = placeMood(items, ['c', 'a', 'b']);
    expect(keys(out)).toEqual(['p1', 'now', 'c', 'mine', 'a', 'b']);
    expect(out.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('ignores songs that left the list while the answer was on its way', () => {
    const items = [row('now'), row('a'), row('b')];
    expect(keys(placeMood(items, ['gone', 'b', 'a']))).toEqual(['now', 'b', 'a']);
  });
});

describe('shuffle with a listening mood', () => {
  it('picks among the three songs that fit the mood best', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({ ...row(k), playback: { preview: 'https://x/p.mp3', embed: null } } as unknown as RecItem));
    const prefer = new Map(['f', 'e', 'd', 'c', 'b', 'a'].map((k, i) => [k, i] as const));
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const step = stepQueue(items, null, 1, new Set(), { shuffle: true, repeat: 'off', heard: new Set([`x${i}`]), rand: () => (i % 10) / 10, prefer });
      seen.add(step!.item.track.key);
    }
    expect([...seen].sort()).toEqual(['d', 'e', 'f']);
  });
});
