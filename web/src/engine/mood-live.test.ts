/**
 * MOOD-SHUFFLE-001 / MOOD-NOW-001 / MOOD-DISCOVER-001 (owner, 2026-11-19): "even shuffle should take into
 * account my current listen mood", "my listening mood should try to reorganize my queue and find new songs
 * based on my current sound profile and listening mood". Through the real LocalApi; no provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';

const NOW = new Date('2026-11-19T18:00:00Z');
const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
const song = (key: string, genre: string) => ({ key, title: key, artists: [`${key} artist`], artist: `${key} artist`, provider: 'deezer', platform_id: key, tags: [tag(genre)], bpm: 120, release: null, duration: 200 });
const rap1 = song('rap-one', 'rap'), rap2 = song('rap-two', 'rap'), rapNow = song('rap-now', 'rap');
const jazz = (i: number) => song(`jazz-${i}`, 'smooth jazz');
const country = (i: number) => song(`country-${i}`, 'country');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

async function open(settings: Record<string, unknown> = {}) {
  const store = await Store.open(new MemoryBackend());
  await store.put('settings', { adventurous: 0.3, ...settings });
  const api = new LocalApi({ store, port: { request: async () => { throw new Error('offline'); } } as HttpPort, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/seeds', { seeds: [song('seed', 'pop')] });
  return { store, api };
}
async function listen(api: LocalApi, t: ReturnType<typeof song>, kind = 'complete', id = `${kind}:${t.key}`) {
  const res = await api.handle('POST', '/api/feedback', { kind, event_id: id, track: t, listened: 200, duration: 200, origin: 'queue' });
  expect(res.status).toBe(200);
  return id;
}
type Plan = { order: string[]; changed: boolean; fit?: Record<string, number>; confidence: number; leading: string[] };

describe('POST /api/mood answers how well every song fits the mood', () => {
  it('scores the movable songs and any others it is asked about, for the shuffle', async () => {
    const { api } = await open();
    await listen(api, rap1); await listen(api, rap2);
    const plan = (await api.handle('POST', '/api/mood', {
      upcoming: [jazz(1), rapNow].map((track) => ({ track })),
      score: [country(1), song('rap-handadded', 'rap')].map((track) => ({ track })),
      current: { track: rap2 },
    })).body as Plan;
    expect(plan.fit).toBeTruthy();
    expect(plan.fit!['rap-now']!).toBeGreaterThan(plan.fit!['jazz-1']!);
    expect(plan.fit!['rap-handadded']!).toBeGreaterThan(plan.fit!['country-1']!);
    // The extra songs are only scored, never moved.
    expect(plan.order.sort()).toEqual(['jazz-1', 'rap-now']);
  });
});

describe('the song playing now shapes the queue at once (MOOD-NOW-001)', () => {
  // WP6 (D2): this is the v1 behaviour (the song playing is full evidence from second 0); kept on mood_plan 'v1'.
  it('with nothing finished yet, a rap song playing brings the rap songs ahead of smooth jazz', async () => {
    const { api } = await open({ mood_plan: 'v1' });
    const upcoming = [jazz(1), jazz(2), country(1), song('rap-a', 'rap'), song('rap-b', 'rap')];
    const plan = (await api.handle('POST', '/api/mood', { upcoming: upcoming.map((track) => ({ track })), current: { track: rapNow } })).body as Plan;
    expect(plan.changed).toBe(true);
    expect(plan.order.slice(0, 2).sort()).toEqual(['rap-a', 'rap-b']);
  });
  // WP6 (M2, D2) on v2: at second 0 the song playing alone does not re-arrange the queue.
  it('v2: at second 0 the song playing alone does not re-arrange the queue', async () => {
    const { api } = await open();
    const upcoming = [jazz(1), jazz(2), country(1), song('rap-a', 'rap'), song('rap-b', 'rap')];
    const plan = (await api.handle('POST', '/api/mood', { upcoming: upcoming.map((track) => ({ track })), current: { track: rapNow, heard: 0 } })).body as Plan;
    expect(plan.changed).toBe(false);
  });
});

describe('the mood finds new songs when the queue has none that fit (MOOD-DISCOVER-001)', () => {
  const queue = Array.from({ length: 12 }, (_, i) => ({ track: i % 2 ? jazz(i) : country(i), rank: i + 1 }));
  it('a finished rap song, with only smooth jazz and country left, starts a search seeded by the mood', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: [{ track: rap1, rank: 0 }, ...queue] });
    await listen(api, rap2, 'like');
    const id = await listen(api, rap1);
    const res = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: id, exclude: ['rap-one'] });
    const body = res.body as { job: string | null; reason?: string; mood?: string[] };
    expect(body.job).toBeTruthy();
    expect(body.mood?.join(' ')).toMatch(/Rap|Hip-hop/);
  });
  it('a queue that already holds songs for the mood is left alone (no provider spend)', async () => {
    const { api, store } = await open();
    const fitting = [song('rap-a', 'rap'), song('rap-b', 'rap'), song('rap-c', 'rap'), song('rap-d', 'rap')].map((track, i) => ({ track, rank: 20 + i }));
    await store.put('last_result', { items: [{ track: rap1, rank: 0 }, ...queue, ...fitting] });
    await listen(api, rap2, 'like');
    const id = await listen(api, rap1);
    const res = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: id, exclude: ['rap-one'] });
    expect((res.body as { job: string | null }).job).toBeNull();
  });
  it('asks at most once every ten minutes, and not at all with discovery while listening off', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: [{ track: rap1, rank: 0 }, ...queue] });
    await listen(api, rap2, 'like');
    const first = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: await listen(api, rap1), exclude: ['rap-one'] });
    expect((first.body as { job: string | null }).job).toBeTruthy();
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    const again = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: await listen(api, rap2, 'complete', 'complete:rap-two:2'), exclude: ['rap-one', 'rap-two'] });
    expect((again.body as { job: string | null }).job).toBeNull();
    const off = await open({ discover_while_listening: false });
    await off.store.put('last_result', { items: [{ track: rap1, rank: 0 }, ...queue] });
    await listen(off.api, rap2, 'like');
    const res = await off.api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: await listen(off.api, rap1), exclude: ['rap-one'] });
    expect((res.body as { job: string | null }).job).toBeNull();
  });
});
