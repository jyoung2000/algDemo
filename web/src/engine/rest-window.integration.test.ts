/**
 * WP8 / D1 through the whole local API: a manual "Find my next favorite" run rests the songs heard in the last
 * thirty days (a starred song fourteen), and offers them again after that. Automatic top-ups keep their own rule
 * (a song heard is never re-offered), which queue-data-flow.integration.test.ts covers.
 *
 * With nothing heard, a manual run from Seedy Song 1100 queues Seedy Song 1151 and 1152 (measured).
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

type Dict = Record<string, unknown>;

const enc = (s: string) => new TextEncoder().encode(s);
const SEEDY = { id: 11, name: 'Seedy' };
const STARS = [21, 22, 23, 24].map((id) => ({ id, name: `Starry ${id}` }));
const LEARNED = { id: 31, name: 'Learned' };
const ALL = [SEEDY, ...STARS, LEARNED];
const dzTrack = (n: number, a: { id: number; name: string }) => ({
  id: n, title: `${a.name} Song ${n}`, duration: 170, artist: { id: a.id, name: a.name },
  album: { id: n * 3, title: `${a.name} Album ${n}`, cover_medium: 'c' },
  preview: `https://p/${n}.mp3`, readable: true, rank: 500000, link: `https://www.deezer.com/track/${n}`,
});
const SEED = { key: 'deezer:1100', id: 'deezer:1100', provider: 'deezer', platform_id: '1100', title: 'Seedy Song 1100', artists: ['Seedy'], artist: 'Seedy', duration: 170 };

/** A small Deezer: every artist has three top songs and three radio songs, and nobody is related to anybody. */
function fakeDeezer(asked: string[], metered: boolean, pad = 0) {
  const filler = pad ? 'x'.repeat(pad) : '';
  const json = (o: object) => ({ status: 200, headers: {}, body: enc(JSON.stringify(filler ? { ...o, filler } : o)), metered });
  return {
    metered: async () => metered,
    async request(req: { url: string }) {
      const u = new URL(req.url);
      if (u.host !== 'api.deezer.com') return { status: 404, headers: {}, body: enc('{}'), metered };
      asked.push(u.pathname + u.search);
      if (u.pathname === '/search/artist') {
        const a = ALL.find((x) => x.name.toLowerCase() === (u.searchParams.get('q') ?? '').toLowerCase());
        return json({ data: a ? [{ id: a.id, name: a.name, nb_fan: 20000 }] : [] });
      }
      const tr = /^\/track\/(\d+)$/.exec(u.pathname);
      if (tr) {
        const a = ALL.find((x) => x.id === Math.floor(Number(tr[1]) / 100));
        return json(a ? dzTrack(Number(tr[1]), a) : { data: [] });
      }
      const al = /^\/album\/(\d+)$/.exec(u.pathname);
      if (al) return json({ id: Number(al[1]), title: 'Album', genres: { data: [] }, tracks: { data: [] } });
      const m = /^\/artist\/(\d+)(?:\/(\w+))?$/.exec(u.pathname);
      if (m) {
        const a = ALL.find((x) => x.id === Number(m[1]));
        if (!a) return json({ data: [] });
        if (!m[2]) return json({ id: a.id, name: a.name, nb_fan: 20000 });
        if (m[2] === 'top' || m[2] === 'radio') return json({ data: [1, 2, 3].map((i) => dzTrack(a.id * 100 + i + (m[2] === 'radio' ? 50 : 0), a)) });
        return json({ data: [] });
      }
      return json({ data: [] });
    },
  };
}


const DAY = 86_400;
const seedySong = (n: number) => ({ key: `seedy|seedy song ${n}|`, title: `Seedy Song ${n}`, artists: ['Seedy'], artist: 'Seedy' });

async function manualRun(feedback: (store: Store, now: number) => Promise<void>): Promise<string[]> {
  const store = await Store.open(new MemoryBackend());
  const api = new LocalApi({ store, port: fakeDeezer([], false) as never, encoder: null, spotifySearch: () => async () => [] });
  await api.handle('PUT', '/api/settings', { mood_queue: false });
  await api.handle('PUT', '/api/seeds', { seeds: [SEED] });
  await feedback(store, Date.now() / 1000);
  const r = (await api.handle('POST', '/api/recommend', {})).body as { job: string };
  for (let i = 0; i < 1200; i++) {
    const st = (await api.handle('GET', `/api/jobs/${r.job}`)).body as { done: boolean; error?: string | null };
    if (st.done) {
      expect(st.error ?? null).toBeNull();
      return ((store.get<Dict>('last_result')?.['items'] ?? []) as { track: Dict }[]).map((x) => String(x.track['title']));
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('the manual run never finished');
}

describe('WP8 / D1: a manual run rests what was heard lately', () => {
  it('heard 29 days ago is left out; heard 31 days ago is offered again', { timeout: 120_000 }, async () => {
    const titles = await manualRun(async (store, now) => {
      await store.addFeedback('e1', seedySong(1151).key, 'complete', 'Seedy', seedySong(1151), 200, now - 29 * DAY);
      await store.addFeedback('e2', seedySong(1152).key, 'complete', 'Seedy', seedySong(1152), 200, now - 31 * DAY);
    });
    expect(titles).not.toContain('Seedy Song 1151');
    expect(titles).toContain('Seedy Song 1152');
  });

  it('a starred song heard 13 days ago is left out; heard 15 days ago it is offered again', { timeout: 120_000 }, async () => {
    const titles = await manualRun(async (store, now) => {
      for (const n of [1151, 1152]) await store.addFeedback(`like${n}`, seedySong(n).key, 'like', 'Seedy', seedySong(n), null, now - 60 * DAY);
      await store.addFeedback('e1', seedySong(1151).key, 'complete', 'Seedy', seedySong(1151), 200, now - 13 * DAY);
      await store.addFeedback('e2', seedySong(1152).key, 'complete', 'Seedy', seedySong(1152), 200, now - 15 * DAY);
    });
    expect(titles).not.toContain('Seedy Song 1151');
    expect(titles).toContain('Seedy Song 1152');
  });
});
