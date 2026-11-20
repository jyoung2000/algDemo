/**
 * QUEUE-HEARD-001 (owner, 2026-11-20): "my discover queue is the same set of songs even though I listened to every
 * song on the playlist once". The listening top-up counted only the songs played since the page last opened (the
 * page's in-memory set, sent as `exclude`), and never songs the phone's engine played while the page was closed. A
 * queue heard over several sessions therefore always looked mostly unheard, and nothing new was ever added.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';

const row = (i: number) => ({ track: { key: `k${i}`, title: `t${i}`, artists: ['A'], artist: 'A', provider: 'local', platform_id: `k${i}`, tags: [] }, rank: i + 1, reasons: [], playback: {} });
const seed = { key: 'seed', provider: 'deezer', platform_id: '1', title: 'Seed', artists: ['A'], artist: 'A' };

async function open(n = 8) {
  const store = await Store.open(new MemoryBackend());
  const port: HttpPort = { request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('{}'), metered: false }), metered: async () => false };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  await store.put('seeds', [seed]);
  // The listening mood can top up for its own reason (MOOD-DISCOVER-001); off here, so only the heard count decides.
  await api.handle('PUT', '/api/settings', { mood_queue: false });
  await store.put('last_result', { phase: 'final', items: Array.from({ length: n }, (_, i) => row(i)), count: n });
  return { api, store };
}
const listen = (api: LocalApi, kind: 'complete' | 'skip', i: number, id: string) =>
  api.handle('POST', '/api/feedback', { kind, event_id: id, track: row(i).track, listened: kind === 'complete' ? 200 : 20, duration: 210, coverage: kind === 'complete' ? 200 : 20, medium: 'full', origin: 'queue' });
const topUp = async (api: LocalApi, id: string, exclude: string[] = []) =>
  (await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: id, exclude })).body as { job: string | null; reason?: string };

describe('the listening top-up counts every song already heard', () => {
  it('songs heard in an earlier session count as heard, so a queue heard through is topped up', async () => {
    const { api } = await open(8);
    // Seven songs heard yesterday (another page session: the page's own set is empty today).
    for (let i = 0; i < 7; i++) await listen(api, 'complete', i, `complete:k${i}:yesterday`);
    await listen(api, 'complete', 7, 'complete:k7:today');
    const r = await topUp(api, 'complete:k7:today');
    expect(r.reason).toBeUndefined();
    expect(r.job).toBeTruthy();
  });
  it('a skipped song was heard too', async () => {
    const { api } = await open(8);
    for (let i = 0; i < 7; i++) await listen(api, 'skip', i, `skip:k${i}:earlier`);
    await listen(api, 'complete', 7, 'complete:k7:now');
    expect((await topUp(api, 'complete:k7:now')).job).toBeTruthy();
  });
  it('a queue with plenty still unheard is left alone', async () => {
    const { api } = await open(12);
    for (let i = 0; i < 3; i++) await listen(api, 'complete', i, `complete:k${i}:earlier`);
    await listen(api, 'complete', 3, 'complete:k3:now');
    const r = await topUp(api, 'complete:k3:now');
    expect(r.job).toBeNull();
    expect(r.reason).toMatch(/does not need more songs/);
  });
  it('the same listen never starts two top-ups (the phone page and the car engine may both report it)', async () => {
    const { api } = await open(8);
    for (let i = 0; i < 8; i++) await listen(api, 'complete', i, `complete:k${i}:engine-${i}-1000`);
    await listen(api, 'complete', 7, 'complete:k7:engine-7-1000');
    const first = await topUp(api, 'complete:k7:engine-7-1000');
    expect(first.job).toBeTruthy();
    const again = await topUp(api, 'complete:k7:engine-7-1000');
    expect(again.job).toBeNull();
  });
});
