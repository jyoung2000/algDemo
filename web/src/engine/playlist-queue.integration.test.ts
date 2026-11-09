/**
 * PLAYLIST-QUEUE-001 through the real LocalApi: a saved list takes the place of the now playing queue,
 * every song in it becomes a starting song, the queue it replaced can be brought back, and the list's
 * own sound is readable as a mix (PLAYLIST-MIX-001).
 */
import { describe, expect, it } from 'vitest';

import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const song = (n: number, tags: string[] = []) => ({
  key: `artist ${n}|song ${n}`,
  provider: 'deezer',
  platform_id: String(1000 + n),
  title: `Song ${n}`,
  artists: [`Artist ${n}`],
  artist: `Artist ${n}`,
  tags: tags.map((t) => ({ name: t, label: t, source: 'test', scope: 'track', confidence: 1, inferred: false })),
});

const open = async () => {
  const store = await Store.open(new MemoryBackend());
  const port = { request: async () => { throw new Error('no network in this test'); } };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
  return { api, store };
};

type Seeds = { seeds: { key: string; emphasis: number }[]; playlist: { id: string; name: string } | null; can_restore: boolean };
const seeds = async (api: LocalApi) => (await api.handle('GET', '/api/seeds')).body as Seeds;
const like = (api: LocalApi, t: ReturnType<typeof song>, id: string) => api.handle('POST', '/api/feedback', { kind: 'save', event_id: id, track: t });

/** A list named `name` holding `tracks`, saved the way the like menu does. */
async function makeList(api: LocalApi, name: string, tracks: ReturnType<typeof song>[]) {
  await api.handle('POST', '/api/playlists', { action: 'create', name });
  const id = ((await api.handle('GET', '/api/playlists')).body as { lists: { id: string; name: string }[] }).lists.find((l) => l.name === name)!.id;
  for (const [i, t] of tracks.entries()) {
    await like(api, t, `${name}-${i}`);
    await api.handle('POST', '/api/playlists', { action: 'add', ids: [id], key: t.key });
  }
  return id;
}

describe('a playlist as the now playing queue', () => {
  it('makes every song in the list a starting song, in the list\u2019s order, and names the list', async () => {
    const { api } = await open();
    await api.handle('PUT', '/api/seeds', { seeds: [song(1)] });
    const id = await makeList(api, 'Late night', [song(2), song(3), song(4)]);
    const r = await api.handle('POST', '/api/queue/playlist', { id });
    expect(r.status).toBe(200);
    const s = await seeds(api);
    expect(s.seeds.map((x) => x.key)).toEqual([song(2).key, song(3).key, song(4).key]);
    expect(s.seeds.every((x) => x.emphasis === 1)).toBe(true);
    expect(s.playlist).toEqual({ id, name: 'Late night' });
    expect(s.can_restore).toBe(true);
  });

  it('replaces the queue: songs discovered for the old queue are gone', async () => {
    const { api, store } = await open();
    await api.handle('PUT', '/api/seeds', { seeds: [song(1)] });
    await store.put('last_result', { items: [{ track: song(9) }], count: 1 });
    const id = await makeList(api, 'Gym', [song(2)]);
    await api.handle('POST', '/api/queue/playlist', { id });
    expect(store.get('last_result') ?? null).toBeNull();
  });

  it('brings back the queue it replaced, starting songs and discoveries both', async () => {
    const { api, store } = await open();
    await api.handle('PUT', '/api/seeds', { seeds: [song(1)] });
    await store.put('last_result', { items: [{ track: song(9) }], count: 1 });
    const a = await makeList(api, 'A', [song(2)]);
    const b = await makeList(api, 'B', [song(3)]);
    await api.handle('POST', '/api/queue/playlist', { id: a });
    // Switching straight to another list still restores the listener's own queue, not list A.
    await api.handle('POST', '/api/queue/playlist', { id: b });
    const back = await api.handle('POST', '/api/queue/restore', {});
    expect(back.status).toBe(200);
    const s = await seeds(api);
    expect(s.seeds.map((x) => x.key)).toEqual([song(1).key]);
    expect(s.playlist).toBeNull();
    expect(s.can_restore).toBe(false);
    expect((store.get<{ items: unknown[] }>('last_result')?.items ?? []).length).toBe(1);
  });

  it('refuses an empty list, an unknown list and a restore with nothing to restore, changing nothing', async () => {
    const { api } = await open();
    await api.handle('PUT', '/api/seeds', { seeds: [song(1)] });
    const empty = await makeList(api, 'Empty', []);
    expect((await api.handle('POST', '/api/queue/playlist', { id: empty })).status).toBe(400);
    expect((await api.handle('POST', '/api/queue/playlist', { id: 'nope' })).status).toBe(404);
    expect((await api.handle('POST', '/api/queue/restore', {})).status).toBe(409);
    expect((await seeds(api)).seeds.map((x) => x.key)).toEqual([song(1).key]);
  });

  it('a manual change to the starting songs keeps the list named; clearing the queue forgets it', async () => {
    const { api } = await open();
    const id = await makeList(api, 'Mine', [song(2), song(3)]);
    await api.handle('POST', '/api/queue/playlist', { id });
    await api.handle('PUT', '/api/seeds', { seeds: [song(2)] });
    expect((await seeds(api)).playlist?.name).toBe('Mine');
    await api.handle('POST', '/api/queue/clear', {});
    const s = await seeds(api);
    expect(s.playlist).toBeNull();
    expect(s.can_restore).toBe(false);
  });
});

describe('a playlist\u2019s mix', () => {
  it('reads the list\u2019s genres from its songs, each song counted once, strongest first', async () => {
    const { api } = await open();
    const id = await makeList(api, 'Mix', [song(1, ['r&b']), song(2, ['r&b', 'pop']), song(3, ['rage'])]);
    const r = await api.handle('GET', `/api/playlists/mix?id=${encodeURIComponent(id)}`);
    expect(r.status).toBe(200);
    const mix = (r.body as { taste: { events: number; genres: { name: string; plays: number }[] }; songs: number; placed: number }).taste;
    expect(mix.events).toBe(3);
    expect(mix.genres[0]!.name).toBe('r&b');
    expect(mix.genres.find((g) => g.name === 'r&b')!.plays).toBe(2);
    expect(mix.genres.map((g) => g.name)).toEqual(expect.arrayContaining(['pop', 'rage']));
    expect((r.body as { songs: number }).songs).toBe(3);
  });

  it('says how many songs it could not read a genre for, rather than hiding them', async () => {
    const { api } = await open();
    const id = await makeList(api, 'Bare', [song(1, ['soul']), song(2)]);
    const body = (await api.handle('GET', `/api/playlists/mix?id=${encodeURIComponent(id)}`)).body as { songs: number; placed: number };
    expect(body).toMatchObject({ songs: 2, placed: 1 });
  });

  it('counts a song in the list it holds no copy of as one of its songs, not placed', async () => {
    const { api } = await open();
    const id = await makeList(api, 'Odd', [song(1, ['soul'])]);
    await api.handle('POST', '/api/playlists', { action: 'add', ids: [id], key: 'nobody|nothing' });
    const body = (await api.handle('GET', `/api/playlists/mix?id=${encodeURIComponent(id)}`)).body as { songs: number; placed: number };
    expect(body).toMatchObject({ songs: 2, placed: 1 });
  });
});

describe('adding a song to the now playing queue (QUEUE-ADD-001)', () => {
  const row = (n: number) => ({ rank: 0, track: song(n), score: 0, coverage: 0, tier: 'related', evidence: 'thin', best_seed: null,
    reasons: [{ factor: 'added', text: 'You added it.', weight: 0 }], uncertainty: [], new_release: false, factors: {}, weights: {}, sources: ['added'],
    playback: { kind: 'none' }, added: true });

  it('puts it after the song named, keeps it across a reload, and moves it rather than repeating it', async () => {
    const { api, store } = await open();
    await store.put('last_result', { items: [row(1), row(2)].map((r) => ({ ...r, added: false })), count: 2, phase: 'final' });
    const r = await api.handle('POST', '/api/queue/add', { item: row(9), after: song(1).key });
    expect(r.status).toBe(200);
    expect(((r.body as { items: { track: { key: string } }[] }).items).map((x) => x.track.key)).toEqual([song(1).key, song(9).key, song(2).key]);
    await api.handle('POST', '/api/queue/add', { item: row(2), after: song(1).key });
    const last = (await api.handle('GET', '/api/last')).body as { items: { track: { key: string }; rank: number }[]; count: number };
    expect(last.items.map((x) => x.track.key)).toEqual([song(1).key, song(2).key, song(9).key]);
    expect(last.items.map((x) => x.rank)).toEqual([1, 2, 3]);
    expect(last.count).toBe(3);
  });

  it('starts a queue when there is none yet', async () => {
    const { api } = await open();
    const r = await api.handle('POST', '/api/queue/add', { item: row(5), after: null });
    expect(r.status).toBe(200);
    expect(((await api.handle('GET', '/api/last')).body as { items: unknown[] }).items).toHaveLength(1);
  });

  it('refuses a row with no song', async () => {
    const { api } = await open();
    expect((await api.handle('POST', '/api/queue/add', { item: { rank: 0 } })).status).toBe(400);
  });
});

