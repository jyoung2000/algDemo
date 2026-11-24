// ARTIST-VARIETY-001 (owner, 2026-11-24): "shuffle / listening mood needs more artist variety, I was listening to a lot
// of electronic rap but only kept getting slayr music when i hearted and listen to other artist as well". Each top-up
// held the cap of two songs per artist for its own batch only, so batch after batch piled one artist up in the queue.
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import { artistLoad } from './artist-variety';
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
