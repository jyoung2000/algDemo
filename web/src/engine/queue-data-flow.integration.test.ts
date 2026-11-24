/**
 * QUEUE-DATA-FLOW-001 (owner, 2026-11-23): "the discovery / recommandation engine doesnt continously find new songs,
 * when on data the song discovery stops after a while and you repeat the same songs which isnt discovring music".
 *
 * Through the whole local API, on mobile data with the allowance reserve spent: the listener hears every song in the
 * queue, the queue tops up, they hear those too, and so on. New songs must keep arriving, from sources the last
 * top-up did not ask, a song already heard must never come back as new, and a top-up must stay small.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { RESERVE_KEY } from './budget';
import { MemoryBackend, Store } from './store';

type Dict = Record<string, unknown>;
type Song = { key: string; title: string; artists: string[] };

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

async function open(opts: { metered?: boolean; pad?: number } = {}) {
  const metered = opts.metered ?? true;
  const store = await Store.open(new MemoryBackend());
  // Mobile data, and the day's allowance is gone: nothing is left in the reserve.
  await store.put(RESERVE_KEY, { level: 0, at: Date.now() / 1000, capacity: 100_000_000, metered });
  const asked: string[] = [];
  const api = new LocalApi({ store, port: fakeDeezer(asked, metered, opts.pad) as never, encoder: null, spotifySearch: () => async () => [] });
  // The listening mood can top up for its own reason (MOOD-DISCOVER-001); off here, so only the heard count decides.
  await api.handle('PUT', '/api/settings', { mood_queue: false });
  await api.handle('PUT', '/api/seeds', { seeds: [SEED] });
  return { api, store, asked };
}

const queue = (store: Store): Song[] => (((store.get<Dict>('last_result')?.['items'] ?? []) as { track: Song }[]).map((x) => x.track));

let listens = 0;
async function hear(api: LocalApi, track: Dict | Song): Promise<string> {
  const id = `complete:${String((track as Dict)['key']).slice(0, 40)}:${++listens}`;
  await api.handle('POST', '/api/feedback', { kind: 'complete', event_id: id, track, listened: 200, duration: 210, coverage: 200, medium: 'full', origin: 'queue' });
  return id;
}

async function topUp(api: LocalApi, eventId: string) {
  const r = (await api.handle('POST', '/api/recommend', { trigger: 'listening', event_id: eventId, exclude: [] })).body as { job: string | null; reason?: string };
  if (!r.job) return { started: false, reason: r.reason, error: null as string | null, result: {} as Dict };
  for (let i = 0; i < 1200; i++) {
    const st = (await api.handle('GET', `/api/jobs/${r.job}`)).body as { done: boolean; error?: string | null; result?: Dict | null };
    if (st.done) return { started: true, reason: undefined, error: st.error ?? null, result: st.result ?? {} };
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('the top-up never finished');
}

/** The listener hears every song in the queue they have not heard (the starting song when it is empty); the last listen tops up. */
async function round(api: LocalApi, store: Store, heard: Set<string>) {
  const before = queue(store);
  const todo = before.filter((t) => !heard.has(t.key));
  let last = '';
  for (const t of todo.length ? todo : [SEED]) {
    last = await hear(api, t);
    heard.add(t.key);
  }
  const out = await topUp(api, last);
  const added = queue(store).filter((t) => !before.some((b) => b.key === t.key));
  return { ...out, added };
}

const total = (transfer: unknown) => Object.values((transfer ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);

describe('on mobile data with the allowance spent, the queue keeps finding new songs', () => {
  it('a queue heard through still tops up (the reserve does not stop it)', { timeout: 120_000 }, async () => {
    const { api, store } = await open();
    const out = await round(api, store, new Set());
    expect(out.reason).toBeUndefined();
    expect(out.error).toBeNull();
    expect(out.added.length).toBeGreaterThan(0);
  });

  it('successive top-ups move on to the starred artists and the artists the listening learned', { timeout: 240_000 }, async () => {
    const { api, store } = await open();
    for (const s of STARS) await api.handle('POST', '/api/fav-artists', { op: 'add', artist: { name: s.name } });
    for (const n of [3190, 3191]) {
      await api.handle('POST', '/api/feedback', { kind: 'like', event_id: `like:${n}`, track: { key: `deezer:${n}`, title: `Learned Song ${n}`, artists: ['Learned'], provider: 'deezer', platform_id: String(n), duration: 170 } });
    }
    const heard = new Set<string>();
    const perRound: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = new Set(heard);
      const out = await round(api, store, heard);
      expect(out.error, `round ${i + 1}`).toBeNull();
      // Nothing that arrives as new was heard before.
      expect(out.added.filter((t) => before.has(t.key) || heard.has(t.key)).map((t) => t.key), `round ${i + 1} re-offered heard songs`).toEqual([]);
      perRound.push(out.added.length);
    }
    // The first three top-ups each bring something: the starting song, then stars, then what the listening learned.
    expect(perRound.slice(0, 3).every((n) => n > 0), `new songs per top-up: ${perRound.join(', ')}`).toBe(true);
    const artists = new Set(queue(store).flatMap((t) => t.artists));
    for (const a of [...STARS, LEARNED]) expect([...artists], `never reached ${a.name}`).toContain(a.name);
  });

  it('a song already heard never comes back as new, even after it left the queue', { timeout: 120_000 }, async () => {
    const { api, store } = await open();
    const heard = new Set<string>();
    const first = await round(api, store, heard);
    expect(first.added.length).toBeGreaterThan(0);
    for (const t of first.added) {
      await hear(api, t);
      heard.add(t.key);
    }
    // The queue is emptied (cleared, or replaced by a saved list and restored): the songs are heard but no longer held.
    await store.put('last_result', { phase: 'final', items: [], count: 0 });
    const again = await topUp(api, await hear(api, SEED));
    expect(again.error).toBeNull();
    expect(queue(store).filter((t) => heard.has(t.key)).map((t) => t.key)).toEqual([]);
  });

  it('says why when nothing new is left, instead of repeating silently', { timeout: 240_000 }, async () => {
    const { api, store } = await open();
    const heard = new Set<string>();
    let dry: Awaited<ReturnType<typeof round>> | null = null;
    for (let i = 0; i < 5 && !dry; i++) {
      const out = await round(api, store, heard);
      expect(out.error).toBeNull();
      if (out.started && !out.added.length) dry = out;
    }
    expect(dry, 'the small catalogue runs out within five top-ups').not.toBeNull();
    const why = String(dry!.result['empty_reason'] ?? '');
    expect(why).toMatch(/already heard/i);
    expect(why).toMatch(/starting song/i);
  });
});

describe('a top-up on mobile data is small', () => {
  // Every answer here is 700 KB, so one run reads well over 10 MB when nothing holds it back.
  it('one run stays under a small ceiling and still finds songs', { timeout: 120_000 }, async () => {
    const { api, store } = await open({ pad: 700_000 });
    const out = await round(api, store, new Set());
    expect(out.error).toBeNull();
    expect(out.added.length).toBeGreaterThan(0);
    expect(total(out.result['transfer'])).toBeLessThanOrEqual(7_500_000);
  });

  it('on Wi-Fi the same run is not held to it', { timeout: 120_000 }, async () => {
    const { api, store } = await open({ pad: 700_000, metered: false });
    const out = await round(api, store, new Set());
    expect(out.error).toBeNull();
    expect(out.added.length).toBeGreaterThan(0);
    expect(total(out.result['transfer'])).toBeGreaterThan(7_500_000);
  });
});

// ARTIST-VARIETY-001 (owner, 2026-11-24): "only kept getting slayr music". Every top-up took up to two songs from the
// artist just heard, on top of the ones already waiting, so one artist piled up in the queue.
describe('top-ups do not pile one artist up in the queue', () => {
  it('songs by one artist still waiting stay at two or fewer, top-up after top-up', { timeout: 240_000 }, async () => {
    const { api, store } = await open({ metered: false });
    await api.handle('PUT', '/api/settings', { queue_size: 6 });
    for (const s of STARS) await api.handle('POST', '/api/fav-artists', { op: 'add', artist: { name: s.name } });
    const heard = new Set<string>();
    const waitingBy = (artist: string) => queue(store).filter((t) => !heard.has(t.key) && t.artists[0] === artist).length;
    let topUps = 0;
    for (let i = 0; i < 6; i++) {
      // The listener hears one song by Seedy (or the starting song), the rest of the queue waits.
      const next = queue(store).find((t) => !heard.has(t.key) && t.artists[0] === 'Seedy') ?? SEED;
      const id = await hear(api, next);
      heard.add(next.key);
      const out = await topUp(api, id);
      if (out.started) topUps++;
      expect(out.error).toBeNull();
      expect(waitingBy('Seedy'), `after listen ${i + 1}: ${queue(store).filter((t) => !heard.has(t.key)).map((t) => t.artists[0]).join(', ')}`).toBeLessThanOrEqual(2);
    }
    expect(topUps).toBeGreaterThan(1);
  });
});
