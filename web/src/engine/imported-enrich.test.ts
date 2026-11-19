import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { Dict } from './shape';
import { folderPlaylist } from '../DownloadsSettings';

/**
 * IMPORT-GENRES-001: songs imported from a folder are looked up in the background as soon as their
 * list is saved (and whenever the lists are read while some still wait), through the app's own
 * Deezer client and allowance meter. A confident match lends genres, a cover and a length, kept on
 * the list's copy so they survive a restart; anything else stays untagged.
 */
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dzTrack = (id: number, title: string, artist: string, albumId: number) => ({
  id, title, title_short: title, readable: true, type: 'track', duration: 312, rank: 1, link: `https://www.deezer.com/track/${id}`,
  artist: { id: 9, name: artist }, contributors: [{ id: 9, name: artist }], album: { id: albumId, title: 'Astroworld', cover_medium: `https://cdn-images.dzcdn.net/${albumId}.jpg` },
});
const dzAlbum = (id: number, ...genres: string[]) => ({ id, title: 'Astroworld', release_date: '2018-08-03', genres: { data: genres.map((name, i) => ({ id: i + 1, name })) }, tracks: { data: [] } });
const mbArtist = (name: string, ...tags: string[]) => ({ artists: [{ name, score: 100, tags: tags.map((t, i) => ({ name: t, count: 9 - i })) }] });

const ROUTES: Record<string, unknown> = {
  'api.deezer.com/search?q=Travis%20Scott%20Sicko%20Mode': { data: [dzTrack(701, 'SICKO MODE', 'Travis Scott', 81)] },
  'api.deezer.com/track/701': dzTrack(701, 'SICKO MODE', 'Travis Scott', 81),
  'api.deezer.com/album/81': dzAlbum(81, 'Rap/Hip Hop'),
  'api.deezer.com/search': { data: [dzTrack(702, 'Imported', 'Test Dept', 82)] },
  'musicbrainz.org/ws/2/artist?query=artist%3A%22Travis%20Scott%22': mbArtist('Travis Scott', 'hip hop', 'trap', 'rage'),
  'musicbrainz.org/ws/2/artist': { artists: [] },
};

function world(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const port = {
    request: async (req: { url: string }) => {
      const u = new URL(req.url);
      const key = u.host + u.pathname + u.search;
      seen.push(key);
      const hit = Object.keys(routes).find((k) => key.startsWith(k));
      return hit ? { status: 200, headers: {}, body: enc(routes[hit]) } : { status: 404, headers: {}, body: enc({}) };
    },
  };
  return { port, seen };
}

const imported = (title: string, artist: string, genre?: string) => {
  const name = `${artist} - ${title}.opus`;
  return { url: `imported:C:\\Music\\Mix\\${name}`, path: `C:\\Music\\Mix\\${name}`, name, title, artist, bytes: 9, ...(genre ? { genre } : {}) };
};

async function open(store?: Store) {
  const s = store ?? (await Store.open(new MemoryBackend()));
  const w = world(ROUTES);
  const api = new LocalApi({ store: s, port: w.port as never, encoder: null, spotifySearch: () => async () => [] });
  api.importedGenresGapMs = 0;
  return { api, store: s, seen: w.seen };
}

const listOf = async (api: LocalApi) => ((await api.handle('GET', '/api/playlists', null)).body as Dict)['lists'][0] as Dict;
const trackOf = (list: Dict, title: string) => (list['items'] as Dict[]).map((i) => i['track'] as Dict).find((t) => t['title'] === title)!;

describe('imported songs are enriched in the background (IMPORT-GENRES-001)', () => {
  it('starts on its own when the imported list is saved, and keeps genres, cover and length on the list', async () => {
    const { api, seen } = await open();
    const { name, tracks } = folderPlaylist('C:\\Music\\Mix', [imported('Sicko Mode', 'Travis Scott'), imported('Imported Song 1', 'Test Artist')]);
    const r = await api.handle('POST', '/api/playlists', { action: 'create', name, tracks });
    expect(r.status).toBe(200);
    await api.importedGenresSettled();
    expect(seen.some((u) => u.startsWith('api.deezer.com/search?q=Travis%20Scott%20Sicko%20Mode'))).toBe(true);

    const list = await listOf(api);
    const sicko = trackOf(list, 'Sicko Mode');
    expect((sicko['tags'] as Dict[]).map((t) => t['name'])).toEqual(expect.arrayContaining(['hip-hop']));
    expect((sicko['tags'] as Dict[]).filter((t) => t['name'] === 'hip-hop')).toHaveLength(1);
    expect(sicko['artwork']).toBe('https://cdn-images.dzcdn.net/81.jpg');
    expect(sicko['duration']).toBe(312);
    expect(sicko['url']).toBe('imported:C:\\Music\\Mix\\Travis Scott - Sicko Mode.opus');
    expect(sicko['provider']).toBe('imported');
    // MusicBrainz's subgenres for the artist fill the finer genre, the queue's own GENRE-ALL-001 step.
    expect((sicko['tags'] as Dict[]).map((t) => t['name'])).toEqual(expect.arrayContaining(['rage']));

    const fake = trackOf(list, 'Imported Song 1');
    expect(fake['tags'] ?? []).toEqual([]);
    expect(fake['artwork'] ?? null).toBeNull();
    expect(list['genre_pending']).toBeUndefined();
  });

  it('survives a restart: a fresh engine over the same store shows the same tags and asks nothing again', async () => {
    const first = await open();
    const { name, tracks } = folderPlaylist('C:\\Music\\Mix', [imported('Sicko Mode', 'Travis Scott'), imported('Imported Song 1', 'Test Artist')]);
    await first.api.handle('POST', '/api/playlists', { action: 'create', name, tracks });
    await first.api.importedGenresSettled();

    const again = await open(first.store);
    const list = await listOf(again.api);
    await again.api.importedGenresSettled();
    expect((trackOf(list, 'Sicko Mode')['tags'] as Dict[]).length).toBeGreaterThan(0);
    expect(again.seen).toEqual([]);
  });

  it('shows the matched song with its stated genres first and draws a list mix; the unmatched song has no genre', async () => {
    const { api } = await open();
    const { name, tracks } = folderPlaylist('C:\\Music\\Mix', [imported('Sicko Mode', 'Travis Scott'), imported('Imported Song 1', 'Test Artist')]);
    await api.handle('POST', '/api/playlists', { action: 'create', name, tracks });
    await api.importedGenresSettled();
    const list = await listOf(api);
    const items = list['items'] as Dict[];
    const sickoItem = items.find((i) => (i['track'] as Dict)['title'] === 'Sicko Mode')!;
    expect(((sickoItem['characteristics'] as Dict)['genres'] as string[]).length).toBeGreaterThan(0);
    const fakeItem = items.find((i) => (i['track'] as Dict)['title'] === 'Imported Song 1')!;
    expect(fakeItem['characteristics']).toBeUndefined();

    const mix = (await api.handle('GET', `/api/playlists/mix?id=${encodeURIComponent(String(list['id']))}`, null)).body as Dict;
    expect(mix['songs']).toBe(2);
    expect(mix['placed']).toBe(1);
    expect(mix['taste']).not.toBeNull();
  });

  it('uses the file genre once a match confirms the song, and reports what is still waiting', async () => {
    const store = await Store.open(new MemoryBackend());
    const w = world({ ...ROUTES, 'api.deezer.com/album/81': dzAlbum(81) });
    const api = new LocalApi({ store, port: w.port as never, encoder: null, spotifySearch: () => async () => [] });
    api.importedGenresGapMs = 0;
    const { name, tracks } = folderPlaylist('C:\\Music\\Mix', [imported('Sicko Mode', 'Travis Scott', 'Rap; Hip Hop')]);
    await api.handle('POST', '/api/playlists', { action: 'create', name, tracks });
    // Still looking: the lists say how many songs wait, so the page can say so and read again.
    expect((await listOf(api))['genre_pending']).toBe(1);
    await api.importedGenresSettled();
    const list = await listOf(api);
    expect(list['genre_pending']).toBeUndefined();
    const t = trackOf(list, 'Sicko Mode');
    expect((t['tags'] as Dict[]).filter((g) => g['name'] === 'hip-hop')).toHaveLength(1);
  });

  it('GENRE-ALL-001: a match with no subgenre gets an estimated one, marked as a guess, never a stated one', async () => {
    const store = await Store.open(new MemoryBackend());
    const w = world({ ...ROUTES, 'api.deezer.com/album/81': dzAlbum(81, 'Pop'), 'musicbrainz.org/ws/2/artist?query=artist%3A%22Travis%20Scott%22': { artists: [] } });
    const api = new LocalApi({ store, port: w.port as never, encoder: null, spotifySearch: () => async () => [] });
    api.importedGenresGapMs = 0;
    const { name, tracks } = folderPlaylist('C:\\Music\\Mix', [imported('Sicko Mode', 'Travis Scott')]);
    await api.handle('POST', '/api/playlists', { action: 'create', name, tracks });
    await api.importedGenresSettled();
    const item = ((await listOf(api))['items'] as Dict[])[0]!;
    expect(((item['track'] as Dict)['tags'] as Dict[]).map((g) => g['name'])).toEqual(['pop']);
    const fill = ((item['characteristics'] as Dict)['fill'] ?? []) as Dict[];
    const subs = fill.filter((f) => f['sub']);
    expect(subs.length).toBeGreaterThan(0);
    // An era is a fact ("10s pop" from the release year); anything else must be drawn as an estimate.
    for (const f of subs) expect(f['guess'] === true || /\d0s/.test(String(f['label']))).toBe(true);
  });
});

// SAVED-GENRES-001 (owner screenshot 2026-11-17: "no tags on the songs"). Measured live: a user
// imports songs they already streamed, so the list shows the catalogue copy (same key), and Saved
// rows only drew genres for imported copies. GENRE-ALL-001 wants genres on every song row, so a
// saved song of any provider with stated tags gets its characteristics, like the queue rows.
describe('saved rows show genres for every song (SAVED-GENRES-001)', () => {
  it('gives a saved catalogue song with stated tags its characteristics', async () => {
    const { api } = await open();
    const t = { key: 'slayr|try and fail|', id: 'ytmusic:x1', provider: 'ytmusic', platform_id: 'x1', title: 'Try and Fail', artists: ['slayr'], artist: 'slayr', url: 'https://music.youtube.com/watch?v=x1',
      tags: [{ name: 'hip-hop', label: 'Rap/Hip Hop', source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false }, { name: 'rage', label: 'rage', source: 'MusicBrainz artist tags', scope: 'artist', confidence: 0.5, inferred: false }] };
    await api.handle('POST', '/api/playlists', { action: 'create', name: 'Mine', tracks: [t] });
    const list = await listOf(api);
    const item = (list['items'] as Dict[])[0]!;
    const genres = ((item['characteristics'] as Dict | undefined)?.['genres'] ?? []) as string[];
    expect(genres.length).toBeGreaterThan(0);
  });
  it('keeps the imported file as the source when the same song was streamed, queued and seeded earlier', async () => {
    const { api, store } = await open();
    const { name, tracks } = folderPlaylist('C:\\Music\\Mix', [imported('Sicko Mode', 'Travis Scott')]);
    await api.handle('POST', '/api/playlists', { action: 'create', name, tracks });
    await api.importedGenresSettled();
    const key = String((tracks[0] as unknown as Dict)['key']);
    // The listener had streamed the same song before: a catalogue copy with the same key, no tags.
    // Held twice more (a queue result, then a starting song): each copy replaces the one before it.
    await store.put('last_result', { items: [{ track: { key, id: 'deezer:9', provider: 'deezer', platform_id: '9', title: 'Sicko Mode', artists: ['Travis Scott'], artist: 'Travis Scott' } }] });
    await api.handle('PUT', '/api/seeds', { seeds: [{ key, id: 'ytmusic:s1', provider: 'ytmusic', platform_id: 's1', title: 'Sicko Mode', artists: ['Travis Scott'], artist: 'Travis Scott', url: 'https://music.youtube.com/watch?v=s1' }] });
    const list = await listOf(api);
    const item = (list['items'] as Dict[])[0]!;
    const held = item['track'] as Dict;
    expect(held['provider']).toBe('imported');
    expect(held['url']).toBe((tracks[0] as unknown as Dict)['url']);
    expect((((item['characteristics'] as Dict | undefined)?.['genres']) ?? []) as string[]).not.toHaveLength(0);
    // Pressing Play list must also hand the local source to the player, not the online copy.
    const queued = await api.handle('POST', '/api/queue/playlist', { id: list['id'] });
    expect(queued.status).toBe(200);
    const seeds = ((queued.body as Dict)['seeds'] ?? []) as Dict[];
    expect(seeds[0]?.['provider']).toBe('imported');
    expect(seeds[0]?.['url']).toBe(held['url']);
  });
});
