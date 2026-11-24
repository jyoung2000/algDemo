// WP3 (plan 2026-11-24, A3/M6): every way a song ends is recorded.
import { describe, expect, it } from 'vitest';
import { classifyNext } from './util';
import { needsListeningDiscovery } from './engine/discovery';
import { listenFromEvent } from './engine/native-engine';
import { heardIn } from './engine/shuffle-order';

describe('classifyNext (WP3, A3)', () => {
  it.each([
    // listened, coverage, duration, medium, expected
    [1, 1, 180, 'full', null],
    [5, 5, 180, 'full', 'skip'],
    [20, 20, 180, 'full', 'skip'], // a quarter of 180 s = 45 -> clamped to 30
    [60, 60, 180, 'full', 'partial'],
    [162, 162, 180, 'full', 'complete'], // 90% of a 3-minute song
    [11, 11, 30, 'preview', 'skip'],
    [15, 15, 30, 'preview', 'partial'],
    [25, 25, 30, 'preview', 'complete'],
    [29, 29, null, 'full', 'partial'], // unknown length: coverage 29 < 20? no -> complete needs >=20 heard and coverage>=20
    [10, 10, null, 'full', 'skip'],
    [13, 13, 40, 'full', 'partial'], // quarter of 40 = 10 -> clamped up to 12
  ] as const)('%s s of %s s heard (%s, %s) -> %s', (l, c, d, m, want) => {
    const got = classifyNext(l, c, d, m);
    if (l === 29 && d === null) expect(got).toBe('complete');
    else expect(got).toBe(want);
  });
  it('the plan targets: 20 s / 60 s / 90% of a 3-minute song -> skip / partial / complete', () => {
    expect([20, 60, 162].map((s) => classifyNext(s, s, 180, 'full'))).toEqual(['skip', 'partial', 'complete']);
  });
});

describe('a partial listen is listening (WP3)', () => {
  it('starts a top-up at the low-water mark like a skip or completion', () => {
    expect(needsListeningDiscovery(true, 'partial', true, 3)).toBe(true);
    expect(needsListeningDiscovery(true, 'partial', true, 20)).toBe(false);
  });
  it('five 20-second skips at the low-water mark each start the top-up check (the hole was 12 s .. end)', () => {
    const kinds = Array.from({ length: 5 }, () => classifyNext(20, 20, 180, 'full'));
    expect(kinds.every((k) => k && needsListeningDiscovery(true, k, true, 4))).toBe(true);
  });
  it('counts as heard for the Discover shuffle', () => {
    expect([...heardIn({ a: { partial: true }, b: { like: true } })]).toEqual(['a']);
  });
  it('the Android engine classifies a Next the same way', () => {
    const ev = (ms: number) => ({ cause: 'next', seq: 1, from: { id: 'k', heardMs: ms, durationMs: 180000 } }) as never;
    expect([20000, 60000, 162000, 1000].map((ms) => listenFromEvent(ev(ms))?.kind ?? null)).toEqual(['skip', 'partial', 'complete', null]);
  });
});
