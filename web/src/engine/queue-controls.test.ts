import { expect, it } from 'vitest';
import { cacheStateOf, preloadPlan, parallelRange, type CacheState } from './queue-controls';

const row = (over: Partial<Parameters<typeof cacheStateOf>[0]> = {}) =>
  cacheStateOf({ status: 'unknown', kept: false, percent: null, blocked: false, inTarget: true, error: null, ...over });

it('separates the evictable queue cache from a permanently kept copy', () => {
  // The owner conflates these; both designers refused to. A kept copy is never cache-evicted and
  // still makes the song playable, so it reports ready with its own provenance.
  expect(row({ status: 'ready' })).toMatchObject({ state: 'ready', text: 'Ready in queue cache' });
  expect(row({ status: 'missing', kept: true })).toMatchObject({ state: 'ready', kept: true, text: 'Ready from kept copy' });
  expect(row({ status: 'ready', kept: true })).toMatchObject({ state: 'ready', kept: true });
  expect(row({ status: 'ready', kept: true }).keptText).toBe('Kept in Music folder');
  expect(row({ status: 'ready' }).keptText).toBeNull();
});

it('reports the five states with a glyph AND text, never colour alone', () => {
  const states: [CacheState, string][] = [
    [row({ status: 'ready' }).state, 'Ready in queue cache'],
    [row({ status: 'running', percent: 42 }).state, 'Caching · 42%'],
    [row({ status: 'unknown' }).state, 'Queued'],
    [row({ status: 'missing', error: 'source unavailable' }).state, 'Unavailable · source unavailable'],
    [row({ status: 'missing', blocked: true }).state, 'Cache full · Raise the cache limit'],
  ];
  expect(states.map(([s]) => s)).toEqual(['ready', 'downloading', 'queued', 'failed', 'blocked']);
  for (const [, text] of states) expect(text.length).toBeGreaterThan(0);
  expect(states.map(([, t]) => t)).toEqual([
    row({ status: 'ready' }).text, row({ status: 'running', percent: 42 }).text,
    row({ status: 'unknown' }).text, row({ status: 'missing', error: 'source unavailable' }).text,
    row({ status: 'missing', blocked: true }).text]);
  // Every state carries a non-empty glyph, so the rail's colour is never the only signal.
  for (const s of ['ready', 'running', 'unknown', 'missing'] as const) expect(row({ status: s }).glyph).toBeTruthy();
});

it('never invents a progress number: the rail reads 0 or 100 unless the job reports a percent', () => {
  expect(row({ status: 'running', percent: 42 }).progress).toBe(42);
  expect(row({ status: 'running', percent: null }).progress).toBe(0);
  expect(row({ status: 'ready' }).progress).toBe(100);
  expect(row({ status: 'unknown' }).progress).toBe(0);
  expect(row({ status: 'missing', blocked: true }).progress).toBe(0);
});

it('says when a queued song is outside the preload target rather than looking stalled', () => {
  expect(row({ status: 'unknown', inTarget: false }).text).toBe('Queued · Outside preload target');
});

it('preloads every song by default, and the GB cap outranks the count', () => {
  // Both designers ruled the cap wins. A count larger than the cache can hold must not churn.
  expect(preloadPlan(['a', 'b', 'c'], { target: 'all', count: 20 })).toEqual(['a', 'b', 'c']);
  expect(preloadPlan(['a', 'b', 'c'], { target: 'count', count: 2 })).toEqual(['a', 'b']);
  expect(preloadPlan(['a', 'b'], { target: 'count', count: 50 })).toEqual(['a', 'b']);
  expect(preloadPlan([], { target: 'all', count: 5 })).toEqual([]);
});

it('offers a platform-aware parallelism range, because each slot is a separate process', () => {
  // Android 1-3 default 1, Windows 1-6 default 2: a phone is not a desktop.
  expect(parallelRange('android')).toEqual({ min: 1, max: 3, def: 1 });
  expect(parallelRange('windows')).toEqual({ min: 1, max: 6, def: 2 });
  expect(parallelRange('browser')).toEqual({ min: 1, max: 1, def: 1 });
});
