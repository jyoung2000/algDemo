// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { installMediaCommands, setMediaHandlers } from './media-native';
import { CarCatalog } from './car-catalog';
import type { SearchResponse, Track } from '../api';

const track = { key: 'catalog:one', title: 'Wallpaper', artist: 'Kevin MacLeod', duration: 196, provider: 'deezer', platform_id: 'one' } as Track;
const response = (results: Track[]): SearchResponse => ({ results, sources: { deezer: { state: 'ok', count: results.length } }, ms: 0, bytes: 0 });
const win = () => window as unknown as Record<string, unknown>;
beforeEach(() => { setMediaHandlers({ catalogSearch: undefined }); installMediaCommands(); });

it('answers an actual native catalogue request asynchronously with matching request ID/query', async () => {
  const media = vi.fn(); win().AirwaveNative = { media };
  const search = vi.fn().mockResolvedValue(response([track]));
  const catalog = new CarCatalog(search, () => false);
  setMediaHandlers({ catalogSearch: q => catalog.search(q) });
  (win().__awMediaCmd as (s: string) => void)(JSON.stringify({ type: 'catalogSearch', requestId: 'req1', query: 'Wallpaper' }));
  await vi.waitFor(() => expect(media).toHaveBeenCalled());
  expect(search).toHaveBeenCalledWith('Wallpaper');
  expect(JSON.parse(media.mock.calls.at(-1)![0]).search).toEqual({ requestId: 'req1', query: 'Wallpaper', songs: [expect.objectContaining({ id: track.key, title: 'Wallpaper', ready: false })] });
  expect(catalog.find(track.key)).toBe(track); // tap resolves original Track, not an invented fallback
});

it('returns empty results and an explicit error on failure rather than leaving the car spinner waiting', async () => {
  const media = vi.fn(); win().AirwaveNative = { media };
  setMediaHandlers({ catalogSearch: () => Promise.reject(new Error('Network unavailable')) });
  (win().__awMediaCmd as (s: string) => void)(JSON.stringify({ type: 'catalogSearch', requestId: 'req2', query: 'missing' }));
  await vi.waitFor(() => expect(media).toHaveBeenCalled());
  expect(JSON.parse(media.mock.calls.at(-1)![0]).search).toMatchObject({ requestId: 'req2', query: 'missing', songs: [], error: 'Network unavailable' });
});

it('ignores blank search, bounds retained catalogue rows, and never queues or marks metadata ready', async () => {
  const search = vi.fn().mockResolvedValue(response(Array.from({ length: 30 }, (_, i) => ({ ...track, key: `k${i}` }))));
  const catalog = new CarCatalog(search, () => false);
  expect(await catalog.search('  ')).toEqual([]);
  expect(search).not.toHaveBeenCalled();
  const songs = await catalog.search('Wallpaper');
  expect(songs).toHaveLength(25);
  expect(songs.every(s => !s.ready)).toBe(true);
  expect(catalog.find('k29')).toBeUndefined();
});

it('debounces typed car prefixes so the final query is searched instead of being starved', async () => {
  const search = vi.fn().mockResolvedValue(response([track]));
  const catalog = new CarCatalog(search);
  const requests = ['W','Wa','Wal','Wall','Wallp','Wallpa','Wallpap','Wallpape','Wallpaper'].map(q => catalog.search(q));
  const results = await Promise.all(requests);
  expect(search).toHaveBeenCalledTimes(1);
  expect(search).toHaveBeenCalledWith('Wallpaper');
  expect(results.slice(0, -1).every(r => r.length === 0)).toBe(true);
  expect(results.at(-1)?.[0]?.id).toBe(track.key);
});

it('does not cancel the visible query when the car concurrently refreshes another search', async () => {
  const search = vi.fn(async (q: string) => response([{ ...track, key: q, title: q }]));
  const catalog = new CarCatalog(search);
  const [visible, refresh] = await Promise.all([catalog.search('New song query'), catalog.search('Wallpaper')]);
  expect(visible[0]?.id).toBe('New song query');
  expect(refresh[0]?.id).toBe('Wallpaper');
  expect(search).toHaveBeenCalledTimes(2);
});

/**
 * VOICE-SEARCH-001 in the car. Owner: "a user should be able to search via song name or song lyric and
 * have this work on android, android auto, and windows". The car's search box and "play ..." voice
 * requests ask for titles and lyrics together, as the phone's search box does: title matches first,
 * then songs whose words match, never the same song twice.
 */
it('answers a car search with title matches, then the songs whose lyrics match', async () => {
  const lyric = { ...track, key: 'catalog:lyric', title: 'Bohemian Rhapsody', artist: 'Queen' } as Track;
  const search = vi.fn().mockResolvedValue(response([track]));
  const lyrics = vi.fn().mockResolvedValue({ results: [lyric, track], query: 'is this the real life', named: 1, unplayable: 0 });
  const catalog = new CarCatalog(search, () => false, lyrics);
  const songs = await catalog.search('is this the real life');
  expect(lyrics).toHaveBeenCalledWith('is this the real life');
  expect(songs.map((s) => s.id)).toEqual(['catalog:one', 'catalog:lyric']);
  expect(catalog.find('catalog:lyric')).toBe(lyric);
});

it('still answers with title matches when the lyrics service fails', async () => {
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([track])), () => false, vi.fn().mockRejectedValue(new Error('busy')));
  expect((await catalog.search('Wallpaper')).map((s) => s.id)).toEqual(['catalog:one']);
});

/**
 * ALBUM-CAR-001. Owner: "Ensure the album search works on mobile and android auto as well". The car's
 * search answers with albums too, each already opened so the car can list its songs; when the words name
 * an album (or the voice request asks for an album) the answer says to play that album from its first
 * song, and the album's songs keep the album as their context.
 */
const chaos = { id: 'dz:498395131', provider: 'deezer', title: 'A Great Chaos', artist: 'Ken Carson', artwork: 'https://cdn/c.jpg', year: '2023', kind: 'album', count: 2, url: '' } as const;
const single = { ...chaos, id: 'dz:9', title: 'Overseas', kind: 'single', count: 1 } as const;
const green = { ...track, key: 'ken carson|green room|', title: 'Green Room', artist: 'Ken Carson', album: 'A Great Chaos' } as Track;
const jen = { ...track, key: 'ken carson|jennifer s body|', title: 'Jennifer\u2019s Body', artist: 'Ken Carson', album: 'A Great Chaos' } as Track;
const albumsOf = (list: unknown[]) => vi.fn().mockResolvedValue({ query: 'q', albums: list, sources: {} });
const opener = vi.fn(async (id: string) => ({ album: { ...chaos, id, tracks: [green, jen], duration: 300, genres: [] } }));

it('answers a car search with albums, opened, and plays the album the words name', async () => {
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([green])), () => false, null, albumsOf([chaos, single]), opener);
  const r = await catalog.searchAll('a great chaos');
  expect(opener).toHaveBeenCalledWith('dz:498395131');
  expect(opener).not.toHaveBeenCalledWith('dz:9'); // a single is a song, not an album to browse
  expect(r.albums).toEqual([{ id: 'dz:498395131', title: 'A Great Chaos', artist: 'Ken Carson', artwork: 'https://cdn/c.jpg', songs: [
    expect.objectContaining({ id: 'calbum/dz%3A498395131/track/ken%20carson%7Cgreen%20room%7C', title: 'Green Room' }),
    expect.objectContaining({ id: 'calbum/dz%3A498395131/track/ken%20carson%7Cjennifer%20s%20body%7C' }),
  ] }]);
  expect(r.play).toBe('calbum/dz%3A498395131/track/ken%20carson%7Cgreen%20room%7C');
  // A tap on an album's song finds the song and the album it plays in.
  expect(catalog.albumOf(r.play!)).toEqual({ track: green, tracks: [green, jen] });
  expect(catalog.find(r.play!)).toBe(green);
  expect(r.songs.map((s) => s.id)).toEqual([green.key]);
  // The old entry point still answers with the songs.
  expect((await catalog.search('a great chaos')).map((s) => s.id)).toEqual([green.key]);
});

it('plays a song rather than an album unless the words name the album or the request asks for one', async () => {
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([green])), () => false, null, albumsOf([chaos]), opener);
  expect((await catalog.searchAll('green room')).play).toBeNull();
  expect((await catalog.searchAll('ken carson', { album: true })).play).toBe('calbum/dz%3A498395131/track/ken%20carson%7Cgreen%20room%7C');
});

it('still answers with the songs when the album search or an album fails', async () => {
  const broken = new CarCatalog(vi.fn().mockResolvedValue(response([green])), () => false, null, vi.fn().mockRejectedValue(new Error('down')), opener);
  expect(await broken.searchAll('a great chaos')).toMatchObject({ albums: [], play: null, songs: [expect.objectContaining({ id: green.key })] });
  const unopened = new CarCatalog(vi.fn().mockResolvedValue(response([green])), () => false, null, albumsOf([chaos]), vi.fn().mockRejectedValue(new Error('gone')));
  expect((await unopened.searchAll('a great chaos')).albums).toEqual([]);
  // An album none of whose songs can be played here is not offered as an empty folder.
  const empty = new CarCatalog(vi.fn().mockResolvedValue(response([green])), () => false, null, albumsOf([chaos]), vi.fn(async () => ({ album: { ...chaos, tracks: [], duration: null, genres: [] } })));
  expect(await empty.searchAll('a great chaos')).toMatchObject({ albums: [], play: null });
  expect(broken.albumOf('calbum/x/track/y')).toBeNull();
});

it('finds a song by its lyrics alone when no title matches', async () => {
  const lyric = { ...track, key: 'catalog:lyric', title: 'Bohemian Rhapsody', artist: 'Queen' } as Track;
  const none = { results: [], sources: { deezer: { state: 'ok', count: 0 } }, ms: 0, bytes: 0 };
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(none), () => false, vi.fn().mockResolvedValue({ results: [lyric], query: 'x', named: 1, unplayable: 0 }));
  expect((await catalog.search('is this the real life')).map((s) => s.id)).toEqual(['catalog:lyric']);
});
