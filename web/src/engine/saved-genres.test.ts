import { describe, expect, it, vi } from 'vitest';
import { LocalApi } from './local-api';
import { makeTrack } from './track';
import { MemoryBackend, Store } from './store';

/**
 * TAGS-ALWAYS-001 (owner, 2026-11-19): "ensure the discover, radio, and saved music always generates
 * tags for genres and sub genres on the song list". Saved songs had none: /api/saved sent bare tracks.
 */
async function setup() {
  const store = await Store.open(new MemoryBackend());
  const api = new LocalApi({ store, port: { request: async () => { throw Error('no network'); } }, encoder: null });
  const handle = async (m: string, path: string, body?: Record<string, unknown>) => {
    const r = await api.handle(m, path, body ?? {}); return { status: r.status, body: r.body as Record<string, any> };
  };
  return { api, store, handle };
}

describe('saved songs carry their genres', () => {
  it('sends a saved song\'s main genre and subgenres, as a Discover row has', async () => {
    const { handle } = await setup();
    const track = { ...makeTrack({ provider: 'deezer', platformId: '7', title: 'shopping', artists: ['Destroy Lonely'], url: 'https://example.invalid/7', duration: 150 }),
      tags: [{ name: 'Rap/Hip Hop', label: 'Rap/Hip Hop' }, { name: 'rage', label: 'rage' }] };
    expect((await handle('POST', '/api/feedback', { track, kind: 'like', event_id: 'e1' })).status).toBe(200);
    const items = (await handle('GET', '/api/saved')).body.items;
    expect(items).toHaveLength(1);
    const c = items[0].characteristics;
    expect(c).toBeTruthy();
    expect((c.genres ?? []).length + (c.families ?? []).length).toBeGreaterThan(0);
  });

  it('looks up the genres of a saved song that has none, once, and sends them next time', async () => {
    const { api, handle } = await setup();
    const track = makeTrack({ provider: 'ytmusic', platformId: 'kk', title: 'Knock Knock', artists: ['SoFaygo'], url: 'https://example.invalid/kk', duration: 150 });
    await handle('POST', '/api/feedback', { track, kind: 'like', event_id: 'e1' });
    const look = vi.spyOn(api as never as { lookUpGenres: (t: unknown, m: unknown) => Promise<unknown> }, 'lookUpGenres')
      .mockResolvedValue({ tags: [{ name: 'Rap/Hip Hop', label: 'Rap/Hip Hop' }, { name: 'trap', label: 'trap' }], track });
    await handle('GET', '/api/saved');
    await api.savedGenresSettled();
    expect(look).toHaveBeenCalledTimes(1);
    const c = (await handle('GET', '/api/saved')).body.items[0].characteristics;
    expect(JSON.stringify(c)).toMatch(/Rap|Hip/);
    await api.savedGenresSettled();
    expect(look).toHaveBeenCalledTimes(1);
  });

  it('looks up a starting song with no genre too, and shows what it found', async () => {
    const { api, handle } = await setup();
    const track = makeTrack({ provider: 'deezer', platformId: 'sh', title: 'Knock Knock', artists: ['Shogun'], url: 'https://example.invalid/sh', duration: 150 });
    const look = vi.spyOn(api as never as { lookUpGenres: (t: unknown, m: unknown) => Promise<unknown> }, 'lookUpGenres')
      .mockResolvedValue({ tags: [{ name: 'Electro', label: 'Electro' }], track });
    await handle('PUT', '/api/seeds', { seeds: [track] });
    await handle('GET', '/api/seeds');
    await api.savedGenresSettled();
    expect(look).toHaveBeenCalledTimes(1);
    const seed = (await handle('GET', '/api/seeds')).body.seeds[0];
    expect(JSON.stringify(seed.characteristics)).toMatch(/Electro/);
  });

  it('asks for the subgenres of a saved song that has only a main genre, once', async () => {
    const { api, handle } = await setup();
    const track = { ...makeTrack({ provider: 'deezer', platformId: 'k2', title: 'Knock Knock', artists: ['Shogun'], url: 'https://example.invalid/k2', duration: 150 }),
      tags: [{ name: 'hip-hop', label: 'Rap/Hip Hop', inferred: false }] };
    await handle('POST', '/api/feedback', { track, kind: 'like', event_id: 'e2' });
    const ask = vi.spyOn(api as never as { askArtist: (t: unknown, m: unknown) => Promise<void> }, 'askArtist').mockResolvedValue(undefined);
    await handle('GET', '/api/saved');
    await api.savedGenresSettled();
    await handle('GET', '/api/saved');
    await api.savedGenresSettled();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('looks up and shows genres for a saved list\'s songs that have none (RADIO-GENRES-001)', async () => {
    const { api, handle } = await setup();
    const track = makeTrack({ provider: 'ytmusic', platformId: 'pl', title: 'Life So Crazy', artists: ['Pi\'erre Bourne'], url: 'https://example.invalid/pl', duration: 150 });
    const look = vi.spyOn(api as never as { lookUpGenres: (t: unknown, m: unknown) => Promise<unknown> }, 'lookUpGenres')
      .mockResolvedValue({ tags: [{ name: 'Rap/Hip Hop', label: 'Rap/Hip Hop' }, { name: 'trap', label: 'trap' }], track });
    const made = await handle('POST', '/api/playlists', { action: 'create', name: 'Mix', key: track.key, tracks: [track] });
    expect(made.status).toBe(200);
    await handle('GET', '/api/playlists');
    await api.savedGenresSettled();
    expect(look).toHaveBeenCalledTimes(1);
    const item = (await handle('GET', '/api/playlists')).body.lists[0].items[0];
    expect(JSON.stringify(item.characteristics)).toMatch(/Rap|Hip/);
  });

  it('looks up the year of a saved song whose artist names nothing finer, so its era is its subgenre', async () => {
    const { api, handle } = await setup();
    const track = { ...makeTrack({ provider: 'ytmusic', platformId: 'sg', title: 'Knock Knock', artists: ['Shogun'], url: 'https://example.invalid/sg', duration: 206 }),
      tags: [{ name: 'hip-hop', label: 'Rap/Hip Hop', source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false }] };
    await handle('POST', '/api/feedback', { track, kind: 'like', event_id: 'e9' });
    vi.spyOn(api as never as { askArtist: (t: unknown, m: unknown) => Promise<void> }, 'askArtist').mockResolvedValue(undefined);
    const facts = vi.spyOn(api as never as { deezerFacts: (t: unknown, o: unknown) => Promise<unknown> }, 'deezerFacts')
      .mockResolvedValue({ release: { date: '2021-03-05' }, proven: true });
    await handle('GET', '/api/saved');
    await api.savedGenresSettled();
    expect(facts).toHaveBeenCalledTimes(1);
    const c = (await handle('GET', '/api/saved')).body.items[0].characteristics;
    expect(JSON.stringify(c.fill)).toMatch(/2020s rap/i);
  });

  it('gives search results genres: known ones at once, unknown ones looked up (POST /api/genres)', async () => {
    const { api, handle } = await setup();
    const a = makeTrack({ provider: 'ytmusic', platformId: 's1', title: 'Clutch', artists: ['SoFaygo'], url: 'https://example.invalid/s1', duration: 134 });
    const b = { ...makeTrack({ provider: 'deezer', platformId: 's2', title: 'Yale', artists: ['Ken Carson'], url: 'https://example.invalid/s2', duration: 120 }),
      tags: [{ name: 'hip-hop', label: 'Rap/Hip Hop', source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false }, { name: 'rage', label: 'rage', source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false }] };
    const look = vi.spyOn(api as never as { lookUpGenres: (t: unknown, m: unknown) => Promise<unknown> }, 'lookUpGenres')
      .mockResolvedValue({ tags: [{ name: 'hip-hop', label: 'Rap/Hip Hop' }, { name: 'trap', label: 'trap' }], track: a });
    const first = (await handle('POST', '/api/genres', { tracks: [a, b] })).body;
    expect(first.items[a.key]).toBeNull();
    expect(first.pending).toEqual([a.key]);
    await api.genreQueueSettled();
    expect(look).toHaveBeenCalledTimes(1);
    const items = (await handle('POST', '/api/genres', { tracks: [a, b] })).body.items;
    expect(JSON.stringify(items[a.key])).toMatch(/Trap/i);
    expect(JSON.stringify(items[b.key])).toMatch(/Rage/i);
    await handle('POST', '/api/genres', { tracks: [a] });
    expect(look).toHaveBeenCalledTimes(1);
  });

  it('estimates a search row no service has genres for from the same artist\'s tagged rows (GENRE-ALL-001)', async () => {
    const { api, handle } = await setup();
    const rap = [{ name: 'hip-hop', label: 'Rap/Hip Hop', source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false }];
    const known = { ...makeTrack({ provider: 'deezer', platformId: 'd1', title: 'DENIAL IS A RIVER', artists: ['Doechii'], url: 'https://example.invalid/d1', duration: 160 }), tags: rap };
    const bare = makeTrack({ provider: 'ytmusic', platformId: 'd2', title: 'Bills', artists: ['Doechii'], url: 'https://example.invalid/d2', duration: 150 });
    vi.spyOn(api as never as { lookUpGenres: (t: unknown, m: unknown) => Promise<unknown> }, 'lookUpGenres').mockResolvedValue({ tags: [], track: bare });
    await handle('POST', '/api/genres', { tracks: [known, bare] });
    await api.genreQueueSettled();
    const body = (await handle('POST', '/api/genres', { tracks: [known, bare] })).body;
    expect(body.pending).toEqual([]);
    const { genreBubbles } = await import('../util');
    const bubbles = genreBubbles(body.items[bare.key]);
    expect(bubbles.length).toBeGreaterThan(0);
    expect(JSON.stringify(bubbles)).toMatch(/Rap|Hip/);
  });

  it('looks search results up from the top row down', async () => {
    const { api, handle } = await setup();
    const rows = ['r1', 'r2', 'r3'].map((id, i) => makeTrack({ provider: 'ytmusic', platformId: id, title: 'Song ' + i, artists: ['Artist ' + i], url: 'https://example.invalid/' + id, duration: 150 }));
    const order: string[] = [];
    vi.spyOn(api as never as { lookUpGenres: (t: { key: string }, m: unknown) => Promise<unknown> }, 'lookUpGenres')
      .mockImplementation(async (t) => { order.push(t.key); return { tags: [], track: t }; });
    await handle('POST', '/api/genres', { tracks: rows });
    await api.genreQueueSettled();
    expect(order).toEqual(rows.map((r) => r.key));
  });
});
