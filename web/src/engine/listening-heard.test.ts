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

// AA-TOPUP-60-001 (owner, 2026-11-25): the car's queue finds more songs once 60% of its songs have been played for the
// first time. A complete or partial play counts as a first play; a skip alone does not.
const settleJobs = async (api: LocalApi) => {
  for (let i = 0; i < 400; i++) {
    const j = (api as unknown as { currentJob: string | null }).currentJob;
    const job = j ? (api as unknown as { jobs: Map<string, { done: boolean }> }).jobs.get(j) : undefined;
    if (!j || !job || job.done) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};
describe('AA-TOPUP-60-001: the queue tops up at 60% of its songs played for the first time', () => {
  it('11 first plays of a 20-song queue is 55%: refused', async () => {
    const { api } = await open(20);
    for (let i = 0; i < 11; i++) await listen(api, 'complete', i, `complete:k${i}:a`);
    const r = await topUp(api, 'complete:k10:a');
    expect(r.job).toBeNull();
    expect(r.reason).toMatch(/does not need more/);
  });
  it('12 first plays of a 20-song queue is 60%: admitted', async () => {
    const { api } = await open(20);
    for (let i = 0; i < 12; i++) await listen(api, 'complete', i, `complete:k${i}:a`);
    const r = await topUp(api, 'complete:k11:a');
    expect(r.reason).toBeUndefined();
    expect(r.job).toBeTruthy();
  });
  it('skips are not first plays: 11 skipped songs and one finished song is 1 of 20, refused', async () => {
    const { api } = await open(20);
    for (let i = 0; i < 11; i++) await listen(api, 'skip', i, `skip:k${i}:a`);
    await listen(api, 'complete', 11, 'complete:k11:a');
    const r = await topUp(api, 'complete:k11:a');
    expect(r.job).toBeNull();
    expect(r.reason).toMatch(/does not need more/);
  });
  it('replays of one song are one first play, refused', async () => {
    const { api } = await open(20);
    for (let i = 0; i < 6; i++) await listen(api, 'complete', 0, `complete:k0:replay-${i}`);
    const r = await topUp(api, 'complete:k0:replay-5');
    expect(r.job).toBeNull();
    expect(r.reason).toMatch(/does not need more/);
  });
  it('after a granted top-up, replays do not re-ask; the next new first play does', async () => {
    const { api, store } = await open(20);
    for (let i = 0; i < 12; i++) await listen(api, 'complete', i, `complete:k${i}:a`);
    expect((await topUp(api, 'complete:k11:a')).job).toBeTruthy();
    await settleJobs(api);
    await listen(api, 'complete', 0, 'complete:k0:replay');
    const again = await topUp(api, 'complete:k0:replay');
    expect(again.job).toBeNull();
    // Queue grows to 40 songs by the top-up; 12 heard is 30%, so the denominator is the whole queue.
    await store.put('last_result', { phase: 'final', items: Array.from({ length: 40 }, (_, i) => row(i)), count: 40 });
    await listen(api, 'complete', 12, 'complete:k12:grown');
    expect((await topUp(api, 'complete:k12:grown')).job).toBeNull();
    for (let i = 13; i < 23; i++) await listen(api, 'complete', i, `complete:k${i}:grown`);
    expect((await topUp(api, 'complete:k22:grown')).job).toBeNull(); // 23 of 40 = 57.5%
    await listen(api, 'complete', 23, 'complete:k23:grown');
    const r = await topUp(api, 'complete:k23:grown'); // 24 of 40 = 60%, a new first play since the last top-up
    expect(r.job).toBeTruthy();
  });
});
