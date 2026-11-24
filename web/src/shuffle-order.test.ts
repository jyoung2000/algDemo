// SHUFFLE-ORDER-001 (owner, 2026-11-20): "Now playing queue should be accurate even if shuffle is turned on, shuffle
// should still shuffle the song when enabled but now playing queue is supposed to properly and accurately display song
// order". Shuffle used to pick each next song only when it was needed, so the queue could not show the order. Now the
// songs still to come get one shuffled order (mood-weighted) that the queue shows and playback walks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { arrangeShuffle, restoreOrder } from './engine/shuffle-order';
import { stepQueue } from './util';
import type { RecItem } from './api';

const row = (key: string, extra: Partial<RecItem> = {}): RecItem => ({ track: { key, title: key } as never, rank: 0, reasons: [], playback: { preview: 'https://p.example/x.mp3' } as never, ...extra }) as RecItem;
const keys = (xs: RecItem[]) => xs.map((x) => x.track.key);
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]!; };
const base = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => row(k));

describe('arrangeShuffle', () => {
  it('a new shuffle: songs heard above, the song playing, then every other song once in a shuffled order', () => {
    const r = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['a', 'c']), order: [], reshuffle: true, rand: seq(0.9, 0.1, 0.5, 0.3) });
    expect(keys(r.items).slice(0, 2)).toEqual(['a', 'c']);
    expect([...keys(r.items).slice(2)].sort()).toEqual(['b', 'd', 'e', 'f']);
    expect(keys(r.items).slice(2)).not.toEqual(['b', 'd', 'e', 'f']); // shuffled, not the list order
    expect(r.order).toEqual(keys(r.items).slice(2));
    expect(r.items.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('keeps its order once made: the same list again is left exactly as it is', () => {
    const a = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['c']), order: [], reshuffle: true, rand: seq(0.7, 0.2, 0.9, 0.4, 0.1) });
    const b = arrangeShuffle(a.items, { playingKey: 'c', heard: new Set(['c']), order: a.order, reshuffle: false, rand: seq(0.5) });
    expect(b.items).toBe(a.items);
  });
  it('a reordered list (a re-rank answer) is put back into the shuffled order', () => {
    const a = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['c']), order: [], reshuffle: true, rand: seq(0.7, 0.2, 0.9, 0.4, 0.1) });
    const b = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['c']), order: a.order, reshuffle: false, rand: seq(0.5) });
    expect(keys(b.items)).toEqual(keys(a.items));
  });
  it('songs found later are mixed in, never in front of the song already shown next', () => {
    const a = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['c']), order: [], reshuffle: true, rand: seq(0.7, 0.2, 0.9, 0.4, 0.1) });
    const more = [...a.items, row('g'), row('h')];
    const b = arrangeShuffle(more, { playingKey: 'c', heard: new Set(['c']), order: a.order, reshuffle: false, rand: seq(0) });
    expect(b.order[0]).toBe(a.order[0]);
    expect([...b.order].sort()).toEqual(['a', 'b', 'd', 'e', 'f', 'g', 'h']);
  });
  it('a song added by hand plays right after the song playing', () => {
    const a = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['c']), order: [], reshuffle: true, rand: seq(0.7, 0.2, 0.9, 0.4, 0.1) });
    const at = a.items.findIndex((x) => x.track.key === 'c');
    const withMine = [...a.items.slice(0, at + 1), row('mine', { added: true } as never), ...a.items.slice(at + 1)];
    const b = arrangeShuffle(withMine, { playingKey: 'c', heard: new Set(['c']), order: a.order, reshuffle: false, rand: seq(0.99) });
    expect(b.order[0]).toBe('mine');
  });
  it('songs a custom discovery found (also marked added) are shuffled like the rest, not kept first in list order', () => {
    const xs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((k) => row(k, { added: true } as never));
    const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const r = arrangeShuffle(xs, { playingKey: 'a', heard: new Set(['a']), order: [], reshuffle: true, rand: lcg(7) });
    expect(r.order).not.toEqual(['b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
  it('the next song shown is one that can play now (a song still downloading waits further down)', () => {
    const a = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['c']), order: ['b', 'd', 'e', 'f', 'a'], reshuffle: false, rand: seq(0), ready: (x) => x.track.key !== 'b' });
    expect(a.order[0]).toBe('d');
    expect(a.order).toContain('b');
  });
  it('songs hidden by the listener go to the end and are never shown next', () => {
    const a = arrangeShuffle(base(), { playingKey: 'c', heard: new Set(['c']), order: [], reshuffle: true, rand: seq(0.1), hidden: new Set(['a']) });
    expect(keys(a.items).at(-1)).toBe('a');
    expect(a.order).not.toContain('a');
  });
});

describe('a mood-weighted shuffle is still a shuffle', () => {
  // The Discover list is already sorted by mood fit, so a draw as steep as the one-song pick (up to e^6.5 ≈ 650x)
  // rebuilt nearly the same list (measured on Windows: shuffle on left the songs to come in list order).
  const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const n = 20;
  const rows = Array.from({ length: n }, (_, i) => row(`s${i}`));
  const fit = new Map(rows.map((x, i) => [x.track.key, 1 - i / n] as const));
  const orders = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => arrangeShuffle(rows, { playingKey: null, heard: new Set(), order: [], reshuffle: true, rand: lcg(seed), mood: { fit, confidence: 1, adventurous: 0.5 } }).order);
  it('the order differs from the mood order in most places', () => {
    for (const o of orders) expect(o.filter((k, i) => k !== `s${i}`).length).toBeGreaterThanOrEqual(n * 0.6);
  });
  it('songs that fit the mood still tend to come sooner', () => {
    const avg = (ks: string[]) => ks.reduce((t, k) => t + orders.reduce((u, o) => u + o.indexOf(k), 0) / orders.length, 0) / ks.length;
    expect(avg(['s0', 's1', 's2', 's3', 's4'])).toBeLessThan(avg(['s15', 's16', 's17', 's18', 's19']));
  });
});

describe('turning shuffle off', () => {
  it('puts the list back in its own order; songs that arrived meanwhile keep their places after it', () => {
    const shuffled = ['d', 'a', 'f', 'c', 'g', 'b', 'e'].map((k) => row(k));
    expect(keys(restoreOrder(shuffled, ['a', 'b', 'c', 'd', 'e', 'f']))).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
});

describe('playback walks the order the queue shows', () => {
  it('stepQueue with inOrder plays the first unheard song in list order, never a random one', () => {
    const items = ['a', 'c', 'f', 'b', 'e', 'd'].map((k) => row(k));
    for (let i = 0; i < 5; i++) {
      const s = stepQueue(items, 'c', 1, new Set(), { shuffle: true, repeat: 'off' as never, heard: new Set(['a', 'c']), inOrder: true, rand: Math.random });
      expect(s?.item.track.key).toBe('f');
    }
  });
});

describe('an earlier random pick never overrides the order shown', () => {
  it('a pick remembered from before (same song playing, same round) is ignored once the queue holds the order', () => {
    const items = ['c', 'a', 'b', 'd', 'e'].map((k) => row(k));
    const heard = new Set(['c']);
    const opts = { shuffle: true, repeat: 'off' as never, heard };
    const random = stepQueue(items, 'c', 1, new Set(), { ...opts, rand: () => 0.99 });
    expect(random?.item.track.key).toBe('e');
    expect(stepQueue(items, 'c', 1, new Set(), { ...opts, inOrder: true, rand: () => 0.99 })?.item.track.key).toBe('a');
  });
});

describe('the Discover queue uses it', () => {
  const app = readFileSync(resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
  it('arranges the queue whenever shuffle, the list, the song playing or a new round changes', () => {
    expect(app).toMatch(/SHUFFLE-ORDER-001[\s\S]{0,1200}arrangeShuffle\(result\.items, \{/);
    expect(app).toMatch(/\}, \[discoverShuffle, result\?\.items, playingKey, shuffleEpoch, readySignature, hidden, heardOnRecord\]\);/);
  });
  it('playback follows the shown order, and the mood does not re-order a shuffled queue', () => {
    expect(app).toMatch(/inOrder: discoverShuffle/);
    expect(app).toMatch(/if \(!moodQueueScope \|\| discoverShuffleRef\.current\) return;/);
  });
});
