import { describe, expect, it } from 'vitest';
import { Deezer } from './deezer';
import { HostPacer, Http, type HttpPort, type HttpRequest } from './net';
import { Job, Pipeline } from './pipeline';
import { MemoryBackend, Store } from './store';
import type { Dict } from './shape';

/**
 * GENRE-LOAD-001, inside a discovery run. The run read album genres for the 40 leading songs of an early
 * ranking and asked MusicBrainz only to refine a genre a song already had. A song the run finally showed
 * could therefore reach the list with no genre, or with a guess ("pop, guessed from the starting song")
 * although one small request would have named it.
 */
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dzTrack = (id: number, albumId: number) => ({ id, title: `Song ${id}`, readable: true, type: 'track', duration: 200, link: `https://www.deezer.com/track/${id}`, artist: { id: 9, name: 'Sade' }, album: { id: albumId, title: 'An album' } });
const dzAlbum = (id: number, ...genres: string[]) => ({ id, title: 'An album', release_date: '1992-10-26', genres: { data: genres.map((name, i) => ({ id: i + 1, name })) }, tracks: { data: [] } });
const GUESS = { name: 'pop', label: 'pop', source: 'Guessed from the starting song', scope: 'seed', confidence: 0.2, inferred: true };
const REAL = { name: 'hip-hop', label: 'Rap/Hip Hop', source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false };

async function world(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest) {
      const u = new URL(req.url);
      const key = u.host + u.pathname + u.search;
      seen.push(key);
      const hit = Object.keys(routes).find((k) => key.startsWith(k));
      return hit ? { status: 200, headers: {}, body: enc(routes[hit]) } : { status: 404, headers: {}, body: enc({}) };
    },
  };
  const store = await Store.open(new MemoryBackend());
  const http = new Http(port, new HostPacer({}, 0));
  const pipeline = new Pipeline(store, http, new Deezer(http, store), null as never, null as never, null as never, null, null);
  return { pipeline, seen, job: new Job('t') };
}
const cand = (key: string, over: Dict = {}): Dict => ({ key, title: `Song ${key}`, artists: ['Sade'], provider: 'ytmusic', platform_id: key, duration: 200, tags: [], links: {}, ...over });
const names = (c: Dict) => (c['tags'] as Dict[]).map((t) => `${t['name']}${t['inferred'] ? '~' : ''}`);

describe('every song the run shows is asked about (GENRE-LOAD-001)', () => {
  const ROUTES = { 'api.deezer.com/track/501': dzTrack(501, 77), 'api.deezer.com/album/77': dzAlbum(77, 'R&B'), 'api.deezer.com/track/502': dzTrack(502, 78), 'api.deezer.com/album/78': dzAlbum(78, 'Pop') };

  it('reads the album genre of a shown song that has none, and of one that only has a guess', async () => {
    const w = await world(ROUTES);
    const bare = cand('a', { links: { deezer: { id: '501', url: '' } } });
    const guessed = cand('b', { links: { deezer: { id: '502', url: '' } }, tags: [GUESS] });
    await w.pipeline.genresForShown(w.job, [bare, guessed]);
    expect(names(bare)).toEqual(['r&b']);
    // What Deezer says replaces the guess; it is not listed beside it.
    expect(names(guessed)).toEqual(['pop']);
    expect((guessed['tags'] as Dict[])[0]!['source']).toBe('Deezer album genre');
  });

  it('asks nothing about a song that already has a real genre, or was already read', async () => {
    const w = await world(ROUTES);
    const real = cand('a', { links: { deezer: { id: '501', url: '' } }, tags: [REAL] });
    const read = cand('b', { links: { deezer: { id: '502', url: '' } }, dz_id: '502' });
    await w.pipeline.genresForShown(w.job, [real, read]);
    expect(w.seen).toEqual([]);
    expect(names(real)).toEqual(['hip-hop']);
  });

  it('reads the genre of a shown song with no known length, without claiming the two are one recording', async () => {
    const w = await world({ ...ROUTES, 'api.deezer.com/search': { data: [{ ...dzTrack(501, 77), title: 'Song a' }] } });
    const noLength = cand('a', { duration: null });
    await w.pipeline.genresForShown(w.job, [noLength]);
    expect(names(noLength)).toEqual(['r&b']);
    // Only the genre is taken: no link, preview or id is copied from a song that was not proved the same.
    expect((noLength['links'] as Dict)['deezer']).toBeUndefined();
    expect(noLength['dz_id']).toBeUndefined();
  });

  it('stops at its limit, leading songs first', async () => {
    const routes: Record<string, unknown> = { 'api.deezer.com/album/77': dzAlbum(77, 'R&B') };
    for (let i = 0; i < 6; i++) routes[`api.deezer.com/track/${700 + i}`] = dzTrack(700 + i, 77);
    const w = await world(routes);
    const shown = Array.from({ length: 6 }, (_, i) => cand(`k${i}`, { links: { deezer: { id: String(700 + i), url: '' } } }));
    await w.pipeline.genresForShown(w.job, shown, 4);
    expect(shown.map((c) => names(c).length)).toEqual([1, 1, 1, 1, 0, 0]);
  });
});

describe('MusicBrainz names a genre for a song that has none (GENRE-LOAD-001)', () => {
  const MB = { 'musicbrainz.org/ws/2/artist': { artists: [{ name: 'Sade', score: 100, tags: [{ name: 'soul', count: 9 }, { name: 'smooth jazz', count: 5 }] }] } };

  it('asks about the artist of a song with no genre at all', async () => {
    const w = await world(MB);
    const bare = cand('a');
    await w.pipeline.subgenresFromMusicBrainz(w.job, [bare], 4);
    expect(names(bare)).toContain('soul');
    expect((bare['tags'] as Dict[]).every((t) => t['source'] === 'MusicBrainz artist tags')).toBe(true);
  });

  it('puts what the listeners say in place of a guess', async () => {
    const w = await world(MB);
    const guessed = cand('a', { tags: [GUESS] });
    await w.pipeline.subgenresFromMusicBrainz(w.job, [guessed], 4);
    expect(names(guessed)).not.toContain('pop~');
    expect(names(guessed)).toContain('soul');
  });

  it('still only adds to a real family tag, as before', async () => {
    const w = await world({ 'musicbrainz.org/ws/2/artist': { artists: [{ name: 'Sade', score: 100, tags: [{ name: 'trap', count: 9 }] }] } });
    const family = cand('a', { tags: [REAL] });
    await w.pipeline.subgenresFromMusicBrainz(w.job, [family], 4);
    expect(names(family)).toEqual(['hip-hop', 'trap']);
  });

  it('keeps the guess when the listeners say nothing', async () => {
    const w = await world({ 'musicbrainz.org/ws/2/artist': { artists: [] } });
    const guessed = cand('a', { tags: [GUESS] });
    await w.pipeline.subgenresFromMusicBrainz(w.job, [guessed], 4);
    expect(names(guessed)).toEqual(['pop~']);
  });
});
