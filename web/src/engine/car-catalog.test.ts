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

it('finds a song by its lyrics alone when no title matches', async () => {
  const lyric = { ...track, key: 'catalog:lyric', title: 'Bohemian Rhapsody', artist: 'Queen' } as Track;
  const none = { results: [], sources: { deezer: { state: 'ok', count: 0 } }, ms: 0, bytes: 0 };
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(none), () => false, vi.fn().mockResolvedValue({ results: [lyric], query: 'x', named: 1, unplayable: 0 }));
  expect((await catalog.search('is this the real life')).map((s) => s.id)).toEqual(['catalog:lyric']);
});
