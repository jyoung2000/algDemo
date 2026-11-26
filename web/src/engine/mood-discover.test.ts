/** MOOD-DEFAULT-001: an ordinary Discover run (POST /api/recommend with no trigger) starts from the current mood. No provider calls. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';

const NOW = new Date('2026-11-25T18:00:00Z');
const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
const song = (key: string, genre: string) => ({ key, title: key, artists: [`${key} artist`], provider: 'local', platform_id: key, tags: [tag(genre)], bpm: 120, release: null, duration: 200 });
const rap1 = song('rap-one', 'rap'), elec1 = song('elec-one', 'electronic');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

async function open(settings: Record<string, unknown> = {}) {
  const store = await Store.open(new MemoryBackend());
  await store.put('settings', { adventurous: 0.3, ...settings });
  const api = new LocalApi({ store, port: { request: async () => { throw new Error('offline'); } } as HttpPort, encoder: null });
  // The run itself needs providers; these tests only inspect what it was started from.
  const run = vi.spyOn(api as unknown as { runJob: (...a: unknown[]) => Promise<void> }, 'runJob').mockResolvedValue(undefined);
  return { store, api, run };
}
async function listen(api: LocalApi, t: ReturnType<typeof song>, n = 0) {
  const res = await api.handle('POST', '/api/feedback', { kind: 'complete', event_id: `complete:${t.key}:${n}`, track: t, listened: 200, duration: 200 });
  expect(res.status).toBe(200);
}
const discover = (api: LocalApi) => api.handle('POST', '/api/recommend', {});
const startedFrom = (run: ReturnType<typeof vi.spyOn>) => (run.mock.calls[0]?.[1] as { key: string }[]).map((s) => s.key);

describe('POST /api/recommend with no trigger (ordinary Discover)', () => {
  it('mood present: starts from the listener\'s mood songs and reports the mood lead', async () => {
    const { api, run } = await open();
    await listen(api, rap1); await listen(api, elec1);
    const res = await discover(api);
    expect(res.status).toBe(200);
    const body = res.body as { job: string | null; mood?: string[] };
    expect(body.job).toBeTruthy();
    expect(body.mood?.length ?? 0).toBeGreaterThan(0);
    expect(startedFrom(run)).toEqual(expect.arrayContaining(['rap-one', 'elec-one']));
  });

  it('insufficient mood history: no mood lead, run is unchanged from before', async () => {
    const { api, run } = await open();
    const res = await discover(api);
    expect(res.status).toBe(400); // no history, no seeds, no stars: the existing cold-start message
    expect(run).not.toHaveBeenCalled();
    expect((res.body as { mood?: unknown }).mood).toBeUndefined();
  });

  it('opt-out: mood_queue=false keeps mood out of an ordinary Discover run', async () => {
    const { api, run } = await open({ mood_queue: false });
    await listen(api, rap1); await listen(api, elec1);
    const res = await discover(api);
    expect((res.body as { mood?: unknown }).mood).toBeUndefined();
    expect(startedFrom(run)).not.toEqual(expect.arrayContaining(['rap-one']));
  });
});
