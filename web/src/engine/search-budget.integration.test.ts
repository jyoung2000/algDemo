/**
 * SRC-BUDGET-001 through the real LocalApi. Owner: when the sources are unavailable because the day's
 * download allowance is spent, say the allowance was all used up. A source refused for that reason is
 * reported as `budget`, not as a plain failure, so the search line can say so and not offer a refresh
 * that cannot help. A single search reaching its own per-request cap is not the day being spent.
 */
import { expect, it } from 'vitest';

import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const open = async (port: { request: (...a: unknown[]) => Promise<never> }) => {
  const store = await Store.open(new MemoryBackend());
  const api = new LocalApi({ store, port: port as never, encoder: null, spotifySearch: () => async () => [] });
  return { api, store };
};
type Sources = Record<string, { state: string; detail?: string }>;
const search = async (api: LocalApi, q: string) => ((await api.handle('GET', `/api/search?q=${encodeURIComponent(q)}`)).body as { sources: Sources }).sources;

it('reports every source as budget once the day\u2019s allowance is spent, and asks none of them', async () => {
  let asked = 0;
  const { api, store } = await open({ request: async () => { asked++; throw new Error('should not be asked'); } });
  await api.handle('PUT', '/api/settings', { daily_mb: 5 });
  store.addTransfer('metadata', 6_000_000);
  const sources = await search(api, 'ken carson');
  expect(Object.keys(sources).length).toBeGreaterThan(0);
  for (const [name, s] of Object.entries(sources)) expect(s.state, name).toBe('budget');
  expect(asked).toBe(0);
});

it('keeps an ordinary network failure a failure while allowance is left', async () => {
  const { api } = await open({ request: async () => { throw new Error('offline'); } });
  const sources = await search(api, 'ken carson');
  for (const [name, s] of Object.entries(sources)) expect(s.state, name).toBe('failed');
});
