/**
 * NEXT-FAV-COLD-001 (owner, 2026-11-23): "the find my new favorite button should work without a starting song and
 * with no songs in queue. It should use the users listening algorithm, taste map, and favorite artist to find music
 * the user would like". Through the whole local API, with no starting song and an empty queue.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const enc = (s: string) => new TextEncoder().encode(s);
const ARTISTS: Record<string, { id: number; name: string; fans: number }> = {
  osamason: { id: 7, name: 'OsamaSon', fans: 21296 },
  summrs: { id: 8, name: 'Summrs', fans: 10708 },
};
const byId = (id: number) => Object.values(ARTISTS).find((a) => a.id === id);
const dzTrack = (n: number, a: { id: number; name: string }) => ({
  id: n, title: `${a.name} Song ${n}`, duration: 170, artist: { id: a.id, name: a.name },
  album: { id: n * 3, title: `${a.name} Album ${n}`, cover_medium: 'c' },
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
        if (m[2] === 'related') return json({ data: [] });
        if (m[2] === 'top' || m[2] === 'radio') return json({ data: [1, 2, 3].map((i) => dzTrack(a.id * 100 + i + (m[2] === 'radio' ? 50 : 0), a)) });
        return json({ data: [] });
      }
      return json({ data: [] });
    },
  };
}

const api = (store: Store, asked: string[] = []) =>
  new LocalApi({ store, port: fakeDeezer(asked) as never, encoder: null, spotifySearch: () => async () => [] });

async function run(a: LocalApi) {
  const started = await a.handle('POST', '/api/recommend', {});
  if (started.status !== 200) return { status: started.status, body: started.body as Record<string, unknown> };
  const id = String((started.body as Record<string, unknown>)['job'] ?? '');
  for (let i = 0; i < 400; i++) {
    const st = (await a.handle('GET', `/api/jobs/${id}`)).body as Record<string, unknown>;
    if (st['done']) return { status: 200, body: (st['result'] ?? {}) as Record<string, unknown> };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('discovery never finished');
}

const heard = (title: string, artist: string, key: string) => ({
  kind: 'like',
  event_id: `like:${key}`,
  track: { key, title, artists: [artist], provider: 'deezer', platform_id: key.split(':')[1], duration: 170 },
});

describe('Find my next favorite with no starting song and an empty queue', () => {
  it('starts from what the listening algorithm learned when there is no seed and no star', { timeout: 120_000 }, async () => {
    const store = await Store.open(new MemoryBackend());
    const asked: string[] = [];
    const a = api(store, asked);
    // No starting songs, no queue, no starred artists — only a listening history.
    await a.handle('POST', '/api/feedback', heard('Nun Else', 'OsamaSon', 'deezer:701'));
    await a.handle('POST', '/api/feedback', heard('Spin', 'OsamaSon', 'deezer:702'));
    expect(((await a.handle('GET', '/api/seeds')).body as { seeds: unknown[] }).seeds).toEqual([]);

    const out = await run(a);
    expect(out.status).toBe(200);
    const items = (out.body['items'] ?? []) as { track: { artists: string[] } }[];
    expect(items.length).toBeGreaterThan(0);
    expect(asked.some((p) => p.startsWith('/search/artist') && /osamason/i.test(p))).toBe(true);
    expect(asked.some((p) => /^\/artist\/7\/(top|radio)/.test(p))).toBe(true);
    expect(String(out.body['started_from'] ?? '')).toMatch(/your listening/i);
  });

  it('a starred artist still leads, with no starting song anywhere', { timeout: 120_000 }, async () => {
    const store = await Store.open(new MemoryBackend());
    const a = api(store);
    await a.handle('POST', '/api/fav-artists', { op: 'add', artist: { name: 'Summrs' } });
    const out = await run(a);
    expect(out.status).toBe(200);
    expect(((out.body['items'] ?? []) as unknown[]).length).toBeGreaterThan(0);
    expect(String(out.body['started_from'] ?? '')).toMatch(/your starred artists: Summrs/);
  });

  it('tells a brand-new listener what to do instead of refusing silently', async () => {
    const a = api(await Store.open(new MemoryBackend()));
    const out = await run(a);
    expect(out.status).toBe(400);
    expect(String((out.body as { error?: string }).error ?? out.body['detail'] ?? '')).toMatch(/Nothing to go on yet/);
  });
});
