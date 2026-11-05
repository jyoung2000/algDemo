import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueuePreloader } from './queue-preload';
import type { Track } from '../api';

const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, title: `Song ${i}`, artist: 'Test' }) as Track);
function rig() {
  const states = new Map<string, string>();
  const errors = new Map<string, string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(f => f());
  const started: string[] = [];
  const configure = vi.fn(async (_gb: number, _protected: string[], _wanted: string[], _parallel: number) => undefined);
  const resolve = vi.fn(async (t: Track) => `url:${t.key}`);
  const library = {
    status: (u: string) => states.get(u) ?? 'unknown',
    error: (u: string) => errors.get(u) ?? null,
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    ensure: vi.fn(async (u: string, _label: string, _retry: boolean, background: boolean) => {
      expect(background).toBe(true);
      if (states.get(u) !== 'ready') { started.push(u); states.set(u, 'running'); }
    }),
  };
  const loader = new QueuePreloader({ resolve, library, configure });
  return { loader, states, started, configure, resolve, library, finish: (u: string) => { states.set(u, 'ready'); emit(); }, fail: (u: string, e: string) => { states.set(u, 'missing'); errors.set(u, e); emit(); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const tick = () => vi.advanceTimersByTimeAsync(10);

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
it('backs off temporary failures, then stops after three attempts while continuing other songs', async () => {
  const r = rig(); r.loader.update(tracks(3)); await tick();
  r.fail('url:t0', 'Network disconnected'); r.finish('url:t1'); await tick();
  r.finish('url:t2'); await vi.advanceTimersByTimeAsync(6000);
  for (let i = 0; i < 2; i++) { r.fail('url:t0', 'Network disconnected'); await vi.advanceTimersByTimeAsync(31_000); }
  expect(r.started.filter(u => u === 'url:t0')).toHaveLength(3);
  expect(r.started).toContain('url:t2');
  expect(r.loader.snapshot().failed).toBe(1);
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
