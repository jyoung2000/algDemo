import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import type { Dict } from './shape';

/**
 * ARTIST-FALLBACK-001. Owner, on seeing "No artist named "jackiegalama" was found on Deezer or
 * YouTube Music": "ensure this error doesnt happen".
 *
 * Song credits include names the music services have no page for - uploader handles, small
 * self-releases, names a provider spells differently. Tapping one must still land somewhere useful:
 * the songs the app itself holds by that name, said plainly, instead of a red error.
 */
const song = (over: Partial<Dict> = {}): Dict => ({
  key: 'k1', id: 'yt:1', provider: 'ytmusic', platform_id: '1', title: 'A song',
  artists: ['jackiegalama'], album: null, artwork: null, duration: 200, isrc: null,
  url: 'https://music.youtube.com/watch?v=1', source: 'https://music.youtube.com/watch?v=1',
  tags: [], ready: true, ...over,
});

/** The services answer, and have nobody by that name. */
const NOBODY = { request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('{"data":[]}') }) };
/** The services cannot be reached at all. */
const UNREACHABLE = { request: async () => { throw new Error('getaddrinfo ENOTFOUND'); } };

const open = async (held: Dict[] = [], port: { request: (...a: never[]) => Promise<unknown> } = NOBODY) => {
  const store = await Store.open(new MemoryBackend());
  for (const t of held) await store.put(`list_tracks`, { ...(store.get<Record<string, Dict>>('list_tracks') ?? {}), [String(t['key'])]: t });
  const api = new LocalApi({ store, port: port as never, encoder: null, spotifySearch: () => async () => [] });
  return { api, store };
};

const ask = (api: LocalApi, name: string) => api.handle('POST', '/api/artist', { name });

describe('an artist name the services do not know (ARTIST-FALLBACK-001)', () => {
  it('answers with a page instead of an error', async () => {
    const { api } = await open([song()]);
    const r = await ask(api, 'jackiegalama');
    expect(r.status).toBe(200);
    const artist = (r.body as Dict)['artist'] as Dict;
    expect(artist['name']).toBe('jackiegalama');
  }, 30_000);

  it('shows the songs the app already holds by that name', async () => {
    const { api } = await open([song(), song({ key: 'k2', id: 'yt:2', title: 'Another song' })]);
    const r = await ask(api, 'jackiegalama');
    const artist = (r.body as Dict)['artist'] as Dict;
    expect((artist['songs'] as Dict[]).map((s) => s['title']).sort()).toEqual(['A song', 'Another song']);
  }, 30_000);

  it('marks the page as the local one, with neither service found', async () => {
    const { api } = await open([song()]);
    const artist = ((await ask(api, 'jackiegalama')).body as Dict)['artist'] as Dict;
    expect(artist['local']).toBe(true);
    const sources = artist['sources'] as Record<string, { state: string }>;
    expect(sources['deezer']?.state).toBe('none');
    expect(sources['ytmusic']?.state).toBe('none');
  }, 30_000);

  it('still answers when nothing is held by that name, with no songs', async () => {
    const { api } = await open([]);
    const r = await ask(api, 'nobody at all');
    expect(r.status).toBe(200);
    const artist = (r.body as Dict)['artist'] as Dict;
    expect(artist['songs']).toEqual([]);
    expect(artist['local']).toBe(true);
  }, 30_000);

  it('answers the page\'s next request, for every song, in that request\'s own shape (ARTIST-FALLBACK-002)', async () => {
    // The page asks for every song as soon as it is up, with the id it was just given. The answer was
    // a second artist page: the screen got no song list and the whole app went blank.
    const { api } = await open([song(), song({ key: 'k2', id: 'yt:2', title: 'Another song' })]);
    const artist = ((await ask(api, 'jackiegalama')).body as Dict)['artist'] as Dict;
    const r = await api.handle('POST', '/api/artist/songs', { id: artist['id'], name: artist['name'] });
    expect(r.status).toBe(200);
    const body = r.body as Dict;
    expect(body['artist']).toBeUndefined();
    expect((body['songs'] as Dict[]).map((s) => s['title']).sort()).toEqual(['A song', 'Another song']);
    expect(body['features']).toEqual([]);
    expect(body['failed']).toBe(0);
  }, 30_000);

  it('answers the page\'s features request in that request\'s own shape too (FEATURES-ALL-001)', async () => {
    const { api } = await open([song()]);
    const artist = ((await ask(api, 'jackiegalama')).body as Dict)['artist'] as Dict;
    const r = await api.handle('POST', '/api/artist/features', { id: artist['id'], name: artist['name'] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ features: [], complete: true });
  }, 30_000);

  it('keeps asking for a name with no id and no name as a bad request', async () => {
    const { api } = await open([]);
    expect((await api.handle('POST', '/api/artist', {})).status).toBe(400);
    expect((await api.handle('POST', '/api/artist/features', {})).status).toBe(400);
  }, 30_000);
});

/**
 * ARTIST-SOURCES-001. The local page used to say "Neither Deezer nor YouTube Music has a page" even
 * when the services had never been asked. The answer now carries what really happened to each.
 */
describe('why a service was not read (ARTIST-SOURCES-001)', () => {
  it('says the services could not be reached, not that they have no page', async () => {
    const { api } = await open([song()], UNREACHABLE);
    const artist = ((await ask(api, 'jackiegalama')).body as Dict)['artist'] as Dict;
    expect(artist['local']).toBe(true);
    expect(artist['sources']).toMatchObject({ deezer: { state: 'failed', why: 'offline' }, ytmusic: { state: 'failed', why: 'offline' } });
  }, 30_000);

  // ALLOWANCE-ARCH-001 (owner, 2026-11-20): an artist page the listener opened is asked for whatever the day has
  // used; only background work waits for the allowance. (Before: both services were refused as 'allowance'.)
  it('still asks the services when the day\u2019s allowance is used up', async () => {
    const { api, store } = await open([song()]);
    store.addTransfer('search', 50_000_000_000);
    const artist = ((await ask(api, 'jackiegalama')).body as Dict)['artist'] as Dict;
    expect(artist['local']).toBe(true);
    const sources = artist['sources'] as Record<string, { state: string; why?: string }>;
    expect(sources['deezer']?.why).not.toBe('allowance');
    expect(sources['ytmusic']?.why).not.toBe('allowance');
  }, 30_000);
});

/**
 * ARTIST-ALL-SOURCES-001: the page asks what the other platforms have as soon as it is up. Like its
 * other follow-up requests, this one answers in its own shape for a name no service has a page for.
 */
describe('what the other platforms have for an artist (ARTIST-ALL-SOURCES-001)', () => {
  const sources = (api: LocalApi, name: string) => api.handle('POST', '/api/artist/sources', { name });

  it('answers in its own shape, with every platform it asks accounted for', async () => {
    const { api } = await open([song()]);
    const r = await sources(api, 'jackiegalama');
    expect(r.status).toBe(200);
    const body = r.body as Dict;
    expect(body['songs']).toEqual([]);
    expect(body['albums']).toEqual([]);
    expect(body['singles']).toEqual([]);
    expect(Object.keys(body['sources'] as Dict).sort()).toEqual(['apple', 'audius', 'bandcamp', 'soundcloud']);
    expect(body['artist']).toBeUndefined();
  }, 30_000);

  it('says a platform was not reached rather than that it has no page', async () => {
    const { api } = await open([song()], UNREACHABLE);
    const body = (await sources(api, 'jackiegalama')).body as Dict;
    const s = body['sources'] as Record<string, { state: string; why?: string }>;
    expect(s['audius']).toEqual({ state: 'failed', why: 'offline' });
    expect(s['soundcloud']?.state).toBe('failed');
  }, 60_000);

  it('keeps asking for a name with no id and no name as a bad request', async () => {
    const { api } = await open([]);
    expect((await api.handle('POST', '/api/artist/sources', {})).status).toBe(400);
  }, 30_000);
});
