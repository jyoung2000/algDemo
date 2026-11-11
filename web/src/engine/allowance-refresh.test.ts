import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

/**
 * ALLOWANCE-REFRESH-001. Owner: "refresh allowance as quickly as possible, the refresh source
 * button should try to refresh allowance as well."
 *
 * The day's download allowance is what silences discovery, genre reading and the taste colours.
 * Pressing "Check again" in Settings (GET /api/health?refresh=1) now gives the allowance back at
 * once instead of waiting for tomorrow, and says how much it cleared. A plain health read, which
 * the Settings screen does on every open, must NOT clear anything.
 */
const open = async () => {
  const store = await Store.open(new MemoryBackend());
  const port = { request: async () => { throw new Error('no network in this test'); } };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  return { api, store };
};
const spent = (store: Store) => Object.values(store.transferToday()).reduce((a, b) => a + b, 0);
const health = (api: LocalApi, refresh: boolean) =>
  api.handle('GET', `/api/health${refresh ? '?refresh=1' : ''}`).then((r) => r.body as Record<string, unknown>);

describe('refreshing the sources refreshes the day\u2019s allowance (ALLOWANCE-REFRESH-001)', () => {
  it('gives the allowance back and reports what it cleared', { timeout: 30_000 }, async () => {
    const { api, store } = await open();
    store.addTransfer('metadata', 104_000_000);
    store.addTransfer('search', 31_000);
    expect(spent(store)).toBe(104_031_000);
    const body = await health(api, true);
    expect(spent(store)).toBe(0);
    expect(body['allowance_refreshed']).toMatchObject({ cleared_bytes: 104_031_000 });
  });

  it('leaves the count alone when the screen is only reading health', { timeout: 30_000 }, async () => {
    const { api, store } = await open();
    store.addTransfer('metadata', 5_000_000);
    const body = await health(api, false);
    expect(spent(store)).toBe(5_000_000);
    expect(body['allowance_refreshed']).toBeUndefined();
  });

  it('lets a refused search be asked again right away', { timeout: 30_000 }, async () => {
    const { api, store } = await open();
    await api.handle('POST', '/api/settings', { daily_mb: 100 });
    store.addTransfer('metadata', 100_000_000);
    const before = (await api.handle('GET', '/api/status')).body as { transfer_today: Record<string, number> };
    expect(Object.values(before.transfer_today).reduce((a, b) => a + b, 0)).toBe(100_000_000);
    await health(api, true);
    const after = (await api.handle('GET', '/api/status')).body as { transfer_today: Record<string, number> };
    expect(Object.values(after.transfer_today).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('clears only today, so yesterday\u2019s record is kept', { timeout: 30_000 }, async () => {
    const { api, store } = await open();
    store.addTransfer('metadata', 7_000_000, '2000-01-01');
    store.addTransfer('metadata', 9_000_000);
    await health(api, true);
    expect(spent(store)).toBe(0);
    expect(Object.values(store.transferToday('2000-01-01')).reduce((a, b) => a + b, 0)).toBe(7_000_000);
  });
});
