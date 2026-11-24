/**
 * WP0 step 4: section 4 targets for the recommendation algorithm (A1, A2, A3, A4), through the real LocalApi with a
 * fake Deezer. Landed packages (WP1, WP3) are plain assertions; WP2 is `it.fails` until it lands.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from '../local-api';
import { MemoryBackend, Store } from '../store';
import type { HttpPort } from '../net';
import type { RecItem } from '../../api';
import { classifyNext, mergeRerank } from '../../util';
import { needsListeningDiscovery, LISTENING_LOW_WATER } from '../discovery';
import { fakeDeezer } from './fixtures';

type Dict = Record<string, unknown>;
const SEED = { key: 'artist 1|seed', provider: 'deezer', platform_id: '5', title: 'Seed', artists: ['Artist 1'], artist: 'Artist 1' };

async function open(port: HttpPort = fakeDeezer()) {
  const store = await Store.open(new MemoryBackend());
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/seeds', { seeds: [SEED] });
  await api.handle('PUT', '/api/settings', { mood_queue: false, queue_size: 10 });
  return { api, store };
}

async function run(api: LocalApi, body: Dict = {}): Promise<Dict> {
  const r = await api.handle('POST', '/api/recommend', body);
  const job = (r.body as { job: string }).job;
  for (let i = 0; i < 400; i++) {
    const s = (await api.handle('GET', `/api/jobs/${job}`)).body as Dict;
    if (s['done']) {
      expect(s['error'] ?? null).toBeNull();
      return s;
    }
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('job never finished');
}

const queueOf = (store: Store) => ((store.get<Dict>('last_result')?.['items'] ?? []) as RecItem[]);
const rerank = async (api: LocalApi, exclude: string[] = []) => ((await api.handle('POST', '/api/rerank', { exclude })).body as { items: RecItem[] }).items;

describe('A1/A4 (WP1): a re-rank only reorders', () => {
  it('a re-rank adds 0 rows to a 10-song queue, and drops 0 unheard rows', async () => {
    const { api, store } = await open();
    await run(api);
    const queue = queueOf(store);
    expect(queue.length).toBe(10);
    // The plan's "pool 43 vs queue 10" precondition (A1) no longer describes the code: WP2 stores the pool as the queue
    // rows plus this run's chosen rows, and keeps the non-chosen candidates on a separate `bench` (pool-carry.ts).
    // The guard that matters now is that a re-rank cannot pull a bench row into the queue, so the bench must exist.
    const bench = store.get<{ bench?: Dict[] }>('last_pool')?.bench ?? [];
    expect(bench.length).toBeGreaterThan(0);
    const benchKeys = new Set(bench.map((c) => c['key']));
    // A4: two rows heard in an earlier session (not in the page's `exclude`) score higher; they must not push unheard
    // rows of the same artist out.
    for (const [i, x] of queue.slice(0, 2).entries()) {
      await api.handle('POST', '/api/feedback', { kind: 'complete', event_id: `complete:${x.track.key}:${i}`, track: x.track, listened: 180, duration: 180, coverage: 180, medium: 'full', origin: 'queue' });
    }
    const out = await rerank(api, []);
    const queued = new Set(queue.map((x) => x.track.key));
    const added = out.filter((x) => !queued.has(x.track.key));
    const returned = new Set(out.map((x) => x.track.key));
    const droppedUnheard = queue.slice(2).filter((x) => !returned.has(x.track.key));
    expect(added.length).toBe(0);
    expect(droppedUnheard.length).toBe(0);
    expect(out.length).toBe(queue.length);
    expect(out.filter((x) => benchKeys.has(x.track.key)).length).toBe(0);
  });

  it('mergeRerank keeps exact membership of the queue', async () => {
    const { api, store } = await open();
    await run(api);
    const queue = queueOf(store);
    const out = await rerank(api, [queue[0]!.track.key]);
    const merged = mergeRerank(queue, out, new Set([queue[0]!.track.key]));
    expect(merged.map((x) => x.track.key).sort()).toEqual(queue.map((x) => x.track.key).sort());
    expect(merged[0]!.track.key).toBe(queue[0]!.track.key);
  });
});

describe('A2 (WP2): evidence survives a top-up', () => {
  // NOT LANDED (WP2): the carried row is the cleaned UI track, which has no provenance, so its provider factor is gone.
  it('a row carried over by a top-up keeps its provenance and its provider factor', async () => {
    const { api, store } = await open();
    await run(api);
    const carried = queueOf(store).find((x) => typeof x.factors['provider'] === 'number')!;
    expect(carried).toBeTruthy();
    await run(api); // a second batch: the first run's rows are carried into the new pool
    const cand = (store.get<{ cands: Dict[] }>('last_pool')?.cands ?? []).find((c) => c['key'] === carried.track.key);
    expect(cand).toBeTruthy();
    expect(Array.isArray(cand!['provenance']) && (cand!['provenance'] as unknown[]).length > 0).toBe(true);
    const again = (await rerank(api)).find((x) => x.track.key === carried.track.key)!;
    expect(again.factors['provider']).toBe(carried.factors['provider']);
  });
});

describe('A3 (WP3): every way a song ends is recorded', () => {
  it('a Next press at 20 s / 60 s / 90% of a 3-minute song is skip / partial / complete', () => {
    expect([20, 60, 162].map((s) => classifyNext(s, s, 180, 'full'))).toEqual(['skip', 'partial', 'complete']);
  });

  it('a partial listen counts as heard and asks for a top-up at low water', () => {
    expect(needsListeningDiscovery(true, 'partial', true, LISTENING_LOW_WATER)).toBe(true);
    expect(needsListeningDiscovery(true, 'partial', true, LISTENING_LOW_WATER + 1)).toBe(false);
  });

  it('skipping the last 5 songs at 20 s each starts a top-up', async () => {
    const port: HttpPort = { request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('{}'), metered: false }), metered: async () => false };
    const { api, store } = await open(port);
    const rows = Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, reasons: [], playback: {}, track: { key: `k${i}`, title: `t${i}`, artists: [`A${i}`], artist: `A${i}`, provider: 'local', platform_id: `k${i}`, tags: [] } }));
    await store.put('last_result', { phase: 'final', items: rows, count: rows.length });
    for (let i = 0; i < 5; i++) await api.handle('POST', '/api/feedback', { kind: 'complete', event_id: `complete:k${i}:e`, track: rows[i]!.track, listened: 180, duration: 180, coverage: 180, medium: 'full', origin: 'queue' });
    const kind = classifyNext(20, 20, 180, 'full');
    expect(kind).toBe('skip');
    const jobs: (string | null)[] = [];
    for (let i = 5; i < 10; i++) {
      const id = `${kind}:k${i}:e`;
      await api.handle('POST', '/api/feedback', { kind, event_id: id, track: rows[i]!.track, listened: 20, duration: 180, coverage: 20, medium: 'full', origin: 'queue' });
      jobs.push(((await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: id, exclude: [] })).body as { job: string | null }).job);
    }
    expect(jobs.some(Boolean)).toBe(true);
  });
});
