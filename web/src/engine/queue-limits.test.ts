import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueuePreloader } from './queue-preload';
import type { Track } from '../api';

const tracks = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `t${i}`, title: `Song ${i}`, artist: 'Test' }) as Track);
function rig() {
  const states = new Map<string, string>();
  const listeners = new Set<() => void>();
  const started: string[] = [];
  const configure = vi.fn(async (_gb: number, _p: string[], _w: string[], _par: number) => undefined);
  const library = {
    status: (u: string) => states.get(u) ?? 'unknown',
    error: () => null,
    subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
    ensure: vi.fn(async (u: string) => { started.push(u); states.set(u, 'running'); }),
  };
  const loader = new QueuePreloader({ resolve: async (t: Track) => `url:${t.key}`, library, configure });
  return { loader, states, started, configure, finish: (u: string) => { states.set(u, 'ready'); listeners.forEach(f => f()); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const tick = () => vi.advanceTimersByTimeAsync(10);

it('raising the limit starts more downloads at once, without waiting for one to finish', async () => {
  const r = rig();
  r.loader.update(tracks(8)); await tick();
  expect(r.started).toHaveLength(2);
  await r.loader.limits({ parallel: 5 }); await tick();
  expect(r.started).toHaveLength(5);
  expect(r.loader.snapshot()).toMatchObject({ active: 5, parallel: 5 });
  // The native shells must be told, or their own lanes stay at the old cap.
  expect(r.configure.mock.calls.at(-1)?.[3]).toBe(5);
  r.loader.dispose();
});

it('lowering the limit never cancels work in flight; it only stops new starts', async () => {
  const r = rig();
  r.loader.update(tracks(8));
  await r.loader.limits({ parallel: 4 }); await tick();
  expect(r.started).toHaveLength(4);
  await r.loader.limits({ parallel: 1 }); await tick();
  // All four keep going — killing a download would throw away bytes already fetched.
  expect(r.loader.snapshot().active).toBe(4);
  expect(r.started).toHaveLength(4);
  r.finish('url:t0'); r.finish('url:t1'); r.finish('url:t2'); await tick();
  expect(r.started).toHaveLength(4); // still one over the new limit
  r.finish('url:t3'); await tick();
  expect(r.started).toHaveLength(5); // now under it, so one more starts
  r.loader.dispose();
});

it('a preload count fetches only the first N ahead, and the rest say why they wait', async () => {
  const r = rig();
  await r.loader.limits({ parallel: 1, preload: { target: 'count', count: 3 } });
  r.loader.update(tracks(10)); await tick();
  for (let i = 0; i < 3; i++) { r.finish(`url:t${i}`); await tick(); }
  expect(r.started).toEqual(['url:t0', 'url:t1', 'url:t2']);
  expect(r.loader.cardOf('t2', { kept: false, percent: null }).state).toBe('ready');
  expect(r.loader.cardOf('t7', { kept: false, percent: null }).text).toBe('Queued · Outside preload target');
  // Widening the target picks the rest up without a relaunch.
  await r.loader.limits({ preload: { target: 'all', count: 3 } }); await tick();
  expect(r.started).toContain('url:t3');
  r.loader.dispose();
});

it('reports a card as downloading with the real job percent, and kept copies as ready', async () => {
  const r = rig();
  r.loader.update(tracks(2)); await tick();
  expect(r.loader.cardOf('t0', { kept: false, percent: 37 })).toMatchObject({ state: 'downloading', text: 'Caching · 37%', progress: 37 });
  r.finish('url:t0'); await tick();
  expect(r.loader.cardOf('t0', { kept: false, percent: null })).toMatchObject({ state: 'ready', progress: 100 });
  // A kept copy is permanent and outside the cache, so it reads differently.
  expect(r.loader.cardOf('t0', { kept: true, percent: null }).keptText).toBe('Kept in Music folder');
  expect(r.loader.cardOf('unknown-key', { kept: false, percent: null }).state).toBe('queued');
  r.loader.dispose();
});
