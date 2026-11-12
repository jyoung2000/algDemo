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

const open = async (held: Dict[] = []) => {
  const store = await Store.open(new MemoryBackend());
  for (const t of held) await store.put(`list_tracks`, { ...(store.get<Record<string, Dict>>('list_tracks') ?? {}), [String(t['key'])]: t });
  const port = { request: async () => { throw new Error('offline in this test'); } };
  const api = new LocalApi({ store, port, encoder: null, spotifySearch: () => async () => [] });
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

  it('keeps asking for a name with no id and no name as a bad request', async () => {
    const { api } = await open([]);
    expect((await api.handle('POST', '/api/artist', {})).status).toBe(400);
  }, 30_000);
});
