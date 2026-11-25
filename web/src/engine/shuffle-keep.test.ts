// @vitest-environment happy-dom
/**
 * WP5 plan steps 4 and 5 (docs/plans/2026-11-24-recsys-shuffle-mood.md): the shuffled order of the songs to come
 * survives a restart -- {order, epoch, seed} under `airwave.shuffle-order`, taken up again while at least 60% of its
 * keys are still in the queue -- and the draw comes from a generator seeded by the number kept with the order, so an
 * order in a bug report can be dealt again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecItem } from '../api';
import { ORDER_KEEP_SHARE, SHUFFLE_ORDER_KEY, arrangeShuffle, forgetOrder, keepOrder, keptOrder, newShuffleSeed, seededRand } from './shuffle-order';
import { row } from './quality/fixtures';

const items = (n: number): RecItem[] => Array.from({ length: n }, (_, i) => row(`k${i}`, `Artist ${i}`));
const ten = items(10);
const dealWith = (seed: number) => arrangeShuffle(ten, { playingKey: null, heard: new Set(), order: [], reshuffle: true, rand: seededRand(seed) }).order;

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe('WP5 (step 4): the shuffled order is kept across a restart', () => {
  const drawn = dealWith(42);

  it('keeps {order, epoch, seed} under airwave.shuffle-order', () => {
    keepOrder({ order: drawn, epoch: 2, seed: 7 });
    expect(JSON.parse(localStorage.getItem(SHUFFLE_ORDER_KEY)!)).toEqual({ order: drawn, epoch: 2, seed: 7 });
  });

  it('takes the order up again with 60% of its keys still in the queue (the plan threshold), seed and all', () => {
    expect(ORDER_KEEP_SHARE).toBe(0.6);
    keepOrder({ order: drawn, epoch: 3, seed: 42 });
    const left = new Set(drawn.slice(0, 6));
    const kept = keptOrder(3, left);
    expect(kept).not.toBeNull();
    expect(kept!.seed).toBe(42);
    expect(kept!.order).toEqual(drawn.filter((k) => left.has(k)));
  });

  it('deals fresh below the threshold (half the keys left)', () => {
    keepOrder({ order: drawn, epoch: 3, seed: 42 });
    expect(keptOrder(3, new Set(drawn.slice(0, 5)))).toBeNull();
  });

  it('ignores an order kept for another round (a different epoch)', () => {
    keepOrder({ order: drawn, epoch: 3, seed: 42 });
    expect(keptOrder(4, new Set(drawn))).toBeNull();
    expect(keptOrder(2, new Set(drawn))).toBeNull();
  });

  it('nothing kept, a damaged entry, or one forgotten deals fresh', () => {
    expect(keptOrder(0, new Set(drawn))).toBeNull();
    localStorage.setItem(SHUFFLE_ORDER_KEY, '{not json');
    expect(keptOrder(0, new Set(drawn))).toBeNull();
    localStorage.setItem(SHUFFLE_ORDER_KEY, JSON.stringify({ order: ['k0'] }));
    expect(keptOrder(0, new Set(drawn))).toBeNull();
    keepOrder({ order: drawn, epoch: 0, seed: 1 });
    forgetOrder();
    expect(keptOrder(0, new Set(drawn))).toBeNull();
  });

  it('a kept order, taken up again, is the order the queue shows (no new deal)', () => {
    keepOrder({ order: drawn, epoch: 0, seed: 42 });
    const kept = keptOrder(0, new Set(drawn))!;
    const r = arrangeShuffle(ten, { playingKey: null, heard: new Set(), order: kept.order, reshuffle: false, rand: seededRand(kept.seed) });
    expect(r.order).toEqual(drawn);
  });
});

describe('WP5 (step 5): the draw comes from the seed kept with the order', () => {
  it('the same seed deals the same order, so a bug report can be dealt again', () => {
    expect(dealWith(12345)).toEqual(dealWith(12345));
  });

  it('another seed deals another order', () => {
    expect(dealWith(12345)).not.toEqual(dealWith(999));
  });

  it('the generator stays in 0..1', () => {
    const rand = seededRand(1);
    for (let i = 0; i < 500; i++) { const v = rand(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });

  it('a fresh seed is a whole number that survives the round trip through storage', () => {
    expect(newShuffleSeed(() => 0)).toBe(0);
    const s = newShuffleSeed(() => 0.5);
    expect(Number.isSafeInteger(s)).toBe(true);
    keepOrder({ order: ['k0'], epoch: 1, seed: s });
    expect(keptOrder(1, new Set(['k0']))!.seed).toBe(s);
  });
});
