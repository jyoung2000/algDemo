/**
 * ARTIST-FAV-001 and ARTIST-SIZE-001 through the whole local API (owner, 2026-11-21): a starred artist alone is
 * enough for Find my next favorite, its related artists are asked for, the list is editable, and a mainstream act
 * (Ken Carson, 113k Deezer followers) ranks below an equally related underground act for an OsamaSon (21k) listener.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const enc = (s: string) => new TextEncoder().encode(s);
const ARTISTS: Record<string, { id: number; name: string; fans: number }> = {
  osamason: { id: 7, name: 'OsamaSon', fans: 21296 },
  summrs: { id: 8, name: 'Summrs', fans: 10708 },
  'ken carson': { id: 9, name: 'Ken Carson', fans: 113248 },
};
const byId = (id: number) => Object.values(ARTISTS).find((a) => a.id === id)!;
const dzTrack = (n: number, a: { id: number; name: string }) => ({
  id: n, title: `${a.name} Song ${n}`, duration: 170, artist: { id: a.id, name: a.name }, album: { id: n * 3, title: `${a.name} Album ${n}`, cover_medium: 'c' },
  preview: `https://p/${n}.mp3`, readable: true, rank: 500000, link: `https://www.deezer.com/track/${n}`,
});

function fakeDeezer(asked: string[]) {
  return {
    async request(req: { url: string }) {
      const u = new URL(req.url);
      const json = (o: unknown) => ({ status: 200, headers: {}, body: enc(JSON.stringify(o)) });
      if (u.host !== 'api.deezer.com') return { status: 404, headers: {}, body: enc('{}') };
      asked.push(u.pathname + u.search);
      if (u.pathname === '/search/artist') {
        const a = ARTISTS[(u.searchParams.get('q') ?? '').toLowerCase()];
        return json({ data: a ? [{ id: a.id, name: a.name, nb_fan: a.fans }] : [] });
      }
      const m = /^\/artist\/(\d+)(?:\/(\w+))?$/.exec(u.pathname);
      if (m) {
        const a = byId(Number(m[1]));
        if (!a) return json({ data: [] });
        if (!m[2]) return json({ id: a.id, name: a.name, nb_fan: a.fans });
        // Ken Carson is Deezer's first related artist, so without size matching he leads the related songs.
        if (m[2] === 'related') return a.id === 7 ? json({ data: [byId(9), byId(8)].map((x) => ({ id: x.id, name: x.name })) }) : json({ data: [] });
        // Every artist answers with the same number of songs in the same places, so only size can split them.
        if (m[2] === 'top' || m[2] === 'radio') return json({ data: [1, 2, 3].map((i) => dzTrack(a.id * 100 + i + (m[2] === 'radio' ? 50 : 0), a)) });
        return json({ data: [] });
      }
      return json({ data: [] });
    },
  };
}

async function run(api: LocalApi) {
  const started = await api.handle('POST', '/api/recommend', {});
  expect(started.status).toBe(200);
  const id = String((started.body as Record<string, unknown>)['job'] ?? '');
  for (let i = 0; i < 300; i++) {
    const st = (await api.handle('GET', `/api/jobs/${id}`)).body as Record<string, unknown>;
    if (st['done']) return (st['result'] ?? {}) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('discovery never finished');
}

describe('starred artists and artist size through the API (ARTIST-FAV-001, ARTIST-SIZE-001)', () => {
  it('keeps an editable list of starred artists', async () => {
    const api = new LocalApi({ store: await Store.open(new MemoryBackend()), port: fakeDeezer([]) as never, encoder: null, spotifySearch: () => async () => [] });
    await api.handle('POST', '/api/fav-artists', { op: 'add', artist: { name: 'Summrs', pageId: 'dz:8' } });
    await api.handle('POST', '/api/fav-artists', { op: 'add', artist: { name: 'OsamaSon' } });
    let l = (await api.handle('GET', '/api/fav-artists')).body as { artists: { name: string; deezerId: string | null }[] };
    expect(l.artists.map((a) => a.name)).toEqual(['OsamaSon', 'Summrs']);
    expect(l.artists[1]!.deezerId).toBe('8');
    await api.handle('POST', '/api/fav-artists', { op: 'remove', name: 'summrs' });
    l = (await api.handle('GET', '/api/fav-artists')).body as typeof l;
    expect(l.artists.map((a) => a.name)).toEqual(['OsamaSon']);
    expect((await api.handle('POST', '/api/fav-artists', { op: 'add', artist: { name: '' } })).status).toBe(400);
  });

  it('a starred artist alone finds music from it and its related artists, mainstream acts ranked below same-size ones', { timeout: 120_000 }, async () => {
    const asked: string[] = [];
    const api = new LocalApi({ store: await Store.open(new MemoryBackend()), port: fakeDeezer(asked) as never, encoder: null, spotifySearch: () => async () => [] });
    await api.handle('POST', '/api/fav-artists', { op: 'add', artist: { name: 'OsamaSon' } });
    const res = await run(api);
    const items = (res['items'] ?? []) as { track: { artists: string[] }; score?: number; factors?: Record<string, number> }[];
    expect(items.length).toBeGreaterThan(0);
    expect(asked.some((p) => p.startsWith('/artist/7/related'))).toBe(true);
    const who = items.map((x) => x.track.artists[0]);
    expect(who).toContain('Summrs');
    expect(who).toContain('Ken Carson');
    expect(who.indexOf('Ken Carson')).toBeGreaterThan(who.indexOf('Summrs'));
    expect(Number((res['timings'] as Record<string, number>)['size_ref'])).toBe(21296);
  });
});
