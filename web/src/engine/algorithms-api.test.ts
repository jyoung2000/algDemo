/** ALGO-MANAGER-001 through the real LocalApi: persistence, legacy migration and the active algorithm driving ranking. */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';
import { BUILT_IN_ALGORITHM, BUILT_IN_ID, MIGRATED_ID, createFrom, setParam, type Algorithm } from './algorithms';

const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
const seed = { key: 'seed|start', title: 'Start', artists: ['Seed'], provider: 'local', platform_id: 'seed', tags: [tag('soul')] };
const songs = ['soul', 'metal', 'soul'].map((genre, i) => ({ key: `artist${i}|song`, title: `Song ${i}`, artists: [`Artist ${i}`], provider: 'local', platform_id: `song${i}`, tags: [tag(genre)], provenance: [{ seed: seed.key, relation: 'radio', rank: i * 4, source: 'test' }] }));
const port = { request: async () => { throw new Error('Algorithm tests must not contact providers'); } } as HttpPort;
async function open(settings?: Record<string, unknown>) {
  const backend = new MemoryBackend(); const store = await Store.open(backend);
  await store.put('last_pool', { cands: songs, seeds: [seed], related: [], settings: { adventurous: 0.5 } });
  if (settings) await store.put('settings', settings);
  return { backend, store, api: new LocalApi({ store, port, encoder: null }) };
}
type Ranked = { items: { track: { key: string }; score: number }[] };
const rank = async (api: LocalApi) => Object.fromEntries(((await api.handle('POST', '/api/rerank', {})).body as Ranked).items.map((x) => [x.track.key, x.score]));
const get = async (api: LocalApi) => (await api.handle('GET', '/api/settings')).body as Record<string, unknown>;

describe('algorithm settings in the engine (ALGO-MANAGER-001)', () => {
  it('a param change in the active algorithm changes scores; the built-in restores them exactly, also after restart', async () => {
    const { backend, store, api } = await open();
    const builtIn = await rank(api);
    expect(await get(api)).toMatchObject({ algorithms: [], active_algorithm: BUILT_IN_ID, ranking_formula: null });
    const mine: Algorithm = { ...createFrom(BUILT_IN_ALGORITHM, 'Genre first', 'user-genre'), params: setParam(BUILT_IN_ALGORITHM.params, 'seedWeights.genre', 0.9) };
    expect((await api.handle('PUT', '/api/settings', { algorithms: [mine], active_algorithm: mine.id })).status).toBe(200);
    const genreFirst = await rank(api);
    expect(genreFirst).not.toEqual(builtIn);
    await store.flush();
    const restarted = new LocalApi({ store: await Store.open(backend), port, encoder: null });
    expect(await get(restarted)).toMatchObject({ active_algorithm: 'user-genre', algorithms: [expect.objectContaining({ name: 'Genre first' })] });
    expect(await rank(restarted)).toEqual(genreFirst);
    expect((await restarted.handle('PUT', '/api/settings', { active_algorithm: BUILT_IN_ID })).status).toBe(200);
    expect(await rank(restarted)).toEqual(builtIn);
  });

  it('migrates legacy weights and ranking_formula once into the active "My formula" without changing ranking', async () => {
    const legacy = { adventurous: 0.5, weights: { genre: 0.6, provider: 0.05 }, ranking_formula: 'affinity * 0.9' };
    const { store, api } = await open(legacy);
    const migrated = await get(api);
    expect(migrated).toMatchObject({ active_algorithm: MIGRATED_ID, ranking_formula: 'affinity * 0.9', algorithms: [expect.objectContaining({ id: MIGRATED_ID, name: 'My formula', finalFormula: 'affinity * 0.9' })] });
    expect(migrated['weights']).toBeUndefined();
    const legacyScores = await rank(api);
    // The same algorithm saved explicitly ranks identically, so the migration did not move anything.
    const explicit = await open({ adventurous: 0.5, algorithms: migrated['algorithms'], active_algorithm: MIGRATED_ID });
    expect(await rank(explicit.api)).toEqual(legacyScores);
    const builtIn = await open();
    expect(await rank(builtIn.api)).not.toEqual(legacyScores);
    // The next save persists the migrated shape; the legacy keys are gone from storage.
    expect((await api.handle('PUT', '/api/settings', { fresh: false })).status).toBe(200);
    const stored = store.get<Record<string, unknown>>('settings')!;
    expect(stored['weights']).toBeUndefined();
    expect(stored['ranking_formula']).toBeUndefined();
    expect(stored).toMatchObject({ active_algorithm: MIGRATED_ID, algorithms: [expect.objectContaining({ id: MIGRATED_ID })] });
    expect(await rank(api)).toEqual(legacyScores);
  });

  it('rejects invalid algorithm input atomically', async () => {
    const { api } = await open();
    const good = createFrom(BUILT_IN_ALGORITHM, 'Fine', 'user-fine');
    const bad = [
      { algorithms: [{ ...good, params: setParam(good.params, 'coverageFloor', 2) }] },
      { algorithms: [{ ...good, finalFormula: 'globalThis.fetch(1)' }] },
      { algorithms: [good, good] },
      { algorithms: [{ ...good, builtIn: true }] },
      { active_algorithm: 'missing' },
      { algorithms: 'nope' },
    ];
    for (const body of bad) {
      const r = await api.handle('PUT', '/api/settings', { ...body, adventurous: 0.1 });
      expect(r.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(String((r.body as { detail: string }).detail)).toMatch(/[A-Z]/);
    }
    expect(await get(api)).toMatchObject({ adventurous: 0.5, algorithms: [], active_algorithm: BUILT_IN_ID });
  });
});
