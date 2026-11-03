/**
 * DISCOVERY-001 through the real LocalApi: listening is the second way to discover, and every
 * batch respects the listener's cap without shortening the list they already have.
 */
import { expect, it, describe } from 'vitest';
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
const listed = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ track: { key: `k${i}`, title: `t${i}` }, rank: i + 1 }));

const open = async () => {
  const store = await Store.open(new MemoryBackend());
  const port = {
    request: async () => {
      throw new Error('no network in this test');
    },
  };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/seeds', { seeds: [seed] });
  return { api, store };
};

/** Record a finished listen the way the player does, then ask for a listening batch. */
const complete = async (api: LocalApi, key: string, id: string, origin = 'queue') => {
  await api.handle('POST', '/api/feedback', {
    kind: 'complete',
    event_id: id,
    track: { ...seed, key },
    listened: 180,
    origin,
  });
  return id;
};

describe('listening discovery', () => {
  it('is skipped while the list still has unplayed songs, and runs when it is nearly done', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: listed(10) });
    const id = await complete(api, 'k0', 'e-plenty');
    // 9 unplayed left: nothing is asked of any provider (this test has no network at all).
    const plenty = await api.handle('POST', '/api/recommend', {
      trigger: 'listening',
      event_id: id,
      exclude: ['k0'],
    });
    expect(plenty.body).toMatchObject({ job: null });

    const id2 = await complete(api, 'k1', 'e-low');
    const played = ['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
    const low = await api.handle('POST', '/api/recommend', {
      trigger: 'listening',
      event_id: id2,
      exclude: played,
    });
    expect((low.body as { job: string | null }).job).toBeTruthy();
  });

  it('does not discover for a skip, a replay, or a song played outside the list', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: listed(2) });
    for (const kind of ['skip', 'replay']) {
      const id = `e-${kind}`;
      await api.handle('POST', '/api/feedback', {
        kind,
        event_id: id,
        track: { ...seed, key: 'k0' },
        listened: 5,
        origin: 'queue',
      });
      expect(
        await api.handle('POST', '/api/recommend', {
          trigger: 'listening',
          event_id: id,
          exclude: ['k0', 'k1'],
        }),
      ).toMatchObject({ body: { job: null } });
    }
    const outside = await complete(api, 'k0', 'e-preview', 'search');
    expect(
      await api.handle('POST', '/api/recommend', {
        trigger: 'listening',
        event_id: outside,
        exclude: ['k0', 'k1'],
      }),
    ).toMatchObject({ body: { job: null } });
  });

  it('honours the switch and never discovers twice for one listen', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: listed(2) });
    await api.handle('PUT', '/api/settings', { discover_while_listening: false });
    const id = await complete(api, 'k0', 'e-off');
    expect(
      await api.handle('POST', '/api/recommend', {
        trigger: 'listening',
        event_id: id,
        exclude: ['k0', 'k1'],
      }),
    ).toMatchObject({ body: { job: null } });

    await api.handle('PUT', '/api/settings', { discover_while_listening: true });
    const first = await api.handle('POST', '/api/recommend', {
      trigger: 'listening',
      event_id: id,
      exclude: ['k0', 'k1'],
    });
    expect((first.body as { job: string | null }).job).toBeTruthy();
    // The same completed listen must not start a second batch, however often the player retries.
    const again = await api.handle('POST', '/api/recommend', {
      trigger: 'listening',
      event_id: id,
      exclude: ['k0', 'k1'],
    });
    expect(again.body).toMatchObject({ job: null });
  });

  it('keeps the saved list and the chosen cap across a restart', async () => {
    const be = new MemoryBackend();
    const store = await Store.open(be);
    const port = {
      request: async () => {
        throw new Error('no network in this test');
      },
    };
    const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
    await api.handle('PUT', '/api/settings', { queue_size: 7, discover_while_listening: false });
    await store.put('last_result', { items: listed(24) });
    await store.flush();

    const reopened = await Store.open(be);
    const settings = (
      await new LocalApi({
        store: reopened,
        port,
        encoder: null,
        spotifySearch: () => async () => [],
      }).handle('GET', '/api/settings', null)
    ).body as { queue_size: number; discover_while_listening: boolean };
    expect(settings.queue_size).toBe(7);
    expect(settings.discover_while_listening).toBe(false);
    expect((reopened.get<{ items: unknown[] }>('last_result')?.items ?? []).length).toBe(24);
  });

  it('rejects a cap outside the slider and leaves the saved one alone', async () => {
    const { api } = await open();
    await api.handle('PUT', '/api/settings', { queue_size: 12 });
    for (const bad of [4, 61, 'many', null]) {
      expect((await api.handle('PUT', '/api/settings', { queue_size: bad })).status).toBe(400);
    }
    expect((await api.handle('GET', '/api/settings', null)).body).toMatchObject({ queue_size: 12 });
  });

  it('clearing the list forgets the pool so the next batch cannot resurrect old songs', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: listed(5) });
    await store.put('last_pool', { cands: [{ key: 'k0' }], seeds: [seed] });
    await api.handle('POST', '/api/queue/clear', {});
    expect(store.get('last_result')).toBeUndefined();
    expect(store.get('last_pool')).toBeUndefined();
  });
});
