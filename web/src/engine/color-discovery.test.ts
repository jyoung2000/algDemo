/**
 * COLOR-DISCOVERY-001. Owner: "Ensure the recommendation engine can keep recommeding new songs and
 * music based on the users color algoritim".
 *
 * Every source the gather step asks hangs off a starting song - YouTube Music's radio for it,
 * Deezer's artist radio, the seed's own stated genres. Those pools are finite and deterministic, so
 * a second run on the same starting songs returns "No new songs this time. Your list is unchanged."
 * and discovery stops dead. The listener's colours (the taste profile the Sound card draws) were
 * only ever used to SCORE what the seeds turned up - never to ask for anything.
 *
 * So the colours themselves become a source: the strongest colours name their picker cells, each
 * cell names real reference artists, and a cursor walks further through them on every run, so there
 * is always something new to ask for. What the listener avoids is never asked for, and a listener
 * with no colours yet asks nothing - nothing is invented.
 */
import { describe, expect, it } from 'vitest';
import { tasteAsks, TASTE_RELATION } from './taste-gather';
import * as E from './engine';
import { DEFAULT_ENGINE } from './config';
import { Deezer } from './deezer';
import { Http, HostPacer, type HttpPort, type HttpRequest } from './net';
import { Job, Pipeline } from './pipeline';
import { MemoryBackend, Store } from './store';
import { LocalApi } from './local-api';

const colour = (name: string, score: number, label = name) => ({ name, label, score, plays: Math.max(1, Math.round(score)), skips: 0 });
const RAGE = colour('rage', 4, 'Rage');
const PLUGG = colour('plugg', 2, 'Plugg / pluggnb');

describe('the colours themselves are a source of new music (COLOR-DISCOVERY-001)', () => {
  it('asks for the artists its strongest colour names', () => {
    const asks = tasteAsks([RAGE], 0, 4);
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((a) => a.genre === 'rage')).toBe(true);
    // Rage in the picker is Playboi Carti / Ken Carson / Yeat - real names, not invented ones.
    expect(asks.some((a) => /carti|ken carson|yeat/i.test(a.term))).toBe(true);
    expect(asks[0]!.label).toBe('Rage');
  });

  it('gives the stronger colour more of the asks', () => {
    const asks = tasteAsks([RAGE, PLUGG], 0, 6);
    const rage = asks.filter((a) => a.genre === 'rage').length;
    const plugg = asks.filter((a) => a.genre === 'plugg').length;
    expect(rage).toBeGreaterThan(plugg);
    expect(plugg).toBeGreaterThan(0);
  });

  it('never asks for what the listener skips away from', () => {
    const asks = tasteAsks([RAGE, colour('metalcore', -3, 'Metalcore / deathcore')], 0, 6);
    expect(asks.some((a) => a.genre === 'metalcore')).toBe(false);
  });

  it('asks nothing when the listener has no colours yet', () => {
    expect(tasteAsks([], 0, 6)).toEqual([]);
    expect(tasteAsks([colour('rage', 0.01)], 0, 6)).toEqual([]);
  });

  it('keeps finding something new to ask: twenty runs never repeat an ask', () => {
    // An ask is a term AND how deep into it to read, because page two of an artist's catalogue is
    // music page one did not have. Repeating "Ken Carson, page 0" is what must never happen.
    const seen = new Set<string>();
    let cursor = 0;
    for (let run = 0; run < 20; run++) {
      const asks = tasteAsks([RAGE, PLUGG], cursor, 4);
      expect(asks.length).toBeGreaterThan(0);
      for (const a of asks) {
        const id = `${a.term}#${a.page}`;
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      cursor = asks[0]!.nextCursor;
    }
    expect(seen.size).toBeGreaterThanOrEqual(60);
  });

  it('names a colour the way its bubble does, not as a service spells it (TAGS-CANON-001)', () => {
    // 'soul' off a service reads "Your sound leans soul" without this; a bubble would say Soul.
    expect(tasteAsks([colour('soul', 4, 'soul')], 0, 2)[0]!.label).toBe('Soul');
    expect(tasteAsks([colour('rnb', 4, 'rnb')], 0, 2)[0]!.label).toBe('R&B');
    expect(tasteAsks([RAGE], 0, 2)[0]!.label).toBe('Rage');
  });

  it('names a colour the catalogue does not know by its own words rather than nothing', () => {
    const asks = tasteAsks([colour('hip-hop', 4, 'Hip-hop')], 0, 3);
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((a) => a.genre === 'hip-hop')).toBe(true);
  });
});

describe('the colours widen as well as deepen (COLOR-DISCOVERY-001)', () => {
  it('follows the artists each colour names out to the artists beside them', async () => {
    const { tasteWideAsk } = await import('./taste-gather');
    // After the cell's own three artists have been walked, the next runs go a step out: the artists
    // the service puts beside them. Three names would otherwise fade away after a handful of runs.
    const seen = new Set<string>();
    for (let run = 0; run < 12; run++) {
      const wide = tasteWideAsk([RAGE, PLUGG], run);
      expect(wide).toBeTruthy();
      seen.add(`${wide!.term}#${wide!.depth}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
    expect([...seen].some((s) => /#1$|#2$/.test(s))).toBe(true);
  });

  it('asks nothing wide for a listener with no colours', async () => {
    const { tasteWideAsk } = await import('./taste-gather');
    expect(tasteWideAsk([], 0)).toBeNull();
  });
});

describe('gather asks the colour sources and says where they came from (COLOR-DISCOVERY-001)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dzTrack = (id: number, title: string, artist: string) => ({
    id, title, duration: 170, artist: { id: id * 7, name: artist }, album: { id: id * 3, title: `${title} - Single`, cover_medium: 'c' },
    preview: `https://p/${id}.mp3`, readable: true, rank: 500000,
  });

  async function gather(colours: { name: string; label: string; score: number; plays: number; skips: number }[], cursor = 0) {
    const asked: string[] = [];
    const port: HttpPort = {
      async request(req: HttpRequest) {
        asked.push(req.url);
        const u = new URL(req.url);
        if (u.host === 'api.deezer.com' && u.pathname === '/search') {
          const q = u.searchParams.get('q') ?? '';
          const page = Number(u.searchParams.get('index') ?? 0);
          return { status: 200, headers: {}, body: enc(JSON.stringify({ data: [dzTrack(1000 + page, `Song ${q} ${page}`, 'Ken Carson')] })) };
        }
        return { status: 404, headers: {}, body: enc('{}') };
      },
    };
    const http = new Http(port, new HostPacer({}, 0));
    const store = await Store.open(new MemoryBackend());
    const dz = new Deezer(http, store);
    const p = new Pipeline(store, http, dz, null as never, null as never, { search: async () => [] } as never, null, null);
    // A starting song whose own sources are all exhausted: no YouTube Music id, no Deezer artist.
    const seed = { key: 'ken carson|green room', title: 'Green Room', artists: ['Ken Carson'], provider: 'local', platform_id: '' };
    const profiles = { [seed.key]: { dz: null, ytm_vid: null, dz_uncertain: [] } };
    const job = new Job('t');
    job.meter = p.meter({});
    const out = await p.gather(job, [seed], profiles, DEFAULT_ENGINE, false, undefined, new Set(), { colours, cursor });
    return { out, asked };
  }

  it('finds new songs from the colours when every source of the starting song is spent', async () => {
    const { out, asked } = await gather([RAGE, PLUGG]);
    expect(asked.some((u) => u.includes('/search'))).toBe(true);
    expect(out.cands.length).toBeGreaterThan(0);
    const prov = out.cands.flatMap((c) => (c['provenance'] as E.Provenance[]) ?? []);
    expect(prov.some((p) => p.relation === TASTE_RELATION)).toBe(true);
    expect(prov.find((p) => p.relation === TASTE_RELATION)?.via).toBeTruthy();
  });

  it('asks nothing extra for a listener with no colours', async () => {
    const { asked } = await gather([]);
    expect(asked.some((u) => u.includes('/search'))).toBe(false);
  });

  it('says in plain words that a colour found it, and counts as exploration not relatedness', () => {
    expect(E.RELATION[TASTE_RELATION]).toBeTruthy();
    expect(E.RELATION[TASTE_RELATION]![0]).toBe(0);
    expect(E.RELATION[TASTE_RELATION]![2]).toBe(false);
    expect(E.EXPLORATION_RELATIONS.has(TASTE_RELATION)).toBe(true);
    expect(E.RELATION[TASTE_RELATION]![1]).toMatch(/sound|colour|color/i);
  });
});

/**
 * The whole way through: two runs on one starting song whose own sources answer once and are then
 * spent. Run one fills the queue, run two must still bring new songs - from the colours.
 */
describe('a second run still brings new songs (COLOR-DISCOVERY-001)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dzTrack = (id: number, title: string, artist = 'Ken Carson') => ({
    id, title, duration: 170, artist: { id: 42, name: artist }, album: { id: id * 3, title: `${title} - Single`, cover_medium: 'c' },
    preview: `https://p/${id}.mp3`, readable: true, rank: 500000, link: `https://www.deezer.com/track/${id}`,
  });

  it('keeps growing the queue from the colours after the starting song has nothing left', { timeout: 120_000 }, async () => {
    let searches = 0;
    const port = {
      async request(req: { url: string }) {
        const u = new URL(req.url);
        const json = (o: unknown) => ({ status: 200, headers: {}, body: enc(JSON.stringify(o)) });
        if (u.host === 'api.deezer.com' && u.pathname === '/search') {
          searches += 1;
          const q = u.searchParams.get('q') ?? '';
          const index = Number(u.searchParams.get('index') ?? 0);
          // One answer per distinct ask: a song of its own, by an artist of its own, so the queue's
          // per-artist cap is not what is being measured here.
          return json({ data: [dzTrack(5000 + searches, `Found ${q} ${index}`, `Artist ${searches}`)] });
        }
        if (u.host === 'api.deezer.com' && u.pathname.startsWith('/artist/')) return json({ data: [] });
        return { status: 404, headers: {}, body: enc('{}') };
      },
    };
    const store = await Store.open(new MemoryBackend());
    const api = new LocalApi({ store, port: port as never, encoder: null, spotifySearch: () => async () => [] });
    // A listener whose colours are known: three finished Rage songs.
    const tags = [{ name: 'rage', label: 'Rage', source: 'test', scope: 'track', confidence: 0.9, inferred: false }];
    const now = Math.floor(Date.now() / 1000);
    for (const t of ['Green Room', 'Singapore', 'Paranoid']) {
      const r = await api.handle('POST', '/api/feedback', {
        event_id: `complete:${t}`, kind: 'complete', ts: now - 600, listened: 170, duration: 170, medium: 'full',
        track: { key: `ken carson|${t.toLowerCase()}`, title: t, artists: ['Ken Carson'], tags, bpm: 150 },
      });
      expect(r.status).toBe(200);
    }
    const prof = (await api.handle('GET', '/api/profile')).body as Record<string, unknown>;
    const colours = ((prof['taste'] ?? {}) as Record<string, unknown>)['genres'] as unknown[] | undefined;
    expect(colours?.length ?? 0).toBeGreaterThan(0);

    const put = await api.handle('PUT', '/api/seeds', { seeds: [{ key: 'ken carson|green room', title: 'Green Room', artists: ['Ken Carson'], provider: 'local', platform_id: '1' }] });
    expect(put.status).toBe(200);
    const run = async () => {
      const started = (await api.handle('POST', '/api/recommend', {})).body as Record<string, unknown>;
      const id = String(started['job'] ?? '');
      expect(id).toBeTruthy();
      for (let i = 0; i < 200; i++) {
        const st = (await api.handle('GET', `/api/jobs/${id}`)).body as Record<string, unknown>;
        if (st['done']) return (st['result'] ?? {}) as Record<string, unknown>;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('discovery never finished');
    };
    const first = await run();
    expect(Number((first['timings'] as Record<string, number>)?.['taste_colours'] ?? 0)).toBeGreaterThan(0);
    const firstKeys = new Set(((first['items'] ?? []) as { track: { key: string } }[]).map((x) => x.track.key));
    expect(firstKeys.size).toBeGreaterThan(0);
    const second = await run();
    const secondItems = (second['items'] ?? []) as { track: { key: string }; why?: unknown }[];
    const added = secondItems.filter((x) => !firstKeys.has(x.track.key));
    expect(added.length).toBeGreaterThanOrEqual(3);
    // A third run too: this must not be a one-off top-up.
    const beforeThird = new Set(secondItems.map((x) => x.track.key));
    const third = await run();
    const addedThird = ((third['items'] ?? []) as { track: { key: string } }[]).filter((x) => !beforeThird.has(x.track.key));
    expect(addedThird.length).toBeGreaterThanOrEqual(3);
    expect(Number(store.get('taste_cursor') ?? 0)).toBeGreaterThanOrEqual(2);
  });
});

describe('the reason tells the truth about where a colour-found song came from (COLOR-DISCOVERY-001)', () => {
  it('says the listener\u2019s sound asked for it, not that Deezer charted it', () => {
    const track = {
      key: 'artist 1|found', title: 'Found', artists: ['Artist 1'], album: null, bpm: null, release: null,
      tags: [{ name: 'rage', label: 'Rage', source: 'test', scope: 'track', confidence: 0.8, inferred: false }],
      provenance: [{ seed: 'ken carson|green room', relation: TASTE_RELATION, rank: 0, source: 'taste-artist', via: 'Rage' }],
    } as unknown as E.Track;
    const ctx = {
      seeds: [{ key: 'ken carson|green room', title: 'Green Room', artists: ['Ken Carson'], tags: [], provenance: [], release: null, bpm: null }],
      vectors: new Map(), relatedArtists: new Map(), feedback: E.buildFeedback2([], 1_700_000_000), impressions: {},
      settings: { adventurous: 0.8, fresh: false, vocals: 'any' }, now: new Date(1_700_000_000_000), cfg: DEFAULT_ENGINE, rankV2: true,
    } as unknown as E.Context;
    const [reasons] = E.explain(E.scoreOne(track, ctx), ctx);
    const text = reasons.map((r) => r.text).join(' ');
    expect(text).not.toMatch(/genre chart|Deezer\u2019s Rage chart|Deezer's Rage chart/i);
    expect(text).toMatch(/your sound|Your sound/);
    expect(text).toMatch(/Rage/);
  });
});
