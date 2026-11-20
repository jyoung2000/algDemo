/**
 * ALLOWANCE-ARCH-001 through the real LocalApi (owner, 2026-11-20: "the allowance shouldn't apply on wifi, keep 100mb as
 * default, full song download shouldn't get limited"). With the allowance used up on mobile data: a search the listener
 * typed is still asked, background genre look-ups and listening top-ups wait and say when they resume, and on Wi-Fi
 * nothing waits at all.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { RESERVE_KEY } from './budget';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';

const seed = { key: 'a|one', provider: 'deezer', platform_id: '1', title: 'One', artists: ['A'], artist: 'A' };
const bare = (i: number) => ({ track: { key: `k${i}`, title: `t${i}`, artists: ['A'], provider: 'local', platform_id: `k${i}`, tags: [] }, rank: i + 1, reasons: [], playback: {} });

/** A shell that answers every request with an empty JSON object and counts the asks. */
function shell(metered?: boolean | null) {
  const asked: string[] = [];
  const port: HttpPort = {
    request: async (req) => { asked.push(req.url); return { status: 200, headers: {}, body: new TextEncoder().encode('{}') }; },
    ...(metered === undefined ? {} : { metered: async () => metered }),
  };
  return { port, asked };
}
async function open(opts: { metered?: boolean | null; empty?: boolean } = {}) {
  const store = await Store.open(new MemoryBackend());
  if (opts.empty) {
    // Empty the reserve, and spend the calendar day the old way too (one bucket for everything).
    await store.put(RESERVE_KEY, { level: 0, at: Date.now() / 1000, capacity: 100_000_000, metered: null });
    store.addTransfer('metadata', 200_000_000);
  }
  const s = shell(opts.metered);
  const api = new LocalApi({ store, port: s.port, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/seeds', { seeds: [seed] });
  return { api, store, asked: s.asked };
}
type Allowance = { capacity: number; level: number; unmetered: boolean; paused: boolean; resumes_at: number | null; today: Record<string, number> };
const allowance = async (api: LocalApi) => ((await api.handle('GET', '/api/status')).body as { allowance: Allowance }).allowance;

describe('the default', () => {
  it('is still 100 MB, and starts full', async () => {
    const { api } = await open();
    expect(((await api.handle('GET', '/api/settings')).body as { daily_mb: number }).daily_mb).toBe(100);
    // (Adding the starting song looks its genres up in the background: a few bytes of this test's empty answers.)
    const a = await allowance(api);
    expect(a).toMatchObject({ capacity: 100_000_000, paused: false, unmetered: false });
    expect(a.level).toBeGreaterThan(99_999_000);
  });
});

describe('with the allowance used up on mobile data', () => {
  it('a search the listener typed is still asked of the services', async () => {
    const { api, asked } = await open({ empty: true, metered: true });
    const r = await api.handle('GET', '/api/search?q=ken%20carson');
    expect(asked.length).toBeGreaterThan(0);
    for (const [name, s] of Object.entries((r.body as { sources: Record<string, { state: string }> }).sources)) expect(s.state, name).not.toBe('budget');
  });
  it('an artist search (Customize) is still asked', async () => {
    const { api, asked } = await open({ empty: true, metered: true });
    const r = await api.handle('GET', '/api/search/artists?q=future');
    expect(asked.length).toBeGreaterThan(0);
    expect((r.body as { why?: string }).why).not.toBe('allowance');
  });
  it('a discovery the listener started is still asked', async () => {
    const { api, asked } = await open({ empty: true, metered: true });
    const r = await api.handle('POST', '/api/recommend', {});
    expect((r.body as { job: string | null }).job).toBeTruthy();
    await new Promise((res) => setTimeout(res, 300));
    expect(asked.length).toBeGreaterThan(0);
  });
  it('background genre look-ups wait, ask nothing, and say when they resume', async () => {
    const { api, store, asked } = await open({ empty: true, metered: true });
    await store.put('last_result', { phase: 'final', items: [bare(0), bare(1)], count: 2 });
    const r = (await api.handle('POST', '/api/queue/genres', { limit: 6 })).body as { spent?: boolean; resumes_at?: number; left: number };
    expect(asked).toEqual([]);
    expect(r.spent).toBe(true);
    expect(r.resumes_at! - Date.now() / 1000).toBeGreaterThan(600);
    expect(r.resumes_at! - Date.now() / 1000).toBeLessThan(1200);
  });
  it('a listening top-up waits and says so', async () => {
    const { api, store, asked } = await open({ empty: true, metered: true });
    await store.put('last_result', { items: [bare(0), bare(1)] });
    await api.handle('POST', '/api/feedback', { kind: 'complete', event_id: 'e1', track: { ...seed, key: 'k0' }, listened: 180, origin: 'queue' });
    const before = asked.length;
    const r = (await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: 'e1', exclude: ['k0'] })).body as { job: string | null; reason?: string; resumes_at?: number };
    expect(r.job).toBeNull();
    expect(r.reason).toMatch(/paused to save mobile data/i);
    expect(r.resumes_at).toBeGreaterThan(Date.now() / 1000);
    expect(asked.length).toBe(before);
  });
  it('the status says it is paused and when it resumes; "Check again" fills it', async () => {
    const { api } = await open({ empty: true, metered: true });
    const a = await allowance(api);
    expect(a).toMatchObject({ paused: true, unmetered: false });
    expect(a.resumes_at).toBeGreaterThan(Date.now() / 1000);
    const h = (await api.handle('GET', '/api/health?refresh=1')).body as { allowance_refreshed?: { restored_bytes: number } };
    expect(h.allowance_refreshed!.restored_bytes).toBeGreaterThan(90_000_000);
    expect(await allowance(api)).toMatchObject({ paused: false });
  }, 30_000);
});

describe('on Wi-Fi the allowance does not apply', () => {
  it('background genre look-ups run with the reserve empty', async () => {
    const { api, store, asked } = await open({ empty: true, metered: false });
    await store.put('last_result', { phase: 'final', items: [bare(0), bare(1)], count: 2 });
    const r = (await api.handle('POST', '/api/queue/genres', { limit: 6 })).body as { spent?: boolean };
    expect(asked.length).toBeGreaterThan(0);
    expect(r.spent).toBeUndefined();
    expect(await allowance(api)).toMatchObject({ unmetered: true, paused: false, resumes_at: null });
  });
  it('a listening top-up runs with the reserve empty', async () => {
    const { api, store } = await open({ empty: true, metered: false });
    await store.put('last_result', { items: [bare(0), bare(1)] });
    await api.handle('GET', '/api/status');
    await api.handle('POST', '/api/feedback', { kind: 'complete', event_id: 'e1', track: { ...seed, key: 'k0' }, listened: 180, origin: 'queue' });
    const r = (await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: 'e1', exclude: ['k0'] })).body as { job: string | null };
    expect(r.job).toBeTruthy();
  });
  // Seen on the phone (2026-11-20): back on Wi-Fi after being paused on mobile data, the engine still held "metered"
  // until something else happened to ask. The song that ends next must top the queue up by itself.
  it('moving from mobile data to Wi-Fi lets the next top-up run, with nothing else asking first', async () => {
    const net = { metered: true };
    const store = await Store.open(new MemoryBackend());
    await store.put(RESERVE_KEY, { level: 0, at: Date.now() / 1000, capacity: 100_000_000, metered: true });
    const port: HttpPort = { request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('{}') }), metered: async () => net.metered };
    const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
    await store.put('seeds', [seed]);
    await store.put('last_result', { items: [bare(0), bare(1)] });
    await new Promise((res) => setTimeout(res, 20)); // the start-up question about the network has been answered: metered
    net.metered = false; // the phone joins Wi-Fi
    await api.handle('POST', '/api/feedback', { kind: 'complete', event_id: 'e1', track: { ...seed, key: 'k0' }, listened: 180, origin: 'queue' });
    const r = (await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: 'e1', exclude: ['k0'] })).body as { job: string | null; reason?: string };
    expect(r.reason).toBeUndefined();
    expect(r.job).toBeTruthy();
  });
  it('a shell that learns the network from an answer applies it from then on', async () => {
    const store = await Store.open(new MemoryBackend());
    await store.put(RESERVE_KEY, { level: 0, at: Date.now() / 1000, capacity: 100_000_000, metered: null });
    const port: HttpPort = { request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('{}'), metered: false }) };
    const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
    expect((await allowance(api)).unmetered).toBe(false);
    await api.handle('GET', '/api/search?q=abc');
    expect((await allowance(api)).unmetered).toBe(true);
  });
});

describe('what was read is counted by lane', () => {
  it('a typed search counts as asked for, not against the reserve', async () => {
    const { api } = await open({ metered: true });
    await api.handle('GET', '/api/search?q=ken%20carson');
    const a = await allowance(api);
    const background = a.today['background'] ?? 0; // the starting song's own genre look-up
    expect(a.today['interactive']).toBeGreaterThan(background);
    expect(a.level).toBeGreaterThanOrEqual(100_000_000 - background);
    expect(background).toBeLessThan(1000);
  });
});
