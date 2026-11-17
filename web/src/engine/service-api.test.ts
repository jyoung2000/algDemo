import { describe, expect, it, vi } from 'vitest';
import type { Track } from '../api';
import { QueuePreloader } from './queue-preload';
import { RemoteQueue } from './queue-remote';
import { CarSources, ServiceActor, type CarContext } from './service-actor';
import { nativeApiBridge, ServiceClient, ServiceError, type Scheduler } from './service-client';

const track = (key: string): Track => ({ key, title: `T ${key}`, artist: 'A', provider: 'deezer', platform_id: key } as unknown as Track);

function fakeScheduler() {
  const timers = new Map<number, () => void>();
  let n = 0;
  const s: Scheduler = { set: (fn) => { timers.set(++n, fn); return n; }, clear: (h) => { timers.delete(h as number); } };
  return { s, timers, fire: () => { for (const [k, f] of [...timers]) { timers.delete(k); f(); } } };
}

describe('ServiceClient', () => {
  it('resolves the matching id and ignores unknown, stale and duplicate replies', async () => {
    const sent: [number, string][] = [];
    const c = new ServiceClient({ api: (id, json) => sent.push([id, json]) }, fakeScheduler().s);
    const p = c.request('POST', '/api/x', { a: 1 });
    expect(JSON.parse(sent[0]![1])).toEqual({ method: 'POST', path: '/api/x', body: { a: 1 } });
    expect(c.receive(999, '{"status":200,"body":1}')).toBe(false);
    expect(c.receive('1', '{"status":200,"body":1}')).toBe(false);
    expect(c.receive(sent[0]![0], '{"status":201,"body":{"ok":true},"cacheSnapshot":{}}')).toBe(true);
    await expect(p).resolves.toMatchObject({ status: 201, body: { ok: true } });
    expect(c.receive(sent[0]![0], '{"status":200,"body":2}')).toBe(false);
    expect(c.pendingCount).toBe(0);
  });

  it('times out on its scheduler and then treats the late reply as stale', async () => {
    const f = fakeScheduler();
    const ids: number[] = [];
    const c = new ServiceClient({ api: (id) => ids.push(id) }, f.s, { timeoutMs: 10 });
    const p = c.request('GET', '/api/a');
    f.fire();
    await expect(p).rejects.toMatchObject({ reason: 'timeout' });
    expect(c.receive(ids[0], '{"status":200,"body":null}')).toBe(false);
  });

  it('cancels on abort, clears its timer, and refuses an already aborted signal', async () => {
    const f = fakeScheduler();
    const c = new ServiceClient({ api: () => undefined }, f.s);
    const ctl = new AbortController();
    const p = c.request('GET', '/api/a', null, ctl.signal);
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(ServiceError);
    expect(f.timers.size).toBe(0);
    expect(c.pendingCount).toBe(0);
    await expect(c.request('GET', '/api/a', null, ctl.signal)).rejects.toMatchObject({ reason: 'aborted' });
  });

  it('rejects bridge failures, malformed replies and requests beyond the bound', async () => {
    const thrower = new ServiceClient({ api: () => { throw new Error('gone'); } }, fakeScheduler().s);
    await expect(thrower.request('GET', '/x')).rejects.toMatchObject({ reason: 'bridge' });
    expect(thrower.pendingCount).toBe(0);
    const ids: number[] = [];
    const c = new ServiceClient({ api: (id) => ids.push(id) }, fakeScheduler().s, { maxPending: 1 });
    const p = c.request('GET', '/x');
    await expect(c.request('GET', '/y')).rejects.toMatchObject({ reason: 'busy' });
    expect(c.receive(ids[0], '{"nope":1}')).toBe(true);
    await expect(p).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('detects the UI bridge by capability, never on the service page or old shells', () => {
    expect(nativeApiBridge(undefined)).toBeNull();
    expect(nativeApiBridge({ AirwaveNative: {} })).toBeNull();
    expect(nativeApiBridge({ AirwaveNative: { api: () => undefined, serviceApiVersion: () => 1 } })).toBeNull();
    const api = vi.fn();
    nativeApiBridge({ AirwaveNative: { api } })!.api(3, '{}');
    expect(api).toHaveBeenCalledWith(3, '{}');
  });
});

/** A real QueuePreloader over a fake shell library: readiness is whatever the test says the disk holds. */
function realQueue() {
  const status = new Map<string, string>();
  const disk = new Set<string>();
  const subs = new Set<() => void>();
  const q = new QueuePreloader({
    library: {
      status: (u) => status.get(u) ?? 'unknown', error: () => null, ensure: async () => undefined, subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
      // What the disk holds, learned only when asked (SHUFFLE-START-001).
      refresh: async (u) => { if (disk.has(u)) status.set(u, 'ready'); else status.set(u, 'missing'); },
    },
    known: (t) => `https://src/${t.key}`,
    resolve: async (t) => `https://src/${t.key}`,
    configure: async () => ({}),
  });
  return { q, status, disk };
}

describe('ServiceActor', () => {
  const setup = (contexts: Record<string, CarContext> = {}) => {
    const { q, status, disk } = realQueue();
    const emit = vi.fn();
    const cars = new CarSources({ contexts: { contextOf: (id) => contexts[id] ?? null }, queue: q, emit });
    const replies: [string, unknown][] = [];
    const local = { handle: vi.fn(async (m: string, p: string, b: unknown) => ({ status: 200, body: { m, p, b } })) };
    const actor = new ServiceActor({ local, queue: q, cars, reply: (id, json) => replies.push([id, JSON.parse(json)]) });
    return { q, status, disk, emit, cars, replies, local, actor };
  };

  it('answers ordinary routes through the one LocalApi and rejects malformed envelopes', async () => {
    const t = setup();
    expect(await t.actor.onRequest('{"id":"r1","method":"GET","path":"/api/library","body":null}')).toBe(true);
    expect(t.local.handle).toHaveBeenCalledWith('GET', '/api/library', null);
    expect(t.replies[0]).toEqual(['r1', { status: 200, body: { m: 'GET', p: '/api/library', b: null } }]);
    expect(await t.actor.onRequest('not json')).toBe(false);
    expect(await t.actor.onRequest('{"method":"GET","path":"/api/x"}')).toBe(false);
    await t.actor.onRequest('{"id":"r2","method":"TRACE","path":"/api/x"}');
    await t.actor.onRequest('{"id":"r3","method":"POST","path":"/_native/unknown","body":{}}');
    await t.actor.onRequest('{"id":"r4","method":"POST","path":"/_native/queue/update","body":{"tracks":[{"title":"no key"}]}}');
    expect(t.replies.slice(1).map(([, r]) => (r as { status: number }).status)).toEqual([400, 404, 400]);
    expect(t.local.handle).toHaveBeenCalledTimes(1);
    t.q.dispose();
  });

  it('returns per-track cache DTOs that only report ready when the library holds the file', async () => {
    const t = setup();
    const a = track('a'), b = track('b');
    t.status.set('https://src/a', 'ready');
    const r = await t.actor.route('POST', '/_native/queue/snapshot', { tracks: [a, b, a] });
    expect(r.status).toBe(200);
    expect((r.body as { counts: { total: number; ready: number } }).counts).toMatchObject({ total: 2, ready: 1 });
    const snap = r.cacheSnapshot as { tracks: { key: string; ready: string | null; source: string | null }[] };
    expect(snap.tracks.map(d => [d.key, d.ready, d.source])).toEqual([['a', 'https://src/a', 'https://src/a'], ['b', null, 'https://src/b']]);
    t.q.dispose();
  });

  it('looks at what is held for a list it was never given, and changes nothing else (SHUFFLE-START-001)', async () => {
    const t = setup();
    const a = track('a'), b = track('b');
    t.disk.add('https://src/b');
    const before = await t.actor.route('POST', '/_native/queue/snapshot', { tracks: [a, b] });
    expect((before.cacheSnapshot as { tracks: { ready: string | null }[] }).tracks.map(d => d.ready)).toEqual([null, null]);
    const r = await t.actor.route('POST', '/_native/queue/look', { tracks: [a, b] });
    expect(r.status).toBe(200);
    expect((r.cacheSnapshot as { tracks: { key: string; ready: string | null }[] }).tracks.map(d => [d.key, d.ready])).toEqual([['a', null], ['b', 'https://src/b']]);
    expect(t.q.snapshot().total).toBe(0);
    expect((await t.actor.route('POST', '/_native/queue/look', { tracks: [{ title: 'no key' }] })).status).toBe(400);
    t.q.dispose();
  });

  it('keeps the car-selected list in charge until the native player leaves it', async () => {
    const list = [track('x1'), track('x2'), track('x3')];
    const ids = list.map(t => `calbum/al/track/${t.key}`);
    const t = setup({ [ids[1]!]: { tracks: list, ids, index: 1 } });
    const update = vi.spyOn(t.q, 'update');
    t.cars.onState(JSON.stringify({ rev: 1, id: 'x2', mediaId: ids[1], waiting: true, playing: false }));
    expect(update).toHaveBeenLastCalledWith([list[1], list[2], list[0]]);
    const ui = [track('u1')];
    const r = await t.actor.route('POST', '/_native/queue/update', { tracks: ui });
    expect((r.body as { applied: boolean }).applied).toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
    // A strictly older revision changes nothing; a song the car never offered releases it and applies
    // the UI list, even at the same revision (EnginePlayer.rev counts only native-made changes).
    t.cars.onState({ rev: 0, mediaId: 'u1' });
    expect(t.cars.owned()).toBe(true);
    t.cars.onState({ rev: 1, mediaId: 'u1' });
    expect(t.cars.owned()).toBe(false);
    expect(update).toHaveBeenLastCalledWith(ui);
    t.q.dispose();
  });

  // CAR-STATE-REV-001: DHU 2026-11-15. EnginePlayer.rev stayed 0 for every state (it counts native-made
  // changes only), so the cold start's first state (a restored song, no search yet) set rev 0 and every
  // later state, including the car tap after a search, was dropped as stale: the song waited forever.
  it('acts on a car tap at the same revision as the restored cold-start state', () => {
    const list = [track('n1'), track('n2')];
    const known: Record<string, CarContext> = {};
    const t = setup();
    (t.cars as unknown as { d: { contexts: { contextOf(id: string): CarContext | null } } }).d.contexts = { contextOf: (id) => known[id] ?? null };
    const update = vi.spyOn(t.q, 'update');
    t.cars.onState({ rev: 0, mediaId: 'n1', waiting: true }); // restored before any search: not known yet
    expect(t.cars.owned()).toBe(false);
    known['n1'] = { tracks: list, ids: ['n1', 'n2'], index: 0 }; // the car searched; the row is known now
    t.cars.onState({ rev: 0, mediaId: 'n1', waiting: true }); // the tap: same rev, same song
    expect(t.cars.owned()).toBe(true);
    expect(update).toHaveBeenLastCalledWith(list);
    update.mockClear();
    t.cars.onState({ rev: 0, mediaId: 'n1', waiting: true }); // the 250 ms repeat: nothing new to do
    expect(update).not.toHaveBeenCalled();
    t.q.dispose();
  });

  it('emits source patches only from files the cache holds, once per change', () => {
    const list = [track('y1'), track('y2')];
    const t = setup({ y1: { tracks: list, ids: ['y1', 'y2'], index: 0 } });
    t.cars.onState({ rev: 5, mediaId: 'y1', waiting: true });
    expect(t.emit).not.toHaveBeenCalled();
    t.status.set('https://src/y2', 'ready');
    t.cars.flush();
    expect(t.emit).toHaveBeenCalledWith([{ id: 'y2', key: 'y2', ready: true, source: 'https://src/y2' }]);
    t.cars.flush();
    expect(t.emit).toHaveBeenCalledTimes(1);
    t.status.set('https://src/y2', 'missing');
    t.cars.flush();
    expect(t.emit).toHaveBeenLastCalledWith([{ id: 'y2', key: 'y2', ready: false, source: null }]);
    t.q.dispose();
  });

  it('refuses unknown or forged car ids for ownership and context lookup', async () => {
    const t = setup();
    t.cars.onState({ rev: 1, mediaId: 'calbum/forged/track/zz' });
    expect(t.cars.owned()).toBe(false);
    const r = await t.actor.route('POST', '/_native/context', { id: 'calbum/forged/track/zz' });
    expect(r.status).toBe(404);
    t.q.dispose();
  });
});

describe('RemoteQueue', () => {
  it('reports nothing ready until the service answers, then exactly what it reported', async () => {
    let resolve!: (v: { status: number; body: unknown; cacheSnapshot?: unknown }) => void;
    const request = vi.fn(() => new Promise<{ status: number; body: unknown; cacheSnapshot?: unknown }>(r => { resolve = r; }));
    const q = new RemoteQueue({ request }, () => 0);
    const a = track('a'), b = track('b');
    const listener = vi.fn();
    q.subscribe(listener);
    expect(q.snapshotFor([a, b])).toMatchObject({ total: 2, ready: 0, queued: 2 });
    expect(request).toHaveBeenCalledWith('POST', '/_native/queue/snapshot', { tracks: [a, b] });
    expect(q.readyUrl(a)).toBeNull();
    const facts = { status: 'ready', blocked: false, inTarget: true, error: null, givenUp: false };
    resolve({
      status: 200,
      body: { counts: { total: 2, ready: 1, active: 0, failed: 0, blocked: false, queued: 1, parallel: 2, bulkActive: false, retrying: 0 } },
      cacheSnapshot: { tracks: [{ key: 'a', source: 'https://s/a', ready: 'https://s/a', facts }, { key: 'b', source: 7, ready: null, facts }], expired: ['z'] },
    });
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(q.readyUrl(a)).toBe('https://s/a');
    expect(q.isReady(b)).toBe(false);
    expect(q.sourceHint(b)).toBeNull();
    expect([...q.expiredKeys()]).toEqual(['z']);
    expect(q.snapshotFor([a, b])).toMatchObject({ ready: 1, queued: 1 });
    expect(q.cardOf('a', { kept: false, percent: null }).state).toBe('ready');
    expect(q.cardOf('b', { kept: false, percent: null }).state).toBe('queued');
  });

  it('look() asks the service and then knows what it holds (SHUFFLE-START-001)', async () => {
    const facts = { status: 'ready', blocked: false, inTarget: false, error: null, givenUp: false };
    const request = vi.fn(async () => ({ status: 200, body: {}, cacheSnapshot: { tracks: [{ key: 'b', source: 'https://s/b', ready: 'https://s/b', facts }], expired: [] } }));
    const q = new RemoteQueue({ request });
    const a = track('a'), b = track('b');
    expect(q.isReady(b)).toBe(false);
    await q.look([a, b]);
    expect(request).toHaveBeenCalledWith('POST', '/_native/queue/look', { tracks: [a, b] });
    expect([q.isReady(a), q.isReady(b)]).toEqual([false, true]);
  });

  it('surfaces service errors and never contacts the service after dispose', async () => {
    const request = vi.fn(async () => ({ status: 400, body: { message: 'Bad engine request.' } }));
    const q = new RemoteQueue({ request });
    await expect(q.protect(1, [])).rejects.toThrow('Bad engine request.');
    q.dispose();
    request.mockClear();
    q.update([track('a')]);
    q.retryFailed();
    expect(request).not.toHaveBeenCalled();
  });
});
