import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import { ARTIST_SUBS_KEY } from './artist-subs';
import type { Dict } from './shape';

/**
 * GENRE-LOAD-001 — owner: "ensure genre & sub genre tags load on both apps".
 *
 * Measured before, on the two apps' own queues: 20 of 36 rows on the phone and 31 of 31 on Windows showed
 * no genre at all, among them Sade, Michael Jackson and Mariah Carey. Three causes, none of them "nobody
 * knows this song's genre":
 *   1. a song the listener added themselves, and every row of a restored queue, never went through a
 *      discovery run, so it carried no characteristics however much was known about it;
 *   2. the run read a song's Deezer album genre only for the 40 leading songs of an early ranking, not for
 *      the songs it finally showed;
 *   3. MusicBrainz was asked about an artist only to refine a genre the song already had, never to name
 *      one for a song with none.
 */
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dzTrack = (id: number, title: string, artist: string, albumId: number) => ({
  id, title, title_short: title, readable: true, type: 'track', duration: 200, rank: 1, link: `https://www.deezer.com/track/${id}`,
  artist: { id: 9, name: artist }, contributors: [{ id: 9, name: artist }], album: { id: albumId, title: 'An album' },
});
const dzAlbum = (id: number, ...genres: string[]) => ({ id, title: 'An album', release_date: '1992-10-26', genres: { data: genres.map((name, i) => ({ id: i + 1, name })) }, tracks: { data: [] } });
const mbArtist = (name: string, ...tags: string[]) => ({ artists: [{ name, score: 100, tags: tags.map((t, i) => ({ name: t, count: 9 - i })) }] });

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
const row = (key: string, over: Dict = {}): Dict => ({
  rank: 1, score: 0, coverage: 0, tier: 'related', evidence: 'thin', best_seed: null, reasons: [], uncertainty: [], new_release: false, factors: {}, weights: {}, sources: [],
  playback: { open: [], preview: null, embed: null },
  track: { key, id: `yt:${key}`, provider: 'ytmusic', platform_id: key, title: `Song ${key}`, artists: ['Sade'], artist: 'Sade', duration: 200, tags: [], url: `https://music.youtube.com/watch?v=${key}`, ...over },
});
const open = async (items: Dict[], routes: Record<string, unknown> = {}, prime?: (s: Store) => Promise<void>) => {
  const store = await Store.open(new MemoryBackend());
  await store.put('last_result', { phase: 'final', items, count: items.length, asked: items.length, sources: {}, audio: {}, timings: {}, transfer: {}, saved_at: 1 });
  await prime?.(store);
  const w = world(routes);
  const api = new LocalApi({ store, port: w.port as never, encoder: null, spotifySearch: () => async () => [] });
  return { api, store, seen: w.seen };
};
const itemsOf = (r: { body: unknown }) => (r.body as Dict)['items'] as Dict[];
const genresOf = (it: Dict) => ((it['characteristics'] as Dict | undefined)?.['genres'] ?? []) as string[];
const TAG = (name: string, label = name) => ({ name, label, source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false });

describe('a stored queue shows what is already known, with no request (GENRE-LOAD-001)', () => {
  it('gives a row its genres from its own tags when it was stored without them worked out', async () => {
    const { api, seen } = await open([row('a', { tags: [TAG('r&b', 'R&B')] })]);
    const it0 = itemsOf(await api.handle('GET', '/api/last', null))[0]!;
    expect(genresOf(it0)).toEqual(['R&B']);
    expect((it0['characteristics'] as Dict)['family']).toBe('R&B/Afro/Latin');
    expect(seen).toEqual([]);
  });

  it('gives a row with no tags what was already learned about its artist', async () => {
    const { api, seen } = await open([row('a')], {}, async (s) => {
      await s.put(ARTIST_SUBS_KEY, { sade: { at: 1, tags: [{ name: 'soul', label: 'soul', source: 'MusicBrainz artist tags', scope: 'artist', confidence: 0.5, inferred: false }] } });
    });
    const it0 = itemsOf(await api.handle('GET', '/api/last', null))[0]!;
    expect(genresOf(it0)).toEqual(['soul']);
    expect(((it0['track'] as Dict)['tags'] as Dict[]).map((t) => t['name'])).toEqual(['soul']);
    expect(seen).toEqual([]);
  });

  it('leaves everything a row already says about its genres exactly as it was', async () => {
    const kept = { ...row('a', { tags: [TAG('pop', 'Pop')] }), characteristics: { family: 'pop', subgenre: null, genres: ['Pop'], taste_fit: 0.42 } };
    const { api } = await open([kept]);
    const got = itemsOf(await api.handle('GET', '/api/last', null))[0]!;
    // GENRE-ALL-001 adds what the row lacks beside it (styles, fill); nothing it carried is rewritten.
    expect(got).toMatchObject(kept);
    expect(got['track']).toEqual((kept as Dict)['track']);
  });
});

describe('the rows nothing is known about are looked up (GENRE-LOAD-001)', () => {
  const ROUTES = {
    'api.deezer.com/track/501': dzTrack(501, 'No Ordinary Love', 'Sade', 77),
    'api.deezer.com/album/77': dzAlbum(77, 'R&B', 'Soul & Funk'),
    'api.deezer.com/search?q=Mariah%20Carey%20Vision%20of%20Love': { data: [dzTrack(502, 'Vision of Love', 'Mariah Carey', 78)] },
    'api.deezer.com/track/502': dzTrack(502, 'Vision of Love', 'Mariah Carey', 78),
    'api.deezer.com/album/78': dzAlbum(78, 'Pop'),
    'api.deezer.com/search': { data: [] },
    'musicbrainz.org/ws/2/artist?query=artist%3A%22Bobby%20Caldwell%22': mbArtist('Bobby Caldwell', 'blue-eyed soul', 'soul', 'smooth jazz'),
    'musicbrainz.org/ws/2/artist': { artists: [] },
  };
  const three = () => [
    row('dz', { id: 'deezer:501', provider: 'deezer', platform_id: '501', title: 'No Ordinary Love', album_id: '77' }),
    row('yt', { title: 'Vision of Love', artists: ['Mariah Carey'], artist: 'Mariah Carey' }),
    row('mb', { title: 'What You Won\u2019t Do for Love', artists: ['Bobby Caldwell'], artist: 'Bobby Caldwell' }),
  ];

  it('reads the album genre of a Deezer song, finds a YouTube Music song on Deezer, and asks MusicBrainz about the artist last', async () => {
    const { api, store, seen } = await open(three(), ROUTES);
    const r = await api.handle('POST', '/api/queue/genres', {});
    expect(r.status).toBe(200);
    const body = r.body as Dict;
    const by = new Map((body['items'] as Dict[]).map((x) => [String(x['key']), x]));
    expect(genresOf(by.get('dz')!)).toEqual(['R&B', 'Soul & Funk']);
    expect(genresOf(by.get('yt')!)).toEqual(['Pop']);
    expect(genresOf(by.get('mb')!).length).toBeGreaterThan(0);
    expect(((by.get('mb')!['tags'] as Dict[])[0] as Dict)['source']).toBe('MusicBrainz artist tags');
    expect(body['left']).toBe(0);
    // Kept, so the next start shows them at once.
    const stored = (store.get<Dict>('last_result')!['items'] as Dict[]).map(genresOf);
    expect(stored.every((g) => g.length > 0)).toBe(true);
    // GENRE-ALL-001: Deezer names one word for an album, so MusicBrainz is now asked what kind of it
    // each artist makes as well: once per artist (three here), never once per song.
    expect(seen.filter((u) => u.startsWith('musicbrainz.org')).length).toBe(3);
  }, 30_000);

  it('reads the genre of a song with no known length from the same-named song by the same artist', async () => {
    // YouTube Music rows often carry no duration. Without one the two recordings cannot be proved the
    // same, which matters for playing a song but not for its genre: a same-titled song by the same
    // artist is the same kind of music. Measured on Windows: this left 3 of 4 checked songs unlabelled.
    const { api } = await open([row('nolen', { title: 'Vision of Love', artists: ['Mariah Carey'], artist: 'Mariah Carey', duration: null })], ROUTES);
    const body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    expect(genresOf((body['items'] as Dict[])[0]!)).toEqual(['Pop']);
  }, 30_000);

  it('does not borrow a genre from a song whose title only resembles it', async () => {
    const routes = { ...ROUTES, 'api.deezer.com/search?q=Mariah%20Carey%20Vision%20of%20Lov': { data: [dzTrack(502, 'Vision of Love', 'Mariah Carey', 78)] } };
    const { api } = await open([row('near', { title: 'Vision of Lov', artists: ['Mariah Carey'], artist: 'Mariah Carey', duration: null })], routes);
    const body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    // GENRE-ALL-001: the row comes back so the page knows it has been looked at; it is given no genre.
    expect((body['items'] as Dict[]).map((x) => [x['tags'], genresOf(x), (x['characteristics'] as Dict)['fill']])).toEqual([[[], [], []]]);
  }, 30_000);

  it('puts what the services say in place of a guess, and keeps the guess when they say nothing', async () => {
    // Seen on the phone: Miguel's "Sure Thing" shown as Pop, a guess lent by the starting song.
    const GUESS = { name: 'pop', label: 'pop', source: 'Guessed from the starting song', scope: 'seed', confidence: 0.2, inferred: true };
    const guessed = (key: string, over: Dict) => ({ ...row(key, { tags: [GUESS], ...over }), characteristics: { family: 'Pop', subgenre: null, genres: ['pop'] } });
    const { api, seen } = await open([
      guessed('g1', { id: 'deezer:501', provider: 'deezer', platform_id: '501', album_id: '77' }),
      guessed('g2', { title: 'Nobody Knows This', artists: ['zzqx'], artist: 'zzqx' }),
    ], ROUTES);
    const body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    // Both come back: g1 with what Deezer said, g2 unchanged but no longer waiting to be looked at.
    expect((body['items'] as Dict[]).map((x) => x['key'])).toEqual(['g1', 'g2']);
    expect(genresOf((body['items'] as Dict[])[0]!)).toEqual(['R&B', 'Soul & Funk']);
    expect(genresOf((body['items'] as Dict[])[1]!)).toEqual(['pop']);
    expect(body['left']).toBe(0);
    const stored = itemsOf(await api.handle('GET', '/api/last', null));
    expect(genresOf(stored[1]!)).toEqual(['pop']);
    // The song nothing could place is not asked about a second time.
    const asked = seen.length;
    expect((await api.handle('POST', '/api/queue/genres', {})).body).toEqual({ items: [], left: 0 });
    expect(seen.length).toBe(asked);
  }, 30_000);

  it('asks about a few songs at a time and says how many are left', async () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`k${i}`, { id: `deezer:${600 + i}`, provider: 'deezer', platform_id: String(600 + i), album_id: '77' }));
    const routes: Record<string, unknown> = { 'api.deezer.com/album/77': dzAlbum(77, 'R&B') };
    for (let i = 0; i < 9; i++) routes[`api.deezer.com/track/${600 + i}`] = dzTrack(600 + i, `Song k${i}`, 'Sade', 77);
    const { api } = await open(many, routes);
    const first = (await api.handle('POST', '/api/queue/genres', { limit: 4 })).body as Dict;
    const own = (first['items'] as Dict[]).filter((x) => (x['tags'] as unknown[]).length > 0);
    expect(own.length).toBe(4);
    // GENRE-ALL-001: the five still to ask about come back too, showing an estimate from the four that are known.
    const waiting = (first['items'] as Dict[]).filter((x) => !(x['tags'] as unknown[]).length);
    expect(waiting.length).toBe(5);
    for (const x of waiting) expect(((x['characteristics'] as Dict)['fill'] as Dict[])[0]).toEqual({ label: 'R&B', sub: false, guess: true, why: 'Most songs in this list' });
    expect(first['left']).toBe(5);
    const second = (await api.handle('POST', '/api/queue/genres', { limit: 4 })).body as Dict;
    expect(second['left']).toBe(1);
  }, 30_000);

  it('does not ask again about a song nothing could place, so the looking ends', async () => {
    const { api, seen } = await open([row('none', { title: 'Nobody Knows This', artists: ['zzqx'], artist: 'zzqx' })], { 'api.deezer.com/search': { data: [] }, 'musicbrainz.org/ws/2/artist': { artists: [] } });
    const first = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    expect((first['items'] as Dict[]).map((x) => [x['tags'], genresOf(x)])).toEqual([[[], []]]);
    expect(first['left']).toBe(0);
    const asked = seen.length;
    expect(asked).toBeGreaterThan(0);
    expect((await api.handle('POST', '/api/queue/genres', {})).body).toEqual({ items: [], left: 0 });
    expect(seen.length).toBe(asked);
  }, 30_000);

  it('answers with nothing to do when every row has its genres', async () => {
    const { api, seen } = await open([{ ...row('a'), characteristics: { family: 'pop', subgenre: null, genres: ['Pop'] } }]);
    expect((await api.handle('POST', '/api/queue/genres', {})).body).toEqual({ items: [], left: 0 });
    expect(seen).toEqual([]);
  });
});

describe('a starting song carries its genres too (GENRE-LOAD-001)', () => {
  it('gives a starting song with no tags what is already known about it, with no request', async () => {
    const { api, seen } = await open([], {}, async (st) => {
      await st.setSeeds([{ key: 's1', id: 'yt:s1', provider: 'ytmusic', platform_id: 's1', title: 'Smooth Operator', artists: ['Sade'], tags: [] }, { key: 's2', id: 'yt:s2', provider: 'ytmusic', platform_id: 's2', title: 'Other', artists: ['Nobody'], tags: [TAG('pop', 'Pop')] }]);
      await st.put(ARTIST_SUBS_KEY, { sade: { at: 1, tags: [{ name: 'soul', label: 'soul', source: 'MusicBrainz artist tags', scope: 'artist', confidence: 0.5, inferred: false }] } });
    });
    const seeds = ((await api.handle('GET', '/api/seeds', null)).body as Dict)['seeds'] as Dict[];
    expect((seeds[0]!['tags'] as Dict[]).map((t) => t['name'])).toEqual(['soul']);
    expect((seeds[1]!['tags'] as Dict[]).map((t) => t['name'])).toEqual(['pop']);
    expect(seen).toEqual([]);
  });
});

describe('a song the listener adds is labelled like any other (GENRE-LOAD-001)', () => {
  it('works out the added row\u2019s genres from its own tags', async () => {
    const { api } = await open([]);
    const added = { ...row('new', { tags: [TAG('soul', 'Soul')] }), added: true };
    const r = await api.handle('POST', '/api/queue/add', { item: added, after: null });
    expect(genresOf(itemsOf(r)[0]!)).toEqual(['Soul']);
  });
});

/**
 * GENRE-ALL-001 — owner: "all songs need to have genres and sub genre tags".
 * The rules are in genre-fill.test.ts; here, that every way a row reaches the page carries them.
 */
describe('every row reaches the page with a main genre and a subgenre (GENRE-ALL-001)', () => {
  const fillOf = (it: Dict) => ((it['characteristics'] as Dict | undefined)?.['fill'] ?? []) as Dict[];
  const stylesOf = (it: Dict) => ((it['characteristics'] as Dict | undefined)?.['styles'] ?? []) as string[];

  it('fills a stored queue from what is known, with no request', async () => {
    const { api, seen } = await open([
      row('era', { artists: ['Michael Jackson'], artist: 'Michael Jackson', tags: [TAG('pop', 'Pop')], release: { date: '1982-11-30' } }),
      row('style', { tags: [TAG('jazz', 'Jazz')] }),
      row('both', { artists: ['Ken Carson'], artist: 'Ken Carson', tags: [TAG('hip-hop', 'Rap/Hip Hop'), TAG('rage', 'rage')] }),
      row('bare', { artists: ['Nobody'], artist: 'Nobody', tags: [], release: { date: '2020-01-01' } }),
    ], {}, async (st) => {
      await st.put(ARTIST_SUBS_KEY, { sade: { at: 1, tags: [], styles: ['smooth jazz', 'jazz pop'] } });
    });
    const items = itemsOf(await api.handle('GET', '/api/last', null));
    expect(fillOf(items[0]!)).toEqual([{ label: '80s pop', sub: true, guess: false, why: 'Released in 1982' }]);
    // The artist's style in the song's own genre; "jazz pop" is a pop style and this song is not pop.
    expect(stylesOf(items[1]!)).toEqual(['Smooth jazz']);
    expect(fillOf(items[1]!)).toEqual([]);
    expect(stylesOf(items[2]!)).toEqual([]);
    expect(fillOf(items[2]!)).toEqual([]);
    expect(fillOf(items[3]!)).toEqual([
      { label: 'Pop', sub: false, guess: true, why: 'Other songs in this list' },
      { label: '2020s pop', sub: true, guess: false, why: 'Released in 2020' },
    ]);
    expect(seen).toEqual([]);
  });

  it('asks MusicBrainz about the artist of a song that has a main genre and no subgenre, once', async () => {
    const routes = { 'musicbrainz.org/ws/2/artist': mbArtist('Sade', 'smooth jazz', 'female singer', 'sophisti-pop') };
    const { api, seen } = await open([row('a', { tags: [TAG('jazz', 'Jazz')] })], routes);
    const body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    expect((body['items'] as Dict[]).map((x) => x['key'])).toEqual(['a']);
    expect(stylesOf((body['items'] as Dict[])[0]!)).toEqual(['Smooth jazz']);
    expect(body['left']).toBe(0);
    expect(seen.filter((u) => u.startsWith('musicbrainz.org')).length).toBe(1);
    const asked = seen.length;
    expect((await api.handle('POST', '/api/queue/genres', {})).body).toEqual({ items: [], left: 0 });
    expect(seen.length).toBe(asked);
  }, 30_000);

  it('does not ask again about an artist MusicBrainz had nothing for', async () => {
    const { api, seen } = await open([row('a', { tags: [TAG('jazz', 'Jazz')] })], { 'musicbrainz.org/ws/2/artist': { artists: [] }, 'api.deezer.com/search': { data: [] } });
    await api.handle('POST', '/api/queue/genres', {});
    const asked = seen.length;
    // MusicBrainz about the artist, then Deezer for the song's year: one look each, and no more.
    expect(seen.filter((u) => u.startsWith('musicbrainz.org')).length).toBe(1);
    expect(asked).toBe(2);
    expect((await api.handle('POST', '/api/queue/genres', {})).body).toEqual({ items: [], left: 0 });
    expect(seen.length).toBe(asked);
  }, 30_000);

  it('keeps the release year Deezer states when it reads a song\u2019s genre, so the era is a fact', async () => {
    const routes = { 'api.deezer.com/track/501': { ...dzTrack(501, 'No Ordinary Love', 'Sade', 77), release_date: '1992-10-26' }, 'api.deezer.com/album/77': dzAlbum(77, 'R&B'), 'musicbrainz.org/ws/2/artist': { artists: [] } };
    const { api, store } = await open([row('dz', { id: 'deezer:501', provider: 'deezer', platform_id: '501', title: 'No Ordinary Love', album_id: '77' })], routes);
    let body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    for (let i = 0; i < 3 && Number(body['left']) > 0; i++) body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    const got = itemsOf(await api.handle('GET', '/api/last', null))[0]!;
    expect(fillOf(got)).toEqual([{ label: '90s R&B', sub: true, guess: false, why: 'Released in 1992' }]);
    expect((((store.get<Dict>('last_result')!['items'] as Dict[])[0]!['track'] as Dict)['release'] as Dict)['date']).toBe('1992-10-26');
  }, 30_000);

  it('reads the year of a song that was given its genre before years were kept, once', async () => {
    const routes = { 'api.deezer.com/track/501': { ...dzTrack(501, 'No Ordinary Love', 'Sade', 77), release_date: '1992-10-26' }, 'api.deezer.com/album/77': dzAlbum(77, 'R&B') };
    const { api, seen } = await open([row('old', { id: 'deezer:501', provider: 'deezer', platform_id: '501', title: 'No Ordinary Love', album_id: '77', tags: [TAG('r&b', 'R&B')] })], routes, async (st) => {
      await st.put(ARTIST_SUBS_KEY, { sade: { at: 1, tags: [], styles: [] } });
    });
    const body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    expect(fillOf((body['items'] as Dict[])[0]!)).toEqual([{ label: '90s R&B', sub: true, guess: false, why: 'Released in 1992' }]);
    const asked = seen.length;
    expect((await api.handle('POST', '/api/queue/genres', {})).body).toEqual({ items: [], left: 0 });
    expect(seen.length).toBe(asked);
  }, 30_000);

  it('marks the year as unproved when it comes from a same-named song with no length to compare', async () => {
    const routes = { 'api.deezer.com/search': { data: [{ ...dzTrack(502, 'Vision of Love', 'Mariah Carey', 78), release_date: '1990-05-15' }] }, 'api.deezer.com/track/502': { ...dzTrack(502, 'Vision of Love', 'Mariah Carey', 78), release_date: '1990-05-15' }, 'api.deezer.com/album/78': dzAlbum(78, 'Pop'), 'musicbrainz.org/ws/2/artist': { artists: [] } };
    const { api, store } = await open([row('nolen', { title: 'Vision of Love', artists: ['Mariah Carey'], artist: 'Mariah Carey', duration: null })], routes);
    let body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    for (let i = 0; i < 3 && Number(body['left']) > 0; i++) body = (await api.handle('POST', '/api/queue/genres', {})).body as Dict;
    const got = itemsOf(await api.handle('GET', '/api/last', null))[0]!;
    expect(fillOf(got)).toEqual([{ label: '90s pop', sub: true, guess: true, why: 'A song of this name by the artist came out in 1990' }]);
    // Nothing of the other song's is claimed as this one's: no release date is written on the track.
    expect(((store.get<Dict>('last_result')!['items'] as Dict[])[0]!['track'] as Dict)['release']).toBeUndefined();
  }, 30_000);

  it('fills a starting song and a song the listener adds the same way', async () => {
    const { api } = await open([], {}, async (st) => {
      await st.setSeeds([{ key: 's1', id: 'yt:s1', provider: 'ytmusic', platform_id: 's1', title: 'Billie Jean', artists: ['Michael Jackson'], tags: [TAG('pop', 'Pop')], release: { date: '1982-11-30' } }]);
    });
    const seeds = ((await api.handle('GET', '/api/seeds', null)).body as Dict)['seeds'] as Dict[];
    expect(fillOf(seeds[0]!)).toEqual([{ label: '80s pop', sub: true, guess: false, why: 'Released in 1982' }]);
    const added = { ...row('new', { tags: [TAG('soul', 'Soul')], release: { date: '1994-05-01' } }), added: true };
    const r = await api.handle('POST', '/api/queue/add', { item: added, after: null });
    expect(fillOf(itemsOf(r)[0]!)).toEqual([{ label: '90s soul', sub: true, guess: false, why: 'Released in 1994' }]);
  });
});
