/**
 * QUEUE-DATA-FLOW-001: the pieces the listening top-up is built from — which artists a run asks next, which songs
 * count as heard, which sources are asked first on mobile data, and how much one run may read there.
 */
import { describe, expect, it } from 'vitest';
import { Budget, RESERVE_KEY, TOPUP_RUN_BYTES } from './budget';
import { MemoryBackend, Store } from './store';
import { FLOW_PER_DRY_RUN, FLOW_PER_RUN, cheapestFirst, dryReason, flowPick, flowState, heardTest } from './queue-data-flow';

const MB = 1_000_000;

describe('which artists a top-up asks next', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];
  it('walks on through the list, a few per run, and comes round again', () => {
    const one = flowPick(pool, { cursor: 0, dry: 0 });
    expect(one.picked).toEqual(pool.slice(0, FLOW_PER_RUN));
    const two = flowPick(pool, { cursor: one.next, dry: 0 });
    expect(two.picked).toEqual(pool.slice(FLOW_PER_RUN, 2 * FLOW_PER_RUN));
    const seen = new Set<string>();
    let cursor = 0;
    for (let i = 0; i < 3; i++) {
      const p = flowPick(pool, { cursor, dry: 0 });
      p.picked.forEach((x) => seen.add(x));
      cursor = p.next;
    }
    expect([...seen].sort()).toEqual(pool);
  });
  it('asks more of them after a run that found nothing', () => {
    expect(flowPick(pool, { cursor: 0, dry: 1 }).picked).toHaveLength(Math.min(pool.length, FLOW_PER_DRY_RUN));
  });
  it('a short list is asked whole, once', () => {
    expect(flowPick(['a'], { cursor: 7, dry: 3 })).toEqual({ picked: ['a'], next: 0 });
    expect(flowPick([], { cursor: 2, dry: 0 })).toEqual({ picked: [], next: 0 });
  });
  it('reads a missing or broken saved state as the start', () => {
    expect(flowState(undefined)).toEqual({ cursor: 0, dry: 0 });
    expect(flowState({ cursor: 'x', dry: -4 })).toEqual({ cursor: 0, dry: 0 });
    expect(flowState({ cursor: 3, dry: 2 })).toEqual({ cursor: 3, dry: 2 });
  });
});

describe('which songs count as heard', () => {
  const rows = [
    { kind: 'complete', key: 'deezer:1', track: { title: 'Nun Else', artists: ['OsamaSon'] } },
    { kind: 'skip', key: 'deezer:2', track: { title: 'Spin', artists: ['OsamaSon'] } },
    { kind: 'like', key: 'deezer:3', track: { title: 'Liked Only', artists: ['OsamaSon'] } },
  ];
  const heard = heardTest(rows);
  it('finished and skipped songs, by their key', () => {
    expect(heard({ key: 'deezer:1' })).toBe(true);
    expect(heard({ key: 'deezer:2' })).toBe(true);
  });
  it('the same song from another service, by its title and artist', () => {
    expect(heard({ key: 'ytmusic:abc', title: 'nun else', artists: ['Osamason'] })).toBe(true);
  });
  it('a song only liked, or never played, is not heard', () => {
    expect(heard({ key: 'deezer:3', title: 'Liked Only', artists: ['OsamaSon'] })).toBe(false);
    expect(heard({ key: 'deezer:9', title: 'Other', artists: ['OsamaSon'] })).toBe(false);
  });
});

describe('which sources are asked first on mobile data', () => {
  it('the small answers come before YouTube Music, each group in its own order', () => {
    const tasks = ['ytmusic-related', 'ytmusic-radio', 'apple-search', 'deezer-artist-radio', 'ytmusic-related', 'taste-artist'].map((source, i) => ({ source, i }));
    expect(cheapestFirst(tasks).map((t) => `${t.source}#${t.i}`)).toEqual([
      'apple-search#2', 'deezer-artist-radio#3', 'taste-artist#5', 'ytmusic-related#0', 'ytmusic-radio#1', 'ytmusic-related#4',
    ]);
  });
});

describe('what a dry top-up says', () => {
  it('names what was asked and what comes next', () => {
    const why = dryReason({ seeds: 2, artists: ['Summrs', 'OsamaSon'], colours: 1 }, ['Ken Carson']);
    expect(why).toMatch(/already heard/);
    expect(why).toMatch(/2 starting songs/);
    expect(why).toMatch(/Summrs and OsamaSon/);
    expect(why).toMatch(/your sound/);
    expect(why).toMatch(/Ken Carson/);
  });
  it('with nothing else to ask, says so', () => {
    expect(dryReason({ seeds: 1, artists: [], colours: 0 }, [])).toMatch(/1 starting song\b.*Star an artist or like a few songs/);
  });
});

describe('how much one top-up may read', () => {
  async function open(metered: boolean | null) {
    const store = await Store.open(new MemoryBackend());
    await store.put(RESERVE_KEY, { level: 0, at: 1_800_000_000, capacity: 100 * MB, metered });
    return new Budget(store, () => 100 * MB, () => 1_800_000_000);
  }
  it('on mobile data, or when the shell never said, a small ceiling; never refused for the empty reserve', async () => {
    for (const metered of [true, null]) {
      const budget = await open(metered);
      expect(budget.topUpCap(20 * MB)).toBe(TOPUP_RUN_BYTES);
      expect(budget.meter('playback', budget.topUpCap(20 * MB)).remaining()).toBe(TOPUP_RUN_BYTES);
    }
    expect(TOPUP_RUN_BYTES).toBeLessThanOrEqual(6 * MB);
  });
  it('a smaller per-request setting still wins', async () => {
    expect((await open(true)).topUpCap(2 * MB)).toBe(2 * MB);
  });
  it('on Wi-Fi the ceiling does not apply', async () => {
    expect((await open(false)).topUpCap(20 * MB)).toBe(20 * MB);
  });
});
