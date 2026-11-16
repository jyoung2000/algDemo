// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { installMediaCommands, setMediaHandlers } from './media-native';
import { CAR_AUX_MS, CarCatalog, carKinds } from './car-catalog';
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

it('does not wait on a suspended WebView timer when the car searches behind Android Auto', async () => {
  vi.useFakeTimers();
  try {
    const search = vi.fn().mockResolvedValue(response([track]));
    const catalog = new CarCatalog(search);
    const answer = catalog.searchAll('Wallpaper', { mode: 'all' });
    await Promise.resolve();
    expect(search).toHaveBeenCalledWith('Wallpaper');
    expect((await answer).songs[0]?.id).toBe(track.key);
  } finally {
    vi.useRealTimers();
  }
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

// CAR-LYRICS-TRUTH-001: DHU 2026-11-16. The lyric lookup failed ("The daily transfer allowance is used
// up.") and the car's Lyrics folder said "No lyrics found for 'operator'". In Lyrics mode the lyric
// answer IS the answer, so its failure is reported with the reason, not shown as an empty result.
it('reports why a Lyrics-mode search could not run instead of answering "none found"', async () => {
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([track])), () => false,
    vi.fn().mockRejectedValue(new Error('The daily transfer allowance is used up.')));
  await expect(catalog.searchAll('operator', { mode: 'lyrics' })).rejects.toThrow('The daily transfer allowance is used up.');
});

it('keeps title matches in All mode when the lyric lookup fails for the same reason', async () => {
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([track])), () => false,
    vi.fn().mockRejectedValue(new Error('The daily transfer allowance is used up.')));
  expect((await catalog.searchAll('operator', { mode: 'all' })).songs.map((s) => s.id)).toEqual(['catalog:one']);
});

it('still answers "none found" in Lyrics mode when the lyric lookup worked and found nothing', async () => {
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([track])), () => false,
    vi.fn().mockResolvedValue({ results: [], query: 'zzz', named: 0, unplayable: 0 }));
  const r = await catalog.searchAll('zzz', { mode: 'lyrics' });
  expect(r.songs.filter((s) => s.kinds?.includes('lyrics'))).toEqual([]);
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

// CAR-SEARCH-TYPES-001: the car's search icons and its Identify icon.
it('tags each car search song with its kinds, lyric matches included, and lists lyric matches first for a lyrics search', async () => {
  const single = { ...track, key: 's', title: 'Overseas', album: 'Overseas' } as Track;
  const albumSong = { ...track, key: 'a', title: 'Green Room', album: 'A Great Chaos' } as Track;
  const feat = { ...track, key: 'f', title: 'Fell In Love', artists: ['Lil Tecca', 'Ken Carson'], album: 'TEC' } as Track;
  const lyric = { ...track, key: 'l', title: 'Rock N Roll', album: 'A Great Chaos' } as Track;
  const lyrics = vi.fn().mockResolvedValue({ results: [lyric], query: 'q', named: 1, unplayable: 0, sources: {}, ms: 0, bytes: 0 });
  const albums = vi.fn().mockResolvedValue({ query: 'q', sources: {}, albums: [] });
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([single, albumSong, feat])), () => false, lyrics, albums, vi.fn());
  const all = await catalog.searchAll('ken carson');
  // RESULT-ARTIST-001: Ken Carson is credited on the feature, so the search names its artist too.
  expect(all.songs.map(s => [s.id, s.kinds])).toEqual([['s', ['single']], ['a', ['album']], ['f', ['album', 'feature', 'artist']], ['l', ['album', 'lyrics']]]);
  const byWords = await catalog.searchAll('ken carson words', { mode: 'lyrics' });
  expect(byWords.songs[0]?.id).toBe('l');
  // A singles or lyrics search does not spend time opening albums.
  albums.mockClear();
  await catalog.searchAll('ken carson again', { mode: 'singles' });
  expect(albums).not.toHaveBeenCalled();
});

// RESULT-ARTIST-001 (owner, 2026-11-15): "add a single user icon for artist to the search results
// list and android auto so users can search by artist".
it('tags songs by the artist the car searched for, and not songs merely named after them', async () => {
  const by = { ...track, key: 'b', title: 'Overseas', artist: 'Ken Carson', artists: ['Ken Carson'], album: 'Overseas' } as Track;
  const feat = { ...track, key: 'f', title: 'Fell In Love', artist: 'Lil Tecca, Ken Carson', artists: ['Lil Tecca', 'Ken Carson'], album: 'TEC' } as Track;
  const named = { ...track, key: 'n', title: 'Ken Carson Tribute', artist: 'Cover Band', artists: ['Cover Band'], album: null } as unknown as Track;
  expect(carKinds(by, false, 'ken carson')).toContain('artist');
  expect(carKinds(by, false, 'Ken  Carson!')).toContain('artist');
  expect(carKinds(feat, false, 'ken carson')).toContain('artist');
  expect(carKinds(named, false, 'ken carson')).not.toContain('artist');
  expect(carKinds(by)).not.toContain('artist');
  expect(carKinds(by, false, 'carson')).not.toContain('artist');
  const lyrics = vi.fn().mockResolvedValue({ results: [], query: 'q', named: 0, unplayable: 0, sources: {}, ms: 0, bytes: 0 });
  const albums = vi.fn().mockResolvedValue({ query: 'q', sources: {}, albums: [] });
  const catalog = new CarCatalog(vi.fn().mockResolvedValue(response([named, by, feat])), () => false, lyrics, albums, vi.fn());
  const r = await catalog.searchAll('ken carson', { mode: 'artists' });
  // The artist's own songs come first; an artist search spends no time on albums or lyrics.
  expect(r.songs.map(s => s.id)).toEqual(['b', 'f', 'n']);
  expect(r.songs.filter(s => s.kinds?.includes('artist')).map(s => s.id)).toEqual(['b', 'f']);
  expect(albums).not.toHaveBeenCalled();
  expect(lyrics).not.toHaveBeenCalled();
});

it('passes the car search kind to the page and drops an unknown one', async () => {
  const media = vi.fn(); win().AirwaveNative = { media };
  const ask = vi.fn().mockResolvedValue({ songs: [] });
  setMediaHandlers({ catalogSearch: ask });
  const cmd = (o: unknown) => (win().__awMediaCmd as (s: string) => void)(JSON.stringify(o));
  cmd({ type: 'catalogSearch', requestId: 'r1', query: 'x', mode: 'albums' });
  cmd({ type: 'catalogSearch', requestId: 'r2', query: 'y', mode: 'rm -rf' });
  cmd({ type: 'catalogSearch', requestId: 'r3', query: 'z', mode: 'artists' });
  await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
  expect(ask).toHaveBeenNthCalledWith(1, 'x', { album: false, mode: 'albums' });
  expect(ask).toHaveBeenNthCalledWith(2, 'y', { album: false, mode: 'all' });
  expect(ask).toHaveBeenNthCalledWith(3, 'z', { album: false, mode: 'artists' });
});

it('names the music the phone heard for the car, keeps the songs to play, and names nothing for silence', async () => {
  const media = vi.fn(); win().AirwaveNative = { media };
  const named = { ...track, key: 'heard', title: 'Heard Song', album: 'Heard Song' } as Track;
  const identify = vi.fn().mockResolvedValue({ results: [named], query: '', named: 1, unplayable: 0, sources: {}, ms: 0, bytes: 0 });
  let peaks = 50;
  const L = { SAMPLE_RATE: 16000, makeSignature: vi.fn(async (s: Float32Array) => ({ n: s.length })), pickWindow: (s: Float32Array) => s, peakCount: () => peaks, signatureUri: () => 'data:sig', signatureMillis: () => 8000 };
  const catalog = new CarCatalog(vi.fn(), () => false, null, null, null, identify, async () => L);
  setMediaHandlers({ identifyAudio: (s) => catalog.identifyClip(s) });
  // 4 s of a 16-bit tone, as the native recorder sends it.
  const pcm = new Int16Array(16000 * 4).map((_, i) => Math.round(Math.sin(i / 8) * 8000));
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 4096) bin += String.fromCharCode(...bytes.subarray(i, i + 4096));
  const b64 = btoa(bin);
  (win().__awMediaCmd as (s: string) => void)(JSON.stringify({ type: 'identifyAudio', requestId: 'id1', pcm: b64 }));
  await vi.waitFor(() => expect(media).toHaveBeenCalled());
  expect(L.makeSignature.mock.calls[0]![0]).toHaveLength(16000 * 4);
  expect(identify).toHaveBeenCalledWith('data:sig', 8000);
  expect(JSON.parse(media.mock.calls.at(-1)![0]).identify).toEqual({ requestId: 'id1', songs: [expect.objectContaining({ id: 'heard', title: 'Heard Song', kinds: ['single'] })] });
  expect(catalog.find('heard')).toBe(named);
  peaks = 3; // a quiet car: too few peaks to match
  identify.mockClear();
  expect(await catalog.identifyClip(new Float32Array(16000 * 4))).toEqual([]);
  expect(identify).not.toHaveBeenCalled();
  await expect(catalog.identifyClip(new Float32Array(16000))).rejects.toThrow(/too short/);
});

it('answers an identify request with an error the car can show when the page cannot identify', async () => {
  const media = vi.fn(); win().AirwaveNative = { media };
  setMediaHandlers({ identifyAudio: () => Promise.reject(new Error('Offline')) });
  (win().__awMediaCmd as (s: string) => void)(JSON.stringify({ type: 'identifyAudio', requestId: 'id2', pcm: 'AAAA' }));
  await vi.waitFor(() => expect(media).toHaveBeenCalled());
  expect(JSON.parse(media.mock.calls.at(-1)![0]).identify).toEqual({ requestId: 'id2', songs: [], error: 'Offline' });
});

// CAR-AUX-BOUND-001: DHU 2026-11-15, a cold All search waited on its lyric/album parts and the car gave up at 24 s.
it('answers the song matches when lyrics and album bodies never answer (bounded, not dropped forever)', async () => {
  vi.useFakeTimers();
  try {
    const never = <T,>() => new Promise<T>(() => {});
    const search = vi.fn().mockResolvedValue(response([track]));
    const catalog = new CarCatalog(search, () => false, () => never(), () => never(), () => never());
    const answer = catalog.searchAll('Wallpaper', { mode: 'all' });
    let done = false; void answer.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(CAR_AUX_MS - 1);
    expect(done).toBe(false); // the bound is a ceiling, not a shortcut past real answers
    await vi.advanceTimersByTimeAsync(2);
    const r = await answer;
    expect(r.songs.map(s => s.id)).toEqual([track.key]);
    expect(r.albums).toEqual([]);
    expect(CAR_AUX_MS).toBeLessThan(24_000 - 6_000); // leaves the car's deadline room for the song lookup
  } finally { vi.useRealTimers(); }
});

it('a Lyrics search still waits for its lyric matches: they are its answer', async () => {
  vi.useFakeTimers();
  try {
    let give: (v: { results: Track[] }) => void = () => {};
    const lyrics = vi.fn(() => new Promise<{ results: Track[] }>(r => { give = r; }));
    const search = vi.fn().mockResolvedValue(response([]));
    const catalog = new CarCatalog(search, () => false, lyrics as never);
    const answer = catalog.searchAll('i got a feeling', { mode: 'lyrics' });
    await vi.advanceTimersByTimeAsync(CAR_AUX_MS + 1000);
    give({ results: [{ ...track, key: 'lyric:1', title: 'Rock N Roll' }] });
    const r = await answer;
    expect(r.songs.map(s => s.title)).toEqual(['Rock N Roll']);
  } finally { vi.useRealTimers(); }
});
