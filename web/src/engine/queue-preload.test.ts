import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueuePreloader } from './queue-preload';
import type { Track } from '../api';

const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, title: `Song ${i}`, artist: 'Test' }) as Track);
function rig(capacity?: () => Promise<{ bytes: number; limit: number }>) {
  const states = new Map<string, string>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(f => f());
  const started: string[] = [];
  const configure = vi.fn(async (_gb: number, _protected: string[], _wanted: string[], _parallel: number) => undefined);
  const resolve = vi.fn(async (t: Track, _retry?: boolean, _exclude?: readonly string[]): Promise<string | null> => `url:${t.key}`);
  const library = {
    status: (u: string) => states.get(u) ?? 'unknown',
    error: (u: string) => errors.get(u) ?? null,
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    ensure: vi.fn(async (u: string, _label: string, _retry: boolean, background: boolean) => {
      expect(background).toBe(true);
      if (states.get(u) !== 'ready') { started.push(u); states.set(u, 'running'); }
    }),
  };
  const loader = new QueuePreloader({ resolve, library, configure, capacity });
  return { loader, states, started, configure, resolve, library, finish: (u: string) => { states.set(u, 'ready'); emit(); }, fail: (u: string, e: string) => { states.set(u, 'missing'); errors.set(u, e); emit(); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const tick = () => vi.advanceTimersByTimeAsync(10);

it('immediately retries a missing source without waiting for the maintenance beat', async () => {
  const r = rig();
  r.resolve.mockResolvedValueOnce(null);
  r.loader.update(tracks(1)); await tick();
  expect(r.started).toEqual(['url:t0']);
  expect(r.resolve).toHaveBeenLastCalledWith(tracks(1)[0], true, undefined);
  r.loader.dispose();
});

it('immediately replaces an explicitly unavailable link rather than downloading it twice', async () => {
  const r = rig();
  r.resolve.mockResolvedValueOnce('url:dead').mockResolvedValue('url:alternative');
  r.loader.update(tracks(1)); await tick();
  r.fail('url:dead', 'Requested format is not available'); await tick();
  expect(r.started).toEqual(['url:dead', 'url:alternative']);
  expect(r.resolve).toHaveBeenLastCalledWith(tracks(1)[0], true, ['url:dead']);
  r.loader.dispose();
});

it.each(['reconnect', 'download all'])('%s bypasses cached misses immediately without duplicating active work', async mode => {
  const r = rig(); r.resolve.mockResolvedValue(null);
  r.loader.update(tracks(1)); await tick();
  r.resolve.mockResolvedValue('url:recovered');
  if (mode === 'reconnect') r.loader.retryFailed();
  else r.loader.downloadAll(tracks(1));
  await tick();
  expect(r.resolve).toHaveBeenLastCalledWith(tracks(1)[0], true, undefined);
  expect(r.started).toEqual(['url:recovered']);
  r.loader.retryFailed(); await tick();
  expect(r.started).toEqual(['url:recovered']);
  r.loader.dispose();
});

it('limits fast failures to bounded attempts rather than spinning at zero delay', async () => {
  const r = rig(); r.resolve.mockResolvedValue(null);
  r.loader.update(tracks(1)); await tick();
  expect(r.resolve).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2000);
  expect(r.resolve).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(58_000);
  expect(r.resolve.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(r.resolve.mock.calls.length).toBeLessThanOrEqual(7);
  r.loader.dispose();
});

it('keeps maintaining the cache every ~2-3s with no library event at all', async () => {
  // Owner: loading must retry and listened songs must be unloaded "continuously every 2-3 seconds".
  // Nothing here fires a library notification, so a purely event-driven loader goes silent.
  const r = rig(async () => ({ bytes: 10, limit: 1000 }));
  r.loader.update(tracks(3)); await tick();
  const configures = r.configure.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(r.configure.mock.calls.length).toBeGreaterThan(configures);
  // And it keeps going, rather than firing once.
  const second = r.configure.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(r.configure.mock.calls.length).toBeGreaterThan(second);
  r.loader.dispose();
});

it('starts a due source retry within ~2-3s of it coming due, with no library event', async () => {
  // Exhaust the immediate retry; the next short backoff must wake without a library event.
  const r = rig();
  r.resolve.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  r.loader.update(tracks(1)); await tick();
  expect(r.loader.snapshot()).toMatchObject({ failed: 1 });
  const before = r.resolve.mock.calls.length;
  // 2.5s backoff. Nothing notifies the library in this window.
  await vi.advanceTimersByTimeAsync(2500);
  expect(r.resolve.mock.calls.length).toBeGreaterThan(before);
  expect(r.started).toContain('url:t0');
  r.loader.dispose();
});

it('stops all maintenance once disposed', async () => {
  const r = rig(async () => ({ bytes: 10, limit: 1000 }));
  r.loader.update(tracks(2)); await tick();
  r.loader.dispose();
  const after = r.configure.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(r.configure.mock.calls.length).toBe(after);
});

it('tells the shell the new priority order when the listener advances within the same list', async () => {
  // Rolling cache: as the song advances, the songs still to come must outrank the ones already
  // played, or the shell evicts what is about to play to keep what just finished.
  const r = rig(); const list = tracks(6);
  r.loader.update(list); await tick();
  for (let i = 0; i < 6; i++) { r.finish(`url:t${i}`); await tick(); }
  const before = r.configure.mock.calls.length;
  // Same six songs, listener has moved to t3 — identical set, different order only.
  r.loader.update([list[3]!, list[4]!, list[5]!, list[0]!, list[1]!, list[2]!]); await tick();
  expect(r.configure.mock.calls.length).toBeGreaterThan(before);
  expect(r.configure.mock.calls.at(-1)?.[2]).toEqual(['url:t3', 'url:t4', 'url:t5', 'url:t0', 'url:t1', 'url:t2']);
  r.loader.dispose();
});

it('drains the ENTIRE list with two parallel background slots, without needing playback', async () => {
  const r = rig(); r.loader.update(tracks(11)); await tick();
  expect(r.started).toEqual(['url:t0', 'url:t1']);
  for (let i = 0; i < 11; i++) { r.finish(`url:t${i}`); await tick(); }
  expect(new Set(r.started).size).toBe(11);
  expect(r.loader.snapshot()).toMatchObject({ total: 11, ready: 11, active: 0 });
  r.loader.dispose();
});
it('reuses ready files, deduplicates keys and never makes a blob for background tracks', async () => {
  const r = rig(); r.states.set('url:t0', 'ready');
  r.loader.update([...tracks(4), ...tracks(2)]); await tick();
  expect(r.started).not.toContain('url:t0');
  expect(r.loader.snapshot().total).toBe(4);
  expect(r.configure.mock.calls.at(-1)?.[2]).toContain('url:t0');
  r.loader.dispose();
});
it('removed items stop being scheduled; newly appended items are picked up', async () => {
  const r = rig(); r.loader.update(tracks(9)); await tick();
  r.loader.update([tracks(9)[8]!]); await tick();
  expect(r.started).toContain('url:t8');
  expect(r.started).not.toContain('url:t2');
  r.finish('url:t8'); await tick();
  expect(r.loader.snapshot()).toMatchObject({ total: 1, ready: 1 });
  r.loader.dispose();
});
it('configures the full wanted set separately from live deck protection', async () => {
  const r = rig(); r.loader.update(tracks(5)); await tick();
  for (let i = 0; i < 5; i++) { r.finish(`url:t${i}`); await tick(); }
  await r.loader.protect(2, ['url:t4']);
  expect(r.configure).toHaveBeenLastCalledWith(2, ['url:t4'], expect.arrayContaining(['url:t0', 'url:t4']), 2);
  expect(r.configure.mock.calls.at(-1)?.[2]).toHaveLength(5);
  r.loader.dispose();
});
it('does not endlessly evict and re-download when the list exceeds the cache budget', async () => {
  const r = rig(); r.loader.update(tracks(7)); await tick();
  r.fail('url:t0', 'Cache limit cannot fit this song without removing a protected song.'); await tick();
  r.finish('url:t1'); await vi.advanceTimersByTimeAsync(120_000);
  expect(r.started).toHaveLength(2);
  expect(r.loader.snapshot().blocked).toBe(true);
  await r.loader.protect(3, []); await tick();
  expect(r.started.length).toBeGreaterThan(2);
  r.loader.dispose();
});
it('retries immediately then backs off with a thirty-second cap while continuing other songs', async () => {
  const r = rig(); r.loader.update(tracks(3)); await tick();
  r.finish('url:t1'); await tick(); r.finish('url:t2'); await tick();
  r.fail('url:t0', 'Network disconnected'); await tick();
  expect(r.started).toHaveLength(4); // first retry has no deliberate delay
  for (const delay of [2500, 5000, 15_000, 30_000, 30_000]) {
    const count = r.started.length;
    r.fail('url:t0', 'Network disconnected'); await tick();
    await vi.advanceTimersByTimeAsync(delay - 20);
    expect(r.started).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(20);
    expect(r.started).toHaveLength(count + 1);
  }
  r.finish('url:t0'); await tick();
  expect(r.loader.snapshot()).toMatchObject({ ready: 3, failed: 0, active: 0 });
  r.loader.dispose();
});

it('retries a missing source without clicks and bypasses negative resolution caches', async () => {
  const r = rig(); r.resolve.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  r.loader.update(tracks(1)); await tick();
  expect(r.resolve).toHaveBeenCalledTimes(2);
  expect(r.loader.snapshot()).toMatchObject({ failed: 1, queued: 0 });
  await vi.advanceTimersByTimeAsync(2400);
  // The third argument is the dead-link list (SOURCE-SWAP-001); nothing has failed to DOWNLOAD
  // here — the source never resolved — so there is no link to exclude yet.
  expect(r.resolve).toHaveBeenLastCalledWith(tracks(1)[0], true, undefined);
  expect(r.resolve).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(100);
  expect(r.started).toEqual(['url:t0']);
  r.finish('url:t0'); await tick();
  expect(r.loader.snapshot()).toMatchObject({ ready: 1, failed: 0 });
  r.loader.dispose();
});
it('routes every cache-config through the preloader, so no caller silently cancels list downloads', async () => {
  // The shells cancel any queued cache job whose URL is absent from `wanted`. A direct
  // dl.cacheConfig(gb, protected) call therefore wipes the whole list prefetch; it must go
  // through QueuePreloader.protect, which always resends the full wanted set.
  const fs = await import('node:fs/promises');
  for (const f of ['../Player.tsx', '../Settings.tsx', '../App.tsx', '../Downloads.tsx']) {
    const src = await fs.readFile(new URL(f, import.meta.url), 'utf8').catch(() => '');
    expect(src, `${f} must not call dl.cacheConfig directly`).not.toMatch(/\bdl\.cacheConfig\s*\(/);
  }
});
it('ignores a stale source resolution after replacing the list', async () => {
  const r = rig(); let done!: (u: string) => void;
  r.resolve.mockImplementationOnce(() => new Promise<string>(f => { done = f; }));
  r.loader.update(tracks(1)); await tick();
  r.loader.update([]); done('url:t0'); await tick();
  expect(r.started).toEqual([]); expect(r.loader.snapshot().total).toBe(0);
  r.loader.dispose();
});

// Explicit list requests do not replace the global automatic queue or its settings.
it('downloads a deduplicated requested list beyond count, with live list-specific readiness', async () => {
  const r = rig();
  await r.loader.limits({ parallel: 2, preload: { target: 'count', count: 1 } });
  r.loader.update(tracks(5)); await tick();
  expect(r.started).toEqual(['url:t0']);
  r.loader.downloadAll([...tracks(4), ...tracks(2)]); await tick();
  expect(r.started).toEqual(['url:t0', 'url:t1']);
  expect(r.loader.snapshotFor(tracks(4))).toMatchObject({ total: 4, ready: 0, active: 2 });
  for (let i = 0; i < 4; i++) {
    r.finish(`url:t${i}`);
    expect(r.loader.snapshotFor(tracks(4)).ready).toBe(i + 1);
    await tick();
  }
  expect(r.started).toEqual(['url:t0', 'url:t1', 'url:t2', 'url:t3']);
  expect(r.loader.snapshotFor([...tracks(4), ...tracks(2)])).toMatchObject({ total: 4, ready: 4 });
  r.states.set('url:t2', 'missing');
  expect(r.loader.snapshotFor(tracks(4)).ready).toBe(3);
  expect(r.loader.snapshot().ready).toBe(3);
  expect(r.loader.cardOf('t2', { kept: false, percent: null }).state).not.toBe('ready');
  r.loader.update(tracks(6)); await tick();
  expect(r.started).not.toContain('url:t4');
  expect(r.started).not.toContain('url:t5');
  r.loader.dispose();
});

it('captures manual requests across automatic navigation and exposes list-scoped bulkActive', async () => {
  const r = rig();
  await r.loader.limits({ parallel: 1, preload: { target: 'count', count: 1 } });
  r.loader.downloadAll(tracks(3)); await tick();
  r.loader.update([tracks(8)[7]!]); await tick();
  expect(r.loader.snapshotFor(tracks(3))).toMatchObject({ total: 3, bulkActive: true });
  expect(r.loader.snapshotFor([tracks(8)[7]!])).toMatchObject({ total: 1, bulkActive: false });
  for (let i = 0; i < 3; i++) { r.finish(`url:t${i}`); await tick(); }
  expect(r.loader.snapshotFor(tracks(3))).toMatchObject({ ready: 3, bulkActive: false });
  expect(r.started).toEqual(expect.arrayContaining(['url:t0', 'url:t1', 'url:t2']));
  r.loader.dispose();
});

it('does not refill an evicted completed song until explicitly requested again', async () => {
  const r = rig(); r.loader.update(tracks(1)); await tick();
  r.finish('url:t0'); await tick();
  r.fail('url:t0', ''); await tick();
  expect(r.loader.snapshotFor(tracks(1)).ready).toBe(0);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(r.started).toEqual(['url:t0']);
  r.loader.downloadAll(tracks(1)); await tick();
  expect(r.started).toEqual(['url:t0', 'url:t0']);
  r.loader.dispose();
});

it('keeps the GB quota authoritative for manual lists and distinguishes blocked from failed', async () => {
  const r = rig(); await r.loader.protect(0.5, ['playing']);
  await r.loader.limits({ parallel: 1, preload: { target: 'count', count: 1 } });
  r.loader.downloadAll(tracks(4)); await tick();
  r.fail('url:t0', 'Cache limit cannot fit this song'); await tick();
  expect(r.loader.snapshotFor(tracks(4))).toMatchObject({ blocked: true, bulkActive: false, ready: 0, failed: 0 });
  r.loader.downloadAll(tracks(4)); await tick();
  expect(r.started).toEqual(['url:t0']);
  expect(r.configure).toHaveBeenLastCalledWith(0.5, ['playing'], expect.any(Array), 1);
  await r.loader.protect(2, ['playing']); await tick();
  expect(r.started).toHaveLength(2);
  r.loader.dispose();
});

it('refills an evicted song when the listener raises the cache limit', async () => {
  // Parking an evicted song stops fill/evict churn, but a bigger cache is a new instruction:
  // the song fitted nowhere before and fits now, so the list must finish filling itself.
  const r = rig(); r.loader.update(tracks(1)); await tick();
  r.finish('url:t0'); await tick();
  r.fail('url:t0', ''); await tick();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(r.started).toEqual(['url:t0']);
  await r.loader.protect(4, []); await tick();
  expect(r.started).toEqual(['url:t0', 'url:t0']);
  r.loader.dispose();
});

it('serializes bulk, protection and limits through the same config writer', async () => {
  const r = rig(); let active = 0; let maximum = 0;
  r.configure.mockImplementation(async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise<void>(resolve => setTimeout(resolve, 2));
    active--;
  });
  r.loader.downloadAll(tracks(3));
  const protectedConfig = r.loader.protect(2, ['playing']);
  const limitsConfig = r.loader.limits({ parallel: 1 });
  await vi.advanceTimersByTimeAsync(100);
  await Promise.all([protectedConfig, limitsConfig]);
  expect(maximum).toBe(1);
  expect(r.started).toEqual(['url:t0']);
  expect(r.configure).toHaveBeenLastCalledWith(2, ['playing'], ['url:t0'], 1);
  r.loader.dispose();
});

const MiB = 1024 * 1024;
it('does not let a removed quota-blocked entry stop the new queue', async () => {
  const r = rig(async () => ({ bytes: 0, limit: 100 * MiB }));
  r.loader.update(tracks(1)); await tick();
  r.fail('url:t0', 'Cache limit cannot fit'); await tick();
  r.loader.update([tracks(2)[1]!]); await tick();
  expect(r.started).toEqual(['url:t0', 'url:t1']);
  expect(r.loader.snapshot().blocked).toBe(false);
  r.loader.dispose();
});

it.each(['disposed', 'removed', 'outside COUNT'])('does not retry a failed source once %s', async mode => {
  const r = rig(); r.resolve.mockResolvedValue(null);
  r.loader.update(tracks(1)); await tick();
  if (mode === 'disposed') r.loader.dispose();
  else if (mode === 'removed') r.loader.update([]);
  else {
    r.states.set('url:t1', 'ready');
    r.resolve.mockResolvedValue('url:t1');
    r.loader.update([tracks(2)[1]!, tracks(1)[0]!]);
    await r.loader.limits({ preload: { target: 'count', count: 1 } });
  }
  await vi.advanceTimersByTimeAsync(1_000_000);
  expect(r.resolve.mock.calls.filter(([track]) => track.key === 't0')).toHaveLength(2); // initial + immediate retry only
  expect(r.started).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  r.loader.dispose();
});

it('preempts future retry timers on notifications without duplicate starts', async () => {
  const r = rig(); r.resolve.mockImplementation(async t => t.key === 't0' ? null : `url:${t.key}`);
  r.loader.update(tracks(3)); await tick();
  expect(r.started).toEqual(['url:t1', 'url:t2']);
  r.finish('url:t1'); r.finish('url:t1'); await tick();
  expect(r.loader.snapshot()).toMatchObject({ ready: 1, active: 1, failed: 1 });
  r.loader.update(tracks(4)); await tick();
  expect(r.started).toEqual(['url:t1', 'url:t2', 'url:t3']);
  await vi.advanceTimersByTimeAsync(5000);
  expect(r.resolve).toHaveBeenCalledTimes(5); // t0 failed twice, then waits while both slots are busy
  r.resolve.mockImplementation(async t => `url:${t.key}`);
  r.finish('url:t2'); await tick();
  expect(r.started).toEqual(['url:t1', 'url:t2', 'url:t3', 'url:t0']);
  r.loader.dispose();
});

it('rechecks COUNT after an in-flight resolution before starting a download', async () => {
  const r = rig(); let release!: (url: string) => void;
  r.resolve.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  r.loader.update(tracks(1)); await tick();
  r.states.set('url:t1', 'ready');
  r.loader.update([tracks(2)[1]!, tracks(1)[0]!]);
  await r.loader.limits({ preload: { target: 'count', count: 1 } });
  release('url:t0'); await tick();
  expect(r.started).toEqual([]);
  r.loader.dispose();
});

it('keeps one-shot manual requests retrying outside COUNT until ready', async () => {
  const r = rig(); r.resolve.mockResolvedValueOnce(null);
  await r.loader.limits({ preload: { target: 'count', count: 1 } });
  r.loader.downloadAll(tracks(1)); await tick();
  r.loader.update([]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(r.started).toEqual(['url:t0']);
  r.finish('url:t0'); await tick();
  r.fail('url:t0', ''); await vi.advanceTimersByTimeAsync(600_000);
  expect(r.started).toHaveLength(1);
  r.loader.dispose();
});

it.each(['disposed', 'removed', 'outside COUNT'])('ignores a slow single-flight capacity result after %s', async mode => {
  let release!: (value: { bytes: number; limit: number }) => void;
  const capacity = vi.fn(() => new Promise<{ bytes: number; limit: number }>(resolve => { release = resolve; }));
  const r = rig(capacity); r.loader.update(tracks(1)); await tick();
  r.finish('url:t0'); await tick(); r.fail('url:t0', ''); await tick();
  await vi.advanceTimersByTimeAsync(30_000);
  for (let i = 0; i < 5; i++) { r.loader.update(tracks(1)); await vi.advanceTimersByTimeAsync(30_000); }
  expect(capacity).toHaveBeenCalledTimes(1);
  if (mode === 'disposed') r.loader.dispose();
  else if (mode === 'removed') r.loader.update([]);
  else {
    r.states.set('url:t1', 'ready');
    r.resolve.mockResolvedValue('url:t1');
    r.loader.update([tracks(2)[1]!, tracks(1)[0]!]);
    await r.loader.limits({ preload: { target: 'count', count: 1 } });
  }
  release({ bytes: 0, limit: 100 * MiB }); await tick();
  expect(r.started).toHaveLength(1);
  r.loader.dispose();
});

it('requires both headroom thresholds, handles failed health, and resumes on crossing the threshold', async () => {
  const capacity = vi.fn(async () => ({ bytes: 36 * MiB, limit: 50 * MiB }));
  capacity.mockRejectedValueOnce(new Error('health unavailable'));
  const r = rig(capacity); r.loader.update(tracks(1)); await tick();
  r.finish('url:t0'); await tick(); r.fail('url:t0', ''); await tick();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(capacity).toHaveBeenCalledTimes(2);
  expect(r.started).toHaveLength(1);
  capacity.mockResolvedValue({ bytes: 34 * MiB, limit: 50 * MiB });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(r.started).toHaveLength(2);
  r.loader.dispose();
});

it('resets failure backoff after a ready file is evicted and refilled', async () => {
  const r = rig(async () => ({ bytes: 0, limit: 100 * MiB }));
  r.loader.update(tracks(1)); await tick();
  for (const delay of [5000, 30_000, 120_000]) {
    r.fail('url:t0', 'Network'); await tick(); await vi.advanceTimersByTimeAsync(delay);
  }
  r.finish('url:t0'); await tick(); r.fail('url:t0', ''); await tick();
  await vi.advanceTimersByTimeAsync(30_000);
  const starts = r.started.length;
  r.fail('url:t0', 'Network'); await tick(); await vi.advanceTimersByTimeAsync(5000);
  expect(r.started).toHaveLength(starts + 1);
  r.loader.dispose();
});

it('passively refills evictions once with headroom, but never churns at unchanged capacity', async () => {
  const capacity = vi.fn(async () => ({ bytes: 50 * MiB, limit: 100 * MiB }));
  const r = rig(capacity); r.loader.update(tracks(1)); await tick();
  r.finish('url:t0'); await tick(); r.fail('url:t0', ''); await tick();
  expect(r.loader.snapshot().ready).toBe(0);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(r.started).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(r.started).toEqual(['url:t0', 'url:t0']);
  r.finish('url:t0'); await tick();
  expect(r.loader.snapshot()).toMatchObject({ ready: 1, active: 0 });
  r.fail('url:t0', ''); await tick();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(r.started).toHaveLength(2);
  expect(capacity.mock.calls.length).toBeLessThanOrEqual(21);
  capacity.mockResolvedValue({ bytes: 30 * MiB, limit: 100 * MiB });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(r.started).toHaveLength(3);
  r.loader.dispose();
});

it.each(['eviction', 'quota'])('parks %s at full capacity and resumes only on meaningful free space', async mode => {
  const capacity = vi.fn(async () => ({ bytes: 100 * MiB, limit: 100 * MiB }));
  const r = rig(capacity); r.loader.update(tracks(1)); await tick();
  if (mode === 'eviction') { r.finish('url:t0'); await tick(); }
  r.fail('url:t0', mode === 'quota' ? 'Cache limit cannot fit this song' : ''); await tick();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(r.started).toHaveLength(1);
  expect(capacity).toHaveBeenCalledTimes(20);
  capacity.mockResolvedValue({ bytes: 99 * MiB, limit: 100 * MiB });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(r.started).toHaveLength(1);
  capacity.mockResolvedValue({ bytes: 80 * MiB, limit: 100 * MiB });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(r.started).toEqual(['url:t0', 'url:t0']);
  expect(r.loader.snapshot()).toMatchObject({ blocked: false, active: 1 });
  r.loader.dispose();
});

/**
 * RETRY-SPIN-001 — the owner must be able to SEE that retrying is happening.
 *
 * Owner: "i dont see a spinning arrow indicating active retrying."
 *
 * The spinner was driven by `active`, which counts downloads in flight. A song waiting out its
 * 5s/30s/2min/5min backoff is `failed` with a future retry time, so `active` is 0 and the arrow
 * stopped — exactly when the owner most wants to know the app has not given up. The snapshot now
 * reports work that is scheduled as well as work in flight.
 */
it('reports songs waiting on a scheduled retry, so the spinner can show it', async () => {
  const r = rig();
  r.resolve.mockResolvedValue(null);
  r.loader.update(tracks(1)); await tick();
  const s = r.loader.snapshot();
  expect(s).toMatchObject({ failed: 1, active: 0 });
  expect(s.retrying).toBe(1); // a retry is booked, and the UI can say so
  r.loader.dispose();
});

it('does not claim a retry is pending when a song is parked for want of space', async () => {
  const r = rig();
  r.loader.update(tracks(1)); await tick();
  r.fail('url:t0', 'cache limit reached');
  await tick();
  const s = r.loader.snapshot();
  expect(s.blocked).toBe(true);
  expect(s.retrying).toBe(0); // nothing is scheduled; it waits for room, which is a different story
  r.loader.dispose();
});

it('reports no pending retry once every song is local', async () => {
  const r = rig();
  r.loader.update(tracks(1)); await tick();
  r.finish('url:t0'); await tick();
  expect(r.loader.snapshot()).toMatchObject({ ready: 1, retrying: 0 });
  r.loader.dispose();
});

/**
 * SOURCE-SWAP-001 — a source that keeps failing must be swapped, not retried for ever.
 *
 * Owner: "Ensure sources can download needed data and actively trys different or retries sources."
 *
 * `e.url ??= await resolve(...)` resolved a song once and then retried that same link for ever. A
 * link that is geo-blocked, taken down or unplayable can never succeed, so the song stayed stuck
 * even though another source might have had it. After repeated failures the loader now asks again
 * and says which links already failed, so the resolver can offer something else.
 */
it('asks for a different source after one link keeps failing', async () => {
  const r = rig();
  r.loader.update(tracks(1)); await tick();
  r.fail('url:t0', 'Requested format is not available');
  await vi.advanceTimersByTimeAsync(8000); // first backoff, second attempt on the same link
  r.fail('url:t0', 'Requested format is not available');
  await vi.advanceTimersByTimeAsync(40_000); // second backoff elapses
  const exclusions = r.resolve.mock.calls.map(c => c[2]).filter((x): x is readonly string[] => !!x);
  expect(exclusions.length).toBeGreaterThan(0); // it stopped assuming the first answer was the only one
  expect(exclusions.at(-1)).toContain('url:t0'); // and named the link that will not work
  r.loader.dispose();
});

it('keeps using a link that works and never asks for an alternative', async () => {
  const r = rig();
  r.loader.update(tracks(1)); await tick();
  r.finish('url:t0'); await tick();
  await vi.advanceTimersByTimeAsync(10_000);
  const exclusions = r.resolve.mock.calls.map(c => c[2]).filter((x): x is readonly string[] => !!x);
  expect(exclusions.flat()).not.toContain('url:t0'); // a working source is never discarded
  r.loader.dispose();
});
