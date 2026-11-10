/**
 * ALBUM-TASTE-001. Owner: "have the users album music listening taste affect their algorithm".
 * Playing several songs from one album is a signal about that album, beyond the artist: the rest of it
 * is lifted in the queue, the reason says so, and a starting song from that album brings the album's
 * other songs into the pool. Skipping through an album lowers it the same way. One song from an album
 * says nothing about the album (it is the artist's signal), and stored events without a track are
 * untouched, so the golden queues and the v1 ranker do not move.
 */
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import { DEFAULT_ENGINE } from './config';
import { albumKeyOf } from './albums';
import { Deezer } from './deezer';
import { Http, HostPacer, type HttpPort, type HttpRequest } from './net';
import { Job, Pipeline } from './pipeline';
import { MemoryBackend, Store } from './store';

const NOW_TS = Math.floor(new Date('2026-11-10T12:00:00Z').getTime() / 1000);
const KEN = 'ken carson';
const song = (title: string, album: string) => ({ title, album, artists: ['Ken Carson'] });
let n = 0;
const ev = (kind: string, title: string, album: string, over: Partial<E.FeedbackEvent> = {}): E.FeedbackEvent => ({
  event_id: `${kind}:${title}:${n++}`, key: `${KEN}|${title.toLowerCase()}`, kind, artist: KEN, ts: NOW_TS - 3600,
  listened: 180, duration: 180, medium: 'full', track: song(title, album), ...over,
});
const cand = (title: string, album: string): E.Track => ({
  key: `${KEN}|${title.toLowerCase()}`, title, artists: ['Ken Carson'], album, tags: [], provenance: [], release: null, bpm: null,
});
const CHAOS = albumKeyOf(song('x', 'A Great Chaos'))!;

describe('album taste from listening (ALBUM-TASTE-001)', () => {
  it('counts an album once several of its songs are played, with diminishing returns', () => {
    const two = E.buildFeedback2([ev('complete', 'Green Room', 'A Great Chaos'), ev('complete', 'Singapore', 'A Great Chaos')], NOW_TS);
    const four = E.buildFeedback2(['Green Room', 'Singapore', 'Paranoid', 'Like This'].map((t) => ev('complete', t, 'A Great Chaos')), NOW_TS);
    expect(two.album?.[CHAOS]).toBeGreaterThan(0);
    expect(four.album![CHAOS]!).toBeGreaterThan(two.album![CHAOS]!);
    expect(four.album![CHAOS]!).toBeLessThan(2 * two.album![CHAOS]!);
    expect(four.albumNames?.[CHAOS]).toBe('A Great Chaos');
  });

  it('does not count an album from a single song, a single, or events with no track', () => {
    const one = E.buildFeedback2([ev('complete', 'Green Room', 'A Great Chaos'), ev('replay', 'Green Room', 'A Great Chaos')], NOW_TS);
    expect(one.album?.[CHAOS]).toBeUndefined();
    const singles = E.buildFeedback2([ev('complete', 'Rock N Roll', 'Rock N Roll'), ev('complete', 'Other', 'Other - Single')], NOW_TS);
    expect(Object.keys(singles.album ?? {})).toEqual([]);
    const bare = E.buildFeedback2([ev('complete', 'A', 'X', { track: undefined }), ev('complete', 'B', 'X', { track: undefined })], NOW_TS);
    expect(Object.keys(bare.album ?? {})).toEqual([]);
    // The v1 ranker is the golden oracle's: it never reads albums.
    expect(E.buildFeedback(['Green Room', 'Singapore'].map((t) => ev('complete', t, 'A Great Chaos')), NOW_TS).album).toBeUndefined();
  });

  it('lowers an album whose songs keep being skipped', () => {
    const fb = E.buildFeedback2(['Green Room', 'Singapore', 'Paranoid'].map((t) => ev('skip', t, 'A Great Chaos', { listened: 8 })), NOW_TS);
    expect(fb.album![CHAOS]!).toBeLessThan(0);
  });

  it('lifts an unheard song from the album above a song by the same artist from another album', () => {
    const fb = E.buildFeedback2(['Green Room', 'Singapore', 'Paranoid'].map((t) => ev('complete', t, 'A Great Chaos')), NOW_TS);
    const sameAlbum = E.feedbackFit(cand('Jennifer\u2019s Body', 'A Great Chaos'), fb)!;
    const otherAlbum = E.feedbackFit(cand('Fashion Killer', 'X'), fb)!;
    expect(sameAlbum).toBeGreaterThan(otherAlbum);
  });

  it('drops a skipped-through album below the same artist\u2019s other albums', () => {
    const fb = E.buildFeedback2([
      ...['Green Room', 'Singapore', 'Paranoid'].map((t) => ev('skip', t, 'A Great Chaos', { listened: 8 })),
      ev('like', 'Yale', 'Project X'),
    ], NOW_TS);
    expect(E.feedbackFit(cand('Jennifer\u2019s Body', 'A Great Chaos'), fb)!).toBeLessThan(E.feedbackFit(cand('Rock N Roll 2', 'Project X 2'), fb)!);
  });

  it('says why: the album the listener keeps playing', () => {
    const fb = E.buildFeedback2(['Green Room', 'Singapore', 'Paranoid'].map((t) => ev('complete', t, 'A Great Chaos')), NOW_TS);
    const c = cand('Jennifer\u2019s Body', 'A Great Chaos');
    const ctx: E.Context = {
      seeds: [cand('Seed', 'Somewhere')], vectors: new Map(), relatedArtists: new Map(), feedback: fb, impressions: {},
      settings: { adventurous: 0.5, fresh: false, vocals: 'any' } as never, now: new Date(NOW_TS * 1000), cfg: DEFAULT_ENGINE, rankV2: true,
    } as E.Context;
    const s = E.scoreOne(c, ctx);
    const [reasons] = E.explain(s, ctx);
    expect(reasons.map((r) => r.text).join(' ')).toMatch(/You keep playing the album A Great Chaos/);
  });
});

describe('an album the listener is into brings its other songs into the pool (ALBUM-TASTE-001)', () => {
  const DZ_ALBUM = {
    id: 498395131, title: 'A Great Chaos', cover_medium: 'c', release_date: '2023-10-13', genres: { data: [{ name: 'Rap/Hip Hop' }] }, record_type: 'album',
    tracks: { data: [
      { id: 11, title: 'Green Room', duration: 188, artist: { id: 1, name: 'Ken Carson' }, readable: true },
      { id: 12, title: 'Jennifer\u2019s Body', duration: 150, artist: { id: 1, name: 'Ken Carson' }, readable: true },
    ] },
  };
  const enc = (s: string) => new TextEncoder().encode(s);

  async function gather(deep: Set<string>) {
    const asked: string[] = [];
    const port: HttpPort = {
      async request(req: HttpRequest) {
        asked.push(req.url);
        const u = new URL(req.url);
        if (u.host === 'api.deezer.com' && u.pathname === '/album/498395131') return { status: 200, headers: {}, body: enc(JSON.stringify(DZ_ALBUM)) };
        return { status: 404, headers: {}, body: enc('{}') };
      },
    };
    const http = new Http(port, new HostPacer({}, 0));
    const store = await Store.open(new MemoryBackend());
    const dz = new Deezer(http, store);
    const p = new Pipeline(store, http, dz, null as never, null as never, { search: async () => [] } as never, null, null);
    const seed = { key: `${KEN}|green room`, title: 'Green Room', artists: ['Ken Carson'], provider: 'deezer', platform_id: '11' };
    const profiles = { [seed.key]: { dz: { ...seed, album: 'A Great Chaos', album_id: '498395131' }, ytm_vid: null, dz_uncertain: [] } };
    const job = new Job('t');
    job.meter = p.meter({});
    const out = await p.gather(job, [seed], profiles, DEFAULT_ENGINE, false, undefined, deep);
    return { out, asked };
  }

  it('adds the album\u2019s songs, tagged as from the same album as the starting song', async () => {
    const { out } = await gather(new Set([CHAOS]));
    const jb = out.cands.find((c) => c['title'] === 'Jennifer\u2019s Body');
    expect(jb).toBeTruthy();
    expect((jb!['provenance'] as E.Provenance[]).map((p) => p.relation)).toContain('same_album');
    expect(E.RELATION['same_album']![2]).toBe(true);
  });

  it('asks nothing extra for an album the listener has not shown interest in', async () => {
    const { asked } = await gather(new Set());
    expect(asked.some((u) => u.includes('/album/'))).toBe(false);
  });
});
