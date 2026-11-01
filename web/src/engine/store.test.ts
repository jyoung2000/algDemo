import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openIdbBackend } from './idb';
import { DiskFull, MemoryBackend, Store } from './store';

let clock = 1_000_000;
const tick = () => (clock += 0.01);
const mk = (budget = 10_000) => Store.open(new MemoryBackend(), { cacheBudget: budget, now: tick });

describe('Store (port of test_store_net.py)', () => {
  it('LRU-evicts cache, keeps the recently used one, protects user data', async () => {
    const s = await mk();
    await s.put('settings', { mode: 'discover' });
    await s.setSeeds([{ key: 's', title: 'Seed', artists: ['A'] }]);
    await s.addFeedback('e1', 'k', 'like', 'a', null, null);
    for (let i = 0; i < 8; i++) await s.cachePut(`k${i}`, 'search', { pad: 'x'.repeat(900) }, 60);
    s.cacheGet('k0');
    for (let i = 8; i < 13; i++) await s.cachePut(`k${i}`, 'search', { pad: 'x'.repeat(900) }, 60);
    expect(s.cacheBytes()).toBeLessThanOrEqual(10_000);
    expect(s.cacheGet('k0')).not.toBeNull();
    expect(s.cacheGet('k1')).toBeNull();
    expect(s.get('settings')).toEqual({ mode: 'discover' });
    expect(s.seeds()).toHaveLength(1);
    expect(s.feedback()).toHaveLength(1);
  });

  it('returns stale cache only when asked', async () => {
    const s = await mk();
    await s.cachePut('q', 'search', [1, 2], -1);
    expect(s.cacheGet('q')).toBeNull();
    const hit = s.cacheGet('q', true)!;
    expect(hit.stale).toBe(true);
    expect(hit.value).toEqual([1, 2]);
  });

  it('treats a malformed cache row as a miss and removes it', async () => {
    const be = new MemoryBackend();
    be.data.cache.set('bad', { kind: 'x', v: {}, size: 2, created: 0, expires: 'not-a-time', accessed: 0 });
    const s = await Store.open(be, { now: tick });
    expect(s.cacheGet('bad')).toBeNull();
    await s.flush();
    expect(be.data.cache.has('bad')).toBe(false);
  });

  it('deduplicates feedback by event id and removes by key and kind', async () => {
    const s = await mk();
    expect(await s.addFeedback('e1', 'k', 'like', 'a', null, null)).toBe(true);
    expect(await s.addFeedback('e1', 'k', 'like', 'a', null, null)).toBe(false);
    expect(s.feedback()).toHaveLength(1);
    expect(s.removeFeedback('k', ['like'])).toBe(1);
    expect(await s.addFeedback('e1', 'k', 'like', 'a', null, null)).toBe(true);
  });

  it('keys vectors by model and preprocessing', async () => {
    const s = await mk();
    await s.vectorPut('rec', 'model-a', 'pre-1', [0, 1, 2, 3], 'deezer');
    expect(s.vectorGet('rec', 'model-b', 'pre-1')).toBeNull();
    expect(s.vectorGet('rec', 'model-a', 'pre-2')).toBeNull();
    expect(Array.from(s.vectorGet('rec', 'model-a', 'pre-1')!)).toEqual([0, 1, 2, 3]);
  });

  it('keeps seed order and emphasis, impressions per window, and export shape', async () => {
    const s = await mk();
    await s.setSeeds([{ key: 'b', title: 'B', emphasis: 2 }, { key: 'a', title: 'A' }]);
    expect(s.seeds().map((x) => [x.key, x.emphasis])).toEqual([['b', 2], ['a', 1]]);
    await s.addImpressions(['x', 'x', 'y'], 100);
    await s.addImpressions(['x'], 200);
    expect(s.impressions(150)).toEqual({ x: 1 });
    expect(s.impressions(0)).toEqual({ x: 3, y: 1 });
    expect(s.expireImpressions(150)).toBe(3);
    expect(s.export().format).toBe('airwave-discovery-export/1');
  });

  it('accounts transfer by day and category', async () => {
    const s = await mk();
    s.addTransfer('audio', 10, '2026-10-28');
    s.addTransfer('audio', 5, '2026-10-28');
    s.addTransfer('audio', 0, '2026-10-28');
    s.addTransfer('json', 7, '2026-10-27');
    expect(s.transferToday('2026-10-28')).toEqual({ audio: 15 });
  });

  it('refuses writes when free space is under the floor', async () => {
    const s = await Store.open(new MemoryBackend(), { freeFloor: 512, freeBytes: async () => 100 });
    await expect(s.put('k', 1)).rejects.toBeInstanceOf(DiskFull);
  });

  it('reset clears user data and optionally the cache', async () => {
    const s = await mk();
    await s.put('settings', 1);
    await s.cachePut('c', 'x', 1, 60);
    s.reset(true);
    expect(s.get('settings')).toBeUndefined();
    expect(s.cacheGet('c')).not.toBeNull();
    s.reset(false);
    expect(s.cacheGet('c')).toBeNull();
  });
});

describe('Store on IndexedDB', () => {
  it('survives a restart', async () => {
    const name = `t-${Math.random()}`;
    const a = await Store.open(await openIdbBackend(name));
    await a.put('settings', { adventurous: 0.4 });
    await a.setSeeds([{ key: 's1', title: 'One' }, { key: 's2', title: 'Two', emphasis: 3 }]);
    await a.addFeedback('e1', 's1', 'like', 'x', { key: 's1' }, 12);
    await a.addImpressions(['s1'], 50);
    await a.cachePut('c', 'search', { n: 1 }, 600);
    await a.vectorPut('r', 'm', 'p', [1, 2, 3], 'deezer');
    a.addTransfer('json', 9, '2026-10-28');
    await a.flush();

    const b = await Store.open(await openIdbBackend(name));
    expect(b.get('settings')).toEqual({ adventurous: 0.4 });
    expect(b.seeds().map((x) => [x.key, x.emphasis])).toEqual([['s1', 1], ['s2', 3]]);
    expect(b.feedback()).toHaveLength(1);
    expect(b.feedback()[0]!.listened).toBe(12);
    expect(b.impressions(0)).toEqual({ s1: 1 });
    expect(b.cacheGet('c')!.value).toEqual({ n: 1 });
    expect(Array.from(b.vectorGet('r', 'm', 'p')!)).toEqual([1, 2, 3]);
    expect(b.transferToday('2026-10-28')).toEqual({ json: 9 });
    expect(await b.addFeedback('e1', 's1', 'like', 'x', null, null)).toBe(false);
  });
});
