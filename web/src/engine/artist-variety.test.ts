// ARTIST-VARIETY-001 (owner, 2026-11-24): "shuffle / listening mood needs more artist variety, I was listening to a lot
// of electronic rap but only kept getting slayr music when i hearted and listen to other artist as well". Each top-up
// held the cap of two songs per artist for its own batch only, so batch after batch piled one artist up in the queue.
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import { artistLoad, selectNeverDry, spreadInsert, tooClose, withRecentListens } from './artist-variety';
import { resetShuffleNextForTests, stepQueue } from '../util';
import { arrangeShuffle } from './shuffle-order';
import type { RecItem } from '../api';

const NOW = new Date('2026-11-24T00:00:00Z');
const track = (key: string, over: Partial<E.Track> = {}): E.Track => ({ key, title: key, artists: [key.split('|')[0] ?? 'a'], tags: [], provenance: [], release: null, bpm: null, ...over });
const seed = track('slayr|seed');
const rel = (key: string) => track(key, { provenance: [{ seed: seed.key, relation: 'related_song', rank: 0, source: 'ytmusic-related' }] });
const ctxOf = (over: Partial<E.Context> = {}): E.Context => ({
  seeds: [seed], vectors: new Map(), relatedArtists: new Map(),
  feedback: { track: {}, artist: {}, excluded: new Set(), hidden: new Set(), likedArtists: new Set(), events: 0 },
  impressions: {}, settings: { adventurous: 0.5, fresh: false, vocals: 'any' }, now: NOW, rankV2: true, ...over,
});

describe('a batch counts the songs of each artist already waiting (ARTIST-VARIETY-001)', () => {
  const cands = [rel('slayr|a'), rel('slayr|b'), rel('slayr|c'), rel('ken carson|x'), rel('kankan|y'), rel('summrs|z')];
  it('without any waiting songs the cap is two per artist, as before', () => {
    const chosen = E.select(E.scoreAll(cands, ctxOf()), ctxOf());
    expect(chosen.filter((s) => s.track.artists[0] === 'slayr')).toHaveLength(2);
  });
  it('an artist already holding two songs in the queue gets none in the next batch', () => {
    const ctx = ctxOf({ artistLoad: { slayr: 2 } });
    const chosen = E.select(E.scoreAll(cands, ctx), ctx);
    expect(chosen.map((s) => s.track.artists[0])).not.toContain('slayr');
    expect(chosen.length).toBe(3);
  });
  it('counts only songs still waiting, by the first-named artist', () => {
    const waiting = [{ track: { key: 'w1', artists: ['Slayr'] } }, { track: { key: 'w2', artists: ['slayr', 'Ken Carson'] } }, { track: { key: 'w3', artists: ['Kankan'] } }, { track: { key: 'h1', artists: ['summrs'] } }];
    const load = artistLoad(waiting, new Set(['h1']));
    expect(load[E.primaryArtist({ artists: ['Slayr'] })]).toBe(2);
    expect(load[E.primaryArtist({ artists: ['Kankan'] })]).toBe(1);
    expect(load[E.primaryArtist({ artists: ['summrs'] })]).toBeUndefined();
  });
  it('a queue heard through caps nobody', () => {
    expect(artistLoad([{ track: { key: 'a', artists: ['Slayr'] } }], new Set(['a']))).toEqual({});
  });
});

const row = (key: string, artist: string): RecItem => ({ track: { key, title: key, artists: [artist] }, rank: 0, reasons: [], playback: { preview: 'https://p.example/x.mp3' } } as unknown as RecItem);
const artistsOf = (xs: RecItem[]) => xs.map((x) => (x.track.artists ?? [])[0]);

describe('a new shuffle spreads the artists out (ARTIST-VARIETY-001)', () => {
  it('never puts two songs by one artist side by side while another artist could go between', () => {
    const items = [row('p', 'Slayr'), ...['1', '2', '3', '4'].map((k) => row('s' + k, 'Slayr')), row('a', 'Ken Carson'), row('b', 'Kankan'), row('c', 'summrs'), row('d', 'Lazer Dim 700')];
    for (const r0 of [0, 0.3, 0.6, 0.99]) {
      const r = arrangeShuffle(items, { playingKey: 'p', heard: new Set(['p']), order: [], reshuffle: true, rand: () => r0 });
      const seqA = artistsOf(r.items.slice(1));
      expect(seqA[0]).not.toBe('Slayr');
      for (let i = 1; i < seqA.length - 1; i++) {
        if (seqA[i] === 'Slayr') expect(seqA[i + 1]).not.toBe('Slayr');
      }
    }
  });
  it('one artist alone is still all shuffled, side by side', () => {
    const items = ['1', '2', '3'].map((k) => row(k, 'Slayr'));
    const r = arrangeShuffle(items, { playingKey: null, heard: new Set(), order: [], reshuffle: true, rand: () => 0 });
    expect(r.order.sort()).toEqual(['1', '2', '3']);
  });
});

describe('orderAll: a re-rank orders every queued song (WP1, A1/A4)', () => {
  const cands = [rel('slayr|a'), rel('slayr|b'), rel('slayr|c'), rel('slayr|d'), rel('ken carson|x'), rel('kankan|y')];
  it('returns every row, past the per-artist cap and the queue size', () => {
    const ctx = ctxOf();
    const out = E.orderAll(E.scoreAll(cands, ctx), ctx);
    expect(out.map((s) => s.track.key).sort()).toEqual(cands.map((c) => c.key).sort());
    expect(E.select(E.scoreAll(cands, ctx), ctx).filter((s) => s.track.artists[0] === 'slayr').length).toBe(2);
  });
  it('is deterministic and puts the best-valued row first', () => {
    const ctx = ctxOf();
    const sc = E.scoreAll(cands, ctx);
    const a = E.orderAll(sc, ctx).map((s) => s.track.key);
    expect(E.orderAll([...sc].reverse(), ctx).map((s) => s.track.key)).toEqual(a);
    const top = [...sc].sort((x, y) => y.final - y.exposurePenalty - (x.final - x.exposurePenalty) || (x.track.key < y.track.key ? -1 : 1))[0]!;
    expect(a[0]).toBe(top.track.key);
  });
});

// WP4 (A5, S3, S4, M3): one artist-variety rule, used everywhere.
const lcg = (seed: number) => { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); };
describe('tooClose / spreadInsert (WP4, A5/S3)', () => {
  it('tooClose looks only at the last [gap] artists', () => {
    expect(tooClose(['a', 'b', 'c'], 'b', 2)).toBe(true);
    expect(tooClose(['a', 'b', 'c'], 'a', 2)).toBe(false);
    expect(tooClose(['a'], 'a', 0)).toBe(false);
    expect(tooClose(['a'], '', 2)).toBe(false);
  });
  it('spreadInsert takes a slot whose neighbours are other artists, at [from] or later', () => {
    for (let s = 0; s < 50; s++) {
      const order = ['A1', 'B1', 'C1', 'A2', 'D1'];
      const at = spreadInsert(order, 'A9', (k) => k[0]!, lcg(s), 1);
      expect(at).toBeGreaterThanOrEqual(1);
      expect(order[at - 1]![0]).not.toBe('A');
      if (at + 1 < order.length) expect(order[at + 1]![0]).not.toBe('A');
    }
  });
  it('spreadInsert uses any slot from [from] when every slot has that artist beside it', () => {
    const order = ['A1', 'A2'];
    const at = spreadInsert(order, 'A3', (k) => k[0]!, () => 0.99, 1);
    expect(at).toBe(2);
    expect(order).toEqual(['A1', 'A2', 'A3']);
  });
});

describe('runJob artist load: songs waiting plus the last 10 listens, never dry (WP4, A5)', () => {
  it('the load adds the artists of the last 10 listens only', () => {
    const listens = [...Array.from({ length: 5 }, () => ({ artist: 'Old' })), ...Array.from({ length: 10 }, (_, i) => ({ artist: i % 2 ? 'Slayr' : 'Ken Carson' }))];
    expect(withRecentListens({ slayr: 1 }, listens)).toEqual({ slayr: 6, 'ken carson': 5 });
  });
  it('a batch under 5 songs is chosen again without the recent listens', () => {
    const calls: Record<string, number>[] = [];
    const full = { a: 3 };
    const waiting = {};
    const out = selectNeverDry((l) => { calls.push({ ...l }); return l === full ? [1, 2] : [1, 2, 3, 4, 5, 6]; }, full, waiting);
    expect(out).toHaveLength(6);
    expect(calls).toEqual([{ a: 3 }, {}]);
    expect(selectNeverDry(() => [1, 2, 3, 4, 5], full, waiting)).toHaveLength(5);
  });
  it('the escape is reachable: fewer than 10 artists, all in the recent listens, still fill the queue', () => {
    const cands = [rel('slayr|a'), rel('slayr|b'), rel('slayr|c'), rel('ken carson|x'), rel('ken carson|y'), rel('kankan|z'), rel('kankan|w')];
    const listens = Array.from({ length: 10 }, (_, i) => ({ artist: ['slayr', 'ken carson', 'kankan'][i % 3] }));
    const waiting = {};
    const full = withRecentListens(waiting, listens);
    const choose = (l: Readonly<Record<string, number>>) => { const ctx = ctxOf({ artistLoad: { ...l } }); return E.select(E.scoreAll(cands, ctx), ctx); };
    expect(choose(full).length).toBeLessThan(5);
    expect(selectNeverDry(choose, full, waiting).length).toBeGreaterThanOrEqual(5);
  });
});

describe('orderAll spaces artists (WP4, M3)', () => {
  it('skips a row whose artist is one of the last two picked while another artist is available', () => {
    const cands = [rel('slayr|a'), rel('slayr|b'), rel('slayr|c'), rel('slayr|d'), rel('ken carson|x'), rel('kankan|y')];
    const ctx = ctxOf();
    const out = E.orderAll(E.scoreAll(cands, ctx), ctx).map((s) => s.track.artists[0]!);
    expect(out).toHaveLength(cands.length);
    expect(new Set(out.slice(0, 3)).size).toBe(3);
    for (let i = 0; i < out.length; i++) {
      const lastTwo = out.slice(Math.max(0, i - 2), i);
      if (!tooClose(lastTwo, out[i]!, 2)) continue;
      // only when every row still to place was by one of the last two artists
      expect(out.slice(i).every((a) => tooClose(lastTwo, a, 2))).toBe(true);
    }
  });
});

describe('arrangeShuffle shows the song the player takes (WP4, S4)', () => {
  it('the row after the song playing is always the song stepQueue returns (400 random queues)', () => {
    const rand = lcg(7);
    for (let t = 0; t < 400; t++) {
      resetShuffleNextForTests();
      const n = 6 + Math.floor(rand() * 8);
      const items: RecItem[] = Array.from({ length: n }, (_, i) => ({ track: { key: `k${t}-${i}`, title: 'x', artists: [rand() < 0.6 ? 'A' : `Artist ${Math.floor(rand() * 3)}`] }, rank: i + 1, reasons: [], playback: { preview: '/p', embed: null, open: [] } } as unknown as RecItem));
      const heardN = 1 + Math.floor(rand() * (n - 2));
      const heard = new Set(items.slice(0, heardN).map((x) => x.track.key));
      const playing = items[heardN - 1]!.track.key;
      const recent = items.slice(0, heardN).map((x) => (x.track.artists ?? [])[0]!);
      const order = items.slice(heardN).map((x) => x.track.key).sort(() => rand() - 0.5);
      const shown = arrangeShuffle(items, { playingKey: playing, heard, order, reshuffle: false, rand, recentArtists: recent }).items;
      const at = shown.findIndex((x) => x.track.key === playing);
      const step = stepQueue(shown, playing, 1, new Set(), { shuffle: true, repeat: 'off', heard, inOrder: true, recentArtists: recent, rand });
      expect(step!.item.track.key).toBe(shown[at + 1]!.track.key);
    }
  });
});
