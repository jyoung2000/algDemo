/**
 * WP5 (S1, S2, S8; decision D3): the mood leans on a shuffle without sorting it, and an active signal (star, dislike,
 * Find similar) re-deals the unheard tail of a kept shuffled order on the next mood answer, inside arrangeShuffle.
 */
import { describe, expect, it } from 'vitest';
import type { RecItem } from '../api';
import { arrangeShuffle } from './shuffle-order';
import { moodShufflePick } from './mood-shuffle';
import { rowArtist } from './artist-variety';
import { row, seeded } from './quality/fixtures';

const keyOf = (x: RecItem) => x.track.key;
const pairs = (xs: readonly RecItem[]) => xs.slice(1).filter((x, i) => rowArtist(x.track) === rowArtist(xs[i]!.track)).length;

describe('WP5 (D3): moodShufflePick caps the best-to-worst weight ratio', () => {
  const share = (adventurous: number) => {
    const fit = new Map([['good', 1], ['bad', 0]]);
    const rand = seeded(5);
    let good = 0;
    const n = 9000;
    for (let i = 0; i < n; i++) if (moodShufflePick(['good', 'bad'], (k) => k, fit, { adventurous, confidence: 1, rand }) === 'good') good++;
    return good / n;
  };
  it('Familiar 8, middle 4, Adventurous 2 (a fit-1 song against a fit-0 song)', () => {
    expect(share(0)).toBeCloseTo(8 / 9, 1);
    expect(share(0.5)).toBeCloseTo(4 / 5, 1);
    expect(share(1)).toBeCloseTo(2 / 3, 1);
  });
  it('linear between: a quarter of the way is a ratio of 6', () => {
    expect(share(0.25)).toBeCloseTo(6 / 7, 1);
  });
});

describe('WP5 (S8): re-dealing the unheard tail of a kept order', () => {
  // A song playing and 12 to come, 13 artists, so the artist rule never moves a song.
  const items = [row('p', 'P'), ...Array.from({ length: 12 }, (_, i) => row(`k${i}`, `Artist ${i}`))];
  const base = { playingKey: 'p', heard: new Set(['p']), reshuffle: false } as const;
  const drawn = arrangeShuffle(items, { ...base, order: [], reshuffle: true, rand: seeded(3) }).order;
  // The songs dealt late now fit, the ones dealt early do not.
  const turned = new Map(drawn.map((k, i) => [k, i < 6 ? 0 : 1] as const));
  const mood = { fit: turned, confidence: 1, adventurous: 0.5 };
  const unknown = new Map<string, number>();

  it('an active signal keeps the song playing and the next two, and redraws the rest with the new fits', () => {
    const r = arrangeShuffle(items, { ...base, order: drawn, rand: seeded(7), mood, dealtFit: unknown, activeSignal: true });
    expect(r.order.slice(0, 2)).toEqual(drawn.slice(0, 2));
    expect(r.order.slice(2)).not.toEqual(drawn.slice(2));
    expect([...r.order].sort()).toEqual([...drawn].sort());
    expect(keyOf(r.items[0]!)).toBe('p');
    expect(r.dealtFit).toBe(turned);
  });

  it('the redrawn tail leans on the new fits (fitting songs come sooner on average, 200 draws)', () => {
    const rand = seeded(11);
    let fitting = 0;
    let other = 0;
    for (let t = 0; t < 200; t++) {
      const o = arrangeShuffle(items, { ...base, order: drawn, rand, mood, dealtFit: unknown, activeSignal: true }).order;
      o.forEach((k, i) => { if (i >= 2) { if (turned.get(k) === 1) fitting += i; else other += i; } });
    }
    expect(fitting / 200 / 6).toBeLessThan(other / 200 / 4);
  });

  it('a passive signal alone (a finished song) never re-deals', () => {
    const r = arrangeShuffle(items, { ...base, order: drawn, rand: seeded(7), mood, dealtFit: unknown, activeSignal: false });
    expect(r.order).toEqual(drawn);
    expect(r.dealtFit).toBe(unknown);
  });

  it('an active signal whose fits moved less than 0.15 on average over the tail does not re-deal', () => {
    const near = new Map(drawn.map((k, i) => [k, i < 6 ? 0.45 : 0.6] as const));
    const r = arrangeShuffle(items, { ...base, order: drawn, rand: seeded(7), mood: { ...mood, fit: near }, dealtFit: unknown, activeSignal: true });
    expect(r.order).toEqual(drawn);
  });

  it('an order drawn before any mood answer gets one re-deal on the first answer, then holds', () => {
    const first = arrangeShuffle(items, { ...base, order: drawn, rand: seeded(7), mood, dealtFit: null });
    expect(first.order).not.toEqual(drawn);
    expect(first.dealtFit).toBe(turned);
    const again = arrangeShuffle(items, { ...base, order: first.order, rand: seeded(9), mood, dealtFit: first.dealtFit });
    expect(again.order).toEqual(first.order);
  });

  it('with no mood the kept order is kept, whatever the signal', () => {
    const r = arrangeShuffle(items, { ...base, order: drawn, rand: seeded(7), mood: null, dealtFit: null, activeSignal: true });
    expect(r.order).toEqual(drawn);
    expect(r.dealtFit).toBeNull();
  });

  it('a fresh draw reports the fits it was dealt with (none without a mood)', () => {
    expect(arrangeShuffle(items, { ...base, order: [], reshuffle: true, rand: seeded(3), mood }).dealtFit).toBe(turned);
    expect(arrangeShuffle(items, { ...base, order: [], reshuffle: true, rand: seeded(3) }).dealtFit).toBeNull();
  });

  it('ARTIST-VARIETY-001 / WP4 still hold in a re-dealt tail: no artist back to back while another is available', () => {
    const mixed = [row('p', 'A'), ...Array.from({ length: 16 }, (_, i) => row(`m${i}`, `Artist ${'ABCD'[i % 4]}`))];
    const rand = seeded(13);
    let bad = 0;
    for (let t = 0; t < 100; t++) {
      const d = arrangeShuffle(mixed, { ...base, order: [], reshuffle: true, rand }).order;
      const fit = new Map(d.map((k, i) => [k, i < 8 ? 0 : 1] as const));
      bad += pairs(arrangeShuffle(mixed, { ...base, order: d, rand, mood: { fit, confidence: 1, adventurous: 0.5 }, dealtFit: null }).items);
    }
    expect(bad).toBe(0);
  });
});
