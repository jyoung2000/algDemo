/**
 * PLAYLISTS-001 through the real LocalApi: the listener's own saved lists persist, a song can sit
 * in several at once, and a list is only topped up once everything in it has been played.
 */
import { describe, expect, it } from 'vitest';

import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const seed = {
  key: 'a|one',
  provider: 'deezer',
  platform_id: '1',
  title: 'One',
  artists: ['A'],
  artist: 'A',
};

const open = async () => {
  const backend = new MemoryBackend();
  const store = await Store.open(backend);
  const port = {
    request: async () => {
      throw new Error('no network in this test');
    },
  };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/seeds', { seeds: [seed] });
  return { api, store, backend };
};

type ListRow = { id: string; name: string; count: number; unplayed: number; discovery_ready: boolean; items: { key: string; played: boolean }[] };
const lists = async (api: LocalApi): Promise<ListRow[]> => ((await api.handle('GET', '/api/playlists')).body as { lists: ListRow[] }).lists;
const act = (api: LocalApi, body: Record<string, unknown>) => api.handle('POST', '/api/playlists', body);
/** The engine's error shape: { message, detail }. */
const why = (r: { body: unknown }) => String((r.body as { message?: string })?.message ?? '');

/** Record a finished listen the way the player does. */
const complete = (api: LocalApi, key: string, id: string, extra: Record<string, unknown> = {}) =>
  api.handle('POST', '/api/feedback', { kind: 'complete', event_id: id, track: { ...seed, key }, listened: 180, origin: 'queue', ...extra });

describe('keeping saved lists', () => {
  it('starts with none, then creates and names one', async () => {
    const { api } = await open();
    expect(await lists(api)).toEqual([]);
    const made = await act(api, { action: 'create', name: '  Late   night ' });
    expect(made.status).toBe(200);
    const rows = await lists(api);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Late night');
    expect(rows[0]!.count).toBe(0);
  });

  it('refuses a blank name and a name already taken, with a message for the listener', async () => {
    const { api } = await open();
    await act(api, { action: 'create', name: 'Gym' });
    const blank = await act(api, { action: 'create', name: '   ' });
    expect(blank.status).toBe(400);
    expect(why(blank)).toMatch(/needs a name/i);
    const dupe = await act(api, { action: 'create', name: 'gym' });
    expect(dupe.status).toBe(400);
    expect(why(dupe)).toMatch(/already have a list/i);
    expect(await lists(api)).toHaveLength(1);
  });

  it('puts one song in several lists and reports it against each', async () => {
    const { api } = await open();
    await act(api, { action: 'create', name: 'A' });
    await act(api, { action: 'create', name: 'B' });
    const [a, b] = await lists(api);
    await act(api, { action: 'add', ids: [a!.id, b!.id], key: 'song:1' });
    const after = await lists(api);
    expect(after.map((l) => l.count)).toEqual([1, 1]);
    // Repeating the add changes nothing.
    await act(api, { action: 'add', ids: [a!.id], key: 'song:1' });
    expect((await lists(api))[0]!.count).toBe(1);
  });

  it('replaces the whole ticked set in one call, so unticking removes', async () => {
    const { api } = await open();
    await act(api, { action: 'create', name: 'A' });
    await act(api, { action: 'create', name: 'B' });
    const [a, b] = await lists(api);
    await act(api, { action: 'set', ids: [a!.id, b!.id], key: 'song:1' });
    expect((await lists(api)).map((l) => l.count)).toEqual([1, 1]);
    await act(api, { action: 'set', ids: [b!.id], key: 'song:1' });
    expect((await lists(api)).map((l) => l.count)).toEqual([0, 1]);
  });

  it('creates a list and files the song into it in the same step, for the like menu', async () => {
    const { api } = await open();
    const made = await act(api, { action: 'create', name: 'Fresh', key: 'song:7' });
    expect(made.status).toBe(200);
    const rows = await lists(api);
    expect(rows[0]!.name).toBe('Fresh');
    expect(rows[0]!.items.map((i) => i.key)).toEqual(['song:7']);
  });

  it('renames and deletes', async () => {
    const { api } = await open();
    await act(api, { action: 'create', name: 'Old' });
    const [one] = await lists(api);
    await act(api, { action: 'rename', id: one!.id, name: 'New' });
    expect((await lists(api))[0]!.name).toBe('New');
    await act(api, { action: 'delete', id: one!.id });
    expect(await lists(api)).toEqual([]);
  });

  it('rejects an unknown action rather than silently doing nothing', async () => {
    const { api } = await open();
    const r = await act(api, { action: 'frobnicate' });
    expect(r.status).toBe(400);
  });

  it('survives a reopen, because the lists live in the store', async () => {
    const { api, backend } = await open();
    await act(api, { action: 'create', name: 'Keepers', key: 'song:1' });
    const store2 = await Store.open(backend);
    const api2 = new LocalApi({
      store: store2,
      port: { request: async () => { throw new Error('no network'); } },
      encoder: null,
      spotifySearch: () => async () => [],
    });
    const rows = await lists(api2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Keepers');
    expect(rows[0]!.items.map((i) => i.key)).toEqual(['song:1']);
  });
});

describe('discovery on a saved list', () => {
  it('refuses while any song in the list is unplayed, and names how many are left', async () => {
    const { api, store } = await open();
    await act(api, { action: 'create', name: 'Mine' });
    const [l] = await lists(api);
    await act(api, { action: 'add', ids: [l!.id], key: 'p1' });
    await act(api, { action: 'add', ids: [l!.id], key: 'p2' });
    await act(api, { action: 'add', ids: [l!.id], key: 'p3' });
    await store.put('last_result', { items: [{ track: { key: 'p1' }, rank: 1 }] });

    await complete(api, 'p1', 'e1');
    const r = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: 'e1', list_id: l!.id, exclude: ['p1'] });
    expect(r.status).toBe(200);
    expect((r.body as { job: string | null }).job).toBeNull();
    expect(String((r.body as { reason: string }).reason)).toMatch(/2 songs in “Mine” still to play/);
  });

  it('reports the list as not ready until the last song is done', async () => {
    const { api } = await open();
    await act(api, { action: 'create', name: 'Mine' });
    const [l] = await lists(api);
    for (const k of ['p1', 'p2']) await act(api, { action: 'add', ids: [l!.id], key: k });
    expect((await lists(api))[0]).toMatchObject({ count: 2, unplayed: 2, discovery_ready: false });
    await complete(api, 'p1', 'e1');
    expect((await lists(api))[0]).toMatchObject({ unplayed: 1, discovery_ready: false });
    await complete(api, 'p2', 'e2');
    expect((await lists(api))[0]).toMatchObject({ unplayed: 0, discovery_ready: true });
  });

  it('lets a batch start once every song in the list has been played', async () => {
    const { api, store } = await open();
    await act(api, { action: 'create', name: 'Mine' });
    const [l] = await lists(api);
    for (const k of ['p1', 'p2']) await act(api, { action: 'add', ids: [l!.id], key: k });
    await store.put('last_result', { items: [{ track: { key: 'p1' }, rank: 1 }, { track: { key: 'p2' }, rank: 2 }] });
    await complete(api, 'p1', 'e1');
    await complete(api, 'p2', 'e2');
    // Both played, so the list is allowed to look for more; the queue's own low-water rule applies next.
    const r = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: 'e2', list_id: l!.id, exclude: ['p1', 'p2'] });
    expect(r.status).toBe(200);
    expect((r.body as { reason?: string }).reason ?? '').not.toMatch(/still to play/);
  });

  it('says so plainly when the list has been deleted under it', async () => {
    const { api } = await open();
    await complete(api, 'p1', 'e1');
    const r = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: 'e1', list_id: 'gone' });
    expect((r.body as { job: string | null }).job).toBeNull();
    expect(String((r.body as { reason: string }).reason)).toMatch(/list is gone/i);
  });

  it('leaves the ordinary queue rule alone when no list is named', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: Array.from({ length: 10 }, (_, i) => ({ track: { key: `k${i}` }, rank: i + 1 })) });
    await complete(api, 'k0', 'e-q');
    const r = await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: 'e-q', exclude: ['k0'] });
    // Nine unplayed songs left, so the queue is not low: the refusal is the queue's, not a list's.
    expect(String((r.body as { reason: string }).reason)).toMatch(/does not need more songs yet/i);
  });
});
