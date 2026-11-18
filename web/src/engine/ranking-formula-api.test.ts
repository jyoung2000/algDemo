import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';

const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
const seed = { key: 'seed|start', title: 'Start', artists: ['Seed'], provider: 'local', platform_id: 'seed', tags: [tag('soul')] };
const songs = ['soul', 'metal'].map((genre, i) => ({ key: `artist${i}|song`, title: `Song ${i}`, artists: [`Artist ${i}`], provider: 'local', platform_id: `song${i}`, tags: [tag(genre)], provenance: [{ seed: seed.key, relation: 'radio', rank: i, source: 'test' }] }));
const port = { request: async () => { throw new Error('Formula tests must not contact providers'); } } as HttpPort;
async function open() {
  const backend = new MemoryBackend(); const store = await Store.open(backend);
  await store.put('last_pool', { cands: songs, seeds: [seed], related: [], settings: { adventurous: 0.5 } });
  return { backend, store, api: new LocalApi({ store, port, encoder: null }) };
}
const rank = async (api: LocalApi) => (await api.handle('POST', '/api/rerank', {})).body as { items: { track: { key: string }; score: number }[] };
describe('editable discovery formula (RANK-FORMULA-001)', () => {
  it('persists a replacement and really changes the scorer, including after restart', async () => {
    const { backend, store, api } = await open();
    expect((await rank(api)).items.some(x => x.score > 0)).toBe(true);
    expect((await api.handle('PUT', '/api/settings', { ranking_formula: '0' })).status).toBe(200);
    expect((await api.handle('GET', '/api/settings')).body).toMatchObject({ ranking_formula: '0' });
    expect((await rank(api)).items.every(x => x.score === 0)).toBe(true);
    await store.flush();
    const restarted = new LocalApi({ store: await Store.open(backend), port, encoder: null });
    expect((await rank(restarted)).items.every(x => x.score === 0)).toBe(true);
    expect((await restarted.handle('PUT', '/api/settings', { ranking_formula: null })).status).toBe(200);
    expect((await rank(restarted)).items.some(x => x.score > 0)).toBe(true);
  });
  it('rejects unsafe or malformed input atomically instead of persisting it', async () => {
    const { api } = await open();
    for (const formula of ['globalThis.fetch(1)', 'base; alert(1)', 'genre +', '1/0', 'missing_signal', '('.repeat(80) + '1' + ')'.repeat(80), '1+'.repeat(1500) + '1', 4, {}]) {
      expect((await api.handle('PUT', '/api/settings', { ranking_formula: formula, adventurous: 0.1 })).status, String(formula).slice(0, 60)).toBe(400);
    }
    expect((await api.handle('GET', '/api/settings')).body).toMatchObject({ adventurous: 0.5 });
  });
  it('reports a per-song domain fallback without breaking discovery', async () => {
    const { api } = await open();
    const before = (await rank(api)).items.find(x => x.track.key === songs[0]!.key)!.score;
    expect((await api.handle('PUT', '/api/settings', { ranking_formula: '1/(provider - 0.85)' })).status).toBe(200);
    const response = await api.handle('POST', '/api/rerank', {});
    const item = (response.body as { items: { track: { key: string }; score: number; uncertainty: string[] }[] }).items.find(x => x.track.key === songs[0]!.key)!;
    expect(item.score).toBe(before); expect(item.uncertainty.join(' ')).toMatch(/built-in score used/);
  });
  it('cannot bring hidden or unavailable candidates back', async () => {
    const { store, api } = await open();
    await api.handle('POST', '/api/feedback', { kind: 'hide', event_id: 'formula-hide', track: songs[0] });
    await api.handle('PUT', '/api/settings', { ranking_formula: '1' });
    const result = await rank(api);
    expect(result.items.some(x => x.track.key === songs[0]!.key)).toBe(false);
    const pool = store.get<{ cands: Record<string, unknown>[] }>('last_pool')!;
    pool.cands[1]!.unavailable = true; await store.put('last_pool', pool);
    const restarted = new LocalApi({ store, port, encoder: null });
    expect((await rank(restarted)).items).toEqual([]);
  });
});
