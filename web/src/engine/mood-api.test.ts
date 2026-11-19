/** MOOD-QUEUE-001 through the real engine route, persistent Store and feedback rows; no provider calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';

const NOW = new Date('2026-11-19T18:00:00Z');
const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
const song = (key: string, genre: string) => ({ key, title: key, artists: [`${key} artist`], provider: 'local', platform_id: key, tags: [tag(genre)], bpm: 120, release: null, duration: 200 });
const rap1 = song('rap-one', 'rap'), elec1 = song('elec-one', 'electronic'), rap2 = song('rap-two', 'hip hop');
const jazzA = song('jazz-a', 'smooth jazz'), jazzB = song('jazz-b', 'smooth jazz'), rapNext = song('rap-next', 'rap'), elecNext = song('elec-next', 'electronic');
const upcoming = [jazzA, jazzB, rapNext, elecNext];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

async function open(settings: Record<string, unknown> = {}) {
  const store = await Store.open(new MemoryBackend());
  await store.put('settings', { adventurous: 0.3, ...settings });
  const api = new LocalApi({ store, port: { request: async () => { throw new Error('offline'); } } as HttpPort, encoder: null });
  return { store, api };
}
async function listen(api: LocalApi, t: ReturnType<typeof song>, kind = 'complete', n = 0) {
  const res = await api.handle('POST', '/api/feedback', { kind, event_id: `${kind}:${t.key}:${n}`, track: t, listened: kind === 'skip' ? 5 : 200, duration: 200 });
  expect(res.status).toBe(200);
}
const ask = (api: LocalApi, shown?: string[]) => api.handle('POST', '/api/mood', { upcoming: upcoming.map((track) => ({ track })), shown, current: { track: rap2 } });
type Plan = { order: string[]; changed: boolean; leading: string[]; off?: boolean };

describe('POST /api/mood', () => {
  it('after rap and electronic, rap and electronic come before smooth jazz', async () => {
    const { api } = await open();
    await listen(api, rap1); await listen(api, elec1);
    const res = await ask(api);
    expect(res.status).toBe(200);
    const plan = res.body as Plan;
    expect(plan.changed).toBe(true);
    expect(plan.order.slice(0, 2).sort()).toEqual(['elec-next', 'rap-next']);
    expect(plan.leading.length).toBeGreaterThan(0);
  });

  it('is off when the setting is off: the order comes back unchanged', async () => {
    const { api } = await open({ mood_queue: false });
    await listen(api, rap1); await listen(api, elec1);
    const plan = (await ask(api)).body as Plan;
    expect(plan.off).toBe(true);
    expect(plan.changed).toBe(false);
    expect(plan.order).toEqual(upcoming.map((t) => t.key));
  });

  it('the setting defaults on and can be switched off through the settings route', async () => {
    const { api } = await open();
    expect(((await api.handle('GET', '/api/settings')).body as { mood_queue: boolean }).mood_queue).toBe(true);
    await api.handle('PUT', '/api/settings', { mood_queue: false });
    expect(((await api.handle('GET', '/api/settings')).body as { mood_queue: boolean }).mood_queue).toBe(false);
  });

  it('a dislike of smooth jazz pushes the other smooth jazz song back', async () => {
    const { api } = await open();
    await listen(api, jazzA, 'dislike');
    const plan = (await api.handle('POST', '/api/mood', { upcoming: [jazzB, rapNext, elecNext].map((track) => ({ track })) })).body as Plan;
    expect(plan.order[0]).not.toBe('jazz-b');
  });

  it('listening more than 90 minutes ago does not steer the queue', async () => {
    const { api } = await open();
    await listen(api, rap1); await listen(api, elec1);
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3600_000));
    const plan = (await api.handle('POST', '/api/mood', { upcoming: upcoming.map((track) => ({ track })) })).body as Plan;
    expect(plan.changed).toBe(false);
  });

  it('keeps the order on screen when a new answer is no better', async () => {
    const { api } = await open();
    await listen(api, rap1); await listen(api, elec1);
    const first = (await ask(api)).body as Plan;
    const again = (await ask(api, first.order)).body as Plan;
    expect(again.changed).toBe(false);
    expect(again.order).toEqual(first.order);
  });
  it('CAR-MOOD-001: a press sent with the question (phone closed) counts once, and the page\'s later copy is not counted again', async () => {
    const { api, store } = await open();
    const first = await api.handle('POST', '/api/mood', { upcoming: upcoming.map((track) => ({ track })), signal: { track: rap1, kind: 'like' } });
    expect((first.body as Plan).order.slice(0, 1)).toEqual(['rap-next']);
    expect((store.get<unknown[]>('mood_log') ?? []).length).toBe(1);
    // The page opens later and saves the same star as feedback: the engine must not count it twice.
    await listen(api, rap1, 'like');
    const n = (api as unknown as { moodSignalsForTest: () => { key: string; kind: string }[] }).moodSignalsForTest()
      .filter((x) => x.key === 'rap-one' && x.kind === 'like').length;
    expect(n).toBe(1);
  });
  it('CAR-MOOD-001: ignores a press kind it does not know', async () => {
    const { api, store } = await open();
    await api.handle('POST', '/api/mood', { upcoming: upcoming.map((track) => ({ track })), signal: { track: rap1, kind: 'delete-everything' } });
    expect(store.get<unknown[]>('mood_log') ?? []).toEqual([]);
  });
});
