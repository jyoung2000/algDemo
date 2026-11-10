/**
 * ALBUM-SEARCH-001 / ALBUM-OPEN-001 through the real LocalApi: the album search route, opening an album
 * by id, and opening the album a song sits on. The network answers from recorded bodies.
 */
import { expect, it } from 'vitest';

import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const enc = (s: string) => new TextEncoder().encode(s);
const DZ_SEARCH = { data: [{ id: 498395131, title: 'A Great Chaos', link: 'https://www.deezer.com/album/498395131', nb_tracks: 2, record_type: 'album', artist: { id: 1, name: 'Ken Carson' }, type: 'album' }] };
const DZ_ALBUM = {
  id: 498395131, title: 'A Great Chaos', link: 'https://www.deezer.com/album/498395131', cover_medium: 'https://cdn/c.jpg', nb_tracks: 2, release_date: '2023-10-13', record_type: 'album',
  genres: { data: [{ id: 116, name: 'Rap/Hip Hop' }] }, artist: { id: 1, name: 'Ken Carson' },
  tracks: { data: [
    { id: 11, readable: true, title: 'Green Room', title_short: 'Green Room', title_version: '', link: 'https://www.deezer.com/track/11', duration: 188, artist: { id: 1, name: 'Ken Carson' }, type: 'track' },
    { id: 12, readable: true, title: 'Jennifer\u2019s Body', title_short: 'Jennifer\u2019s Body', title_version: '', link: 'https://www.deezer.com/track/12', duration: 150, artist: { id: 1, name: 'Ken Carson' }, type: 'track' },
  ] },
};

async function open() {
  const port = {
    request: async (req: { url: string }) => {
      const u = new URL(req.url);
      const at = u.host + u.pathname;
      const body = at === 'api.deezer.com/search/album' ? DZ_SEARCH : at === 'api.deezer.com/album/498395131' ? DZ_ALBUM : at === 'itunes.apple.com/search' ? { results: [] } : null;
      return body ? { status: 200, headers: {}, body: enc(JSON.stringify(body)) } : { status: 404, headers: {}, body: enc('{}') };
    },
  };
  const store = await Store.open(new MemoryBackend());
  return new LocalApi({ store, port: port as never, encoder: null, spotifySearch: () => async () => [] });
}

it('searches albums', async () => {
  const api = await open();
  const r = await api.handle('GET', '/api/search/albums?q=ken%20carson');
  expect(r.status).toBe(200);
  const b = r.body as { albums: { id: string; title: string; kind: string }[]; sources: Record<string, { state: string }> };
  expect(b.albums.map((a) => [a.id, a.title, a.kind])).toEqual([['dz:498395131', 'A Great Chaos', 'album']]);
  expect(b.sources['deezer']!.state).toBe('ok');
});

it('opens an album by id, its songs shaped like every other track', async () => {
  const api = await open();
  const r = await api.handle('POST', '/api/album', { id: 'dz:498395131' });
  expect(r.status).toBe(200);
  const a = (r.body as { album: { title: string; tracks: Record<string, unknown>[] } }).album;
  expect(a.title).toBe('A Great Chaos');
  expect(a.tracks.map((t) => t['title'])).toEqual(['Green Room', 'Jennifer\u2019s Body']);
  expect(a.tracks[0]).toMatchObject({ album: 'A Great Chaos', album_id: '498395131', key: expect.any(String) });
});

it('opens the album a song sits on, and says so when there is none', async () => {
  const api = await open();
  const yes = await api.handle('POST', '/api/album', { track: { title: 'Green Room', album: 'A Great Chaos', artists: ['Ken Carson'], provider: 'ytmusic' } });
  expect((yes.body as { album: { id: string } }).album.id).toBe('dz:498395131');
  const no = await api.handle('POST', '/api/album', { track: { title: 'X', album: 'Nobody Has This', artists: ['Ken Carson'] } });
  expect(no.status).toBe(404);
  expect(no.body).toMatchObject({ code: 'none' });
  const bad = await api.handle('POST', '/api/album', {});
  expect(bad.status).toBe(400);
});

it('saves an album as a list that keeps every song, even songs the listener never played', async () => {
  const api = await open();
  const a = ((await api.handle('POST', '/api/album', { id: 'dz:498395131' })).body as { album: { tracks: Record<string, unknown>[] } }).album;
  const r = await api.handle('POST', '/api/playlists', { action: 'create', name: 'A Great Chaos', tracks: a.tracks });
  expect(r.status).toBe(200);
  const list = (r.body as { lists: { name: string; count: number; items: { key: string; track: { title: string } | null }[] }[] }).lists[0]!;
  expect(list.name).toBe('A Great Chaos');
  expect(list.count).toBe(2);
  expect(list.items.map((i) => i.track?.title)).toEqual(['Green Room', 'Jennifer\u2019s Body']);
  // A song with no key is refused rather than stored as an empty entry.
  const bad = await api.handle('POST', '/api/playlists', { action: 'create', name: 'Odd', tracks: [{ title: 'no key' }] });
  expect((bad.body as { lists: { name: string; count: number }[] }).lists.find((l) => l.name === 'Odd')!.count).toBe(0);
});

it('keeps the album when the song was played from a copy that does not name it', async () => {
  // Found on the packaged app: the full song came from SoundCloud, whose copy has no album, so the saved
  // album list lost its album button and album taste lost the play. Same key, so the album carries over.
  const api = await open();
  const a = ((await api.handle('POST', '/api/album', { id: 'dz:498395131' })).body as { album: { tracks: Record<string, unknown>[] } }).album;
  await api.handle('POST', '/api/playlists', { action: 'create', name: 'A Great Chaos', tracks: a.tracks });
  const jb = a.tracks[1]!;
  const sc = { key: jb['key'], title: "Jennifer's Body", artists: ['Ken Carson'], provider: 'soundcloud', platform_id: '999', duration: 150 };
  const r = await api.handle('POST', '/api/feedback', { kind: 'complete', track: sc, event_id: 'e1', listened: 150 });
  expect(r.status).toBe(200);
  // The stored play names the album (ALBUM-TASTE-001 reads it), and keeps the copy that was played.
  const row = api.store.feedback().find((x) => x.key === jb['key'])!;
  expect(row.track).toMatchObject({ provider: 'soundcloud', title: "Jennifer's Body", album: 'A Great Chaos', album_id: '498395131' });
  // The saved list shows the fresher copy, still with its album (ALBUM-OPEN-001 row button).
  const lists = ((await api.handle('GET', '/api/playlists')).body as { lists: { items: { track: Record<string, unknown> | null }[] }[] }).lists;
  expect(lists[0]!.items[1]!.track).toMatchObject({ provider: 'soundcloud', album: 'A Great Chaos' });
  // A copy that names a different album is the listener's evidence and is left alone.
  await api.handle('POST', '/api/feedback', { kind: 'like', track: { ...sc, album: 'Deluxe' }, event_id: 'e2' });
  const deluxe = api.store.feedback().find((x) => (x.track as { album?: string }).album === 'Deluxe')!;
  // ...and it never borrows the other album's id or date.
  expect(deluxe.track).not.toHaveProperty('album_id');
  expect(deluxe.track).not.toHaveProperty('release');
  const after = ((await api.handle('GET', '/api/playlists')).body as { lists: { items: { track: Record<string, unknown> | null }[] }[] }).lists;
  expect(after[0]!.items[1]!.track).toMatchObject({ album: 'Deluxe' });
  expect(after[0]!.items[1]!.track).not.toHaveProperty('album_id');
});

it('shows the album for plays stored before the album carried over', async () => {
  // Rows written by 0.13.0 and earlier hold the played copy as it came, without the album.
  const api = await open();
  const a = ((await api.handle('POST', '/api/album', { id: 'dz:498395131' })).body as { album: { tracks: Record<string, unknown>[] } }).album;
  await api.handle('POST', '/api/playlists', { action: 'create', name: 'A Great Chaos', tracks: a.tracks });
  const key = String(a.tracks[1]!['key']);
  await api.store.addFeedback('old', key, 'complete', 'ken carson', { key, title: "Jennifer's Body", artists: ['Ken Carson'], provider: 'soundcloud' }, 150);
  const lists = ((await api.handle('GET', '/api/playlists')).body as { lists: { items: { track: Record<string, unknown> | null }[] }[] }).lists;
  expect(lists[0]!.items[1]!.track).toMatchObject({ provider: 'soundcloud', album: 'A Great Chaos', album_id: '498395131' });
});
