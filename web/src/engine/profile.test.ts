/** The "Your profile" snapshot: counts, learned taste, feedback scores, weights and the last run. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINE } from './config';
import { buildProfile, type ProfileEventRow } from './profile';

const NOW_TS = 1_793_000_000;
const tag = (name: string) => ({ name, label: name.replace(/\b\w/g, (c) => c.toUpperCase()), confidence: 0.9 });
const song = (key: string, artist: string, genre: string, bpm: number) => ({ key, title: `T ${key}`, artists: [artist], tags: [tag(genre)], bpm, artwork: `https://img.example/${key}.jpg` });

let n = 0;
function ev(kind: string, t: ReturnType<typeof song>, agoMin: number, listened: number | null = null): ProfileEventRow {
  return { event_id: `${kind}:${t.key}:${n++}`, key: t.key, kind, artist: t.artists[0]!.toLowerCase(), track: t, listened, ts: NOW_TS - agoMin * 60 };
}

const a = song('a', 'Kendrick', 'hip hop', 90);
const b = song('b', 'Drake', 'hip hop', 94);
const c = song('c', 'Slayer', 'metal', 180);

function base(over: Partial<Parameters<typeof buildProfile>[0]> = {}) {
  return buildProfile({
    events: [ev('complete', a, 30, 210), ev('complete', b, 20, 190), ev('skip', c, 10, 6), ev('like', a, 5)],
    seeds: [{ key: 's1', title: 'HUMBLE.', artists: ['Kendrick Lamar'], bpm: 150, tags: [tag('rap')] }],
    settings: { adventurous: 0.5, fresh: false, queue_size: 12 },
    impressions: { a: 2, b: 1 },
    lastResult: null,
    poolSize: null,
    vectors: 7,
    nowTs: NOW_TS,
    ...over,
  });
}

describe('profile snapshot', () => {
  it('counts what was tracked', () => {
    const p = base();
    expect(p['tracked']).toMatchObject({ events: 4, plays: 3, listened_sec: 406, songs_played: 3, artists: 3, vectors: 7 });
    expect(p['tracked'].counts).toEqual({ complete: 2, skip: 1, like: 1 });
    expect(p['tracked'].impressions).toMatchObject({ shown: 3, songs: 2 });
    expect(p['seeds'][0]).toMatchObject({ title: 'HUMBLE.', artist: 'Kendrick Lamar', bpm: 150, genres: ['Rap'] });
    expect(p['recent'][0]).toMatchObject({ kind: 'like', title: 'T a' }); // newest first
  });

  it('shows the learned taste: liked genre first, avoided genre last, kept tempo', () => {
    const p = base();
    const g = p['taste'].genres as { name: string; score: number }[];
    expect(g[0]!.name).toBe('hip hop');
    expect(g[0]!.score).toBeGreaterThan(0);
    expect(g[g.length - 1]!.name).toBe('metal');
    expect(g[g.length - 1]!.score).toBeLessThan(0);
    expect(p['taste'].bpm).toBeGreaterThanOrEqual(90);
    expect(p['taste'].bpm).toBeLessThanOrEqual(94);
    expect(p['taste'].skip_bpm).toBe(180);
  });

  it('lists feedback scores per song and artist', () => {
    const p = base();
    const songs = p['songs'] as { key: string; score: number }[];
    expect(songs[0]!.key).toBe('a'); // complete + like is the strongest
    expect(songs.find((s) => s.key === 'c')!.score).toBeLessThan(0);
    // one skip never colours an artist
    expect((p['artists'] as { name: string }[]).some((x) => x.name === 'slayer')).toBe(false);
  });

  it('reports the weights the slider produces, shares summing to 1 without taste', () => {
    const fam = base({ settings: { adventurous: 0, fresh: false } });
    const adv = base({ settings: { adventurous: 1, fresh: true } });
    const w = (p: Record<string, any>, f: string) => (p['algorithm'].weights as { factor: string; effective: number; share: number }[]).find((x) => x.factor === f)!; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(w(adv, 'novelty').effective).toBeGreaterThan(w(fam, 'novelty').effective);
    expect(w(adv, 'freshness').effective).toBeCloseTo(DEFAULT_ENGINE.weights.freshness * 5, 5);
    const shares = (fam['algorithm'].weights as { factor: string; share: number }[]).filter((x) => x.factor !== 'taste').reduce((s, x) => s + x.share, 0);
    expect(shares).toBeCloseTo(1, 2);
    expect(fam['algorithm'].tiers.strong).toBeGreaterThan(adv['algorithm'].tiers.strong);
    expect(fam['algorithm'].settings.queue_size).toBe(DEFAULT_ENGINE.queueSize);
  });

  it('summarises the last run', () => {
    const p = base({
      lastResult: {
        saved_at: NOW_TS - 60,
        asked: 12,
        candidates: 140,
        items: [
          { score: 0.8, tier: 'strong', evidence: 'strong', factors: { audio: 0.9, genre: 0.5, novelty: 0 } },
          { score: 0.6, tier: 'related', evidence: 'moderate', factors: { audio: 0.7, genre: null, novelty: 1 } },
          { score: 0.4, tier: 'emerging', evidence: 'thin', factors: { genre: 0.3, novelty: 1 } },
        ],
        sources: { deezer: { state: 'ok', count: 80 } },
        audio: { embedded: 5 },
        timings: { total_ms: 9000 },
        transfer: { previews: 1_000_000 },
      },
      poolSize: 140,
    });
    const r = p['last_run'];
    expect(r).toMatchObject({ songs: 3, asked: 12, candidates: 140, pool: 140, tiers: { strong: 1, related: 1, emerging: 1 } });
    expect(r.score).toEqual({ top: 0.8, median: 0.6, low: 0.4 });
    const audio = (r.factors as { factor: string; mean: number; known: number }[]).find((f) => f.factor === 'audio')!;
    expect(audio).toMatchObject({ mean: 0.8, known: 2 });
    expect(r.sources[0]).toMatchObject({ name: 'deezer', state: 'ok', count: 80 });
  });

  it('is empty but valid with nothing recorded', () => {
    const p = buildProfile({ events: [], seeds: [], settings: {}, impressions: {}, lastResult: null, poolSize: null, vectors: 0, nowTs: NOW_TS });
    expect(p['tracked'].events).toBe(0);
    expect(p['taste'].genres).toEqual([]);
    expect(p['last_run']).toBeNull();
    expect((p['algorithm'].weights as { factor: string; effective: number }[]).find((x) => x.factor === 'taste')!.effective).toBe(0);
  });

  it('lists the last ten songs played, newest first, with their tempo and genres', () => {
    const many: ProfileEventRow[] = [];
    for (let i = 0; i < 12; i++) many.push(ev('complete', song(`p${i}`, `Artist ${i}`, 'techno', 120 + i), 60 - i));
    many.push(ev('like', a, 1)); // a like is not a play
    const p = base({ events: many });
    const played = p['played'] as { key: string; bpm: number | null; genres: string[]; kind: string }[];
    expect(played).toHaveLength(10);
    expect(played[0]).toMatchObject({ key: 'p11', kind: 'complete', bpm: 131, genres: ['Techno'], artwork: 'https://img.example/p11.jpg' });
    expect(played.map((x) => x.key)).toEqual(Array.from({ length: 10 }, (_, i) => `p${11 - i}`));
  });

  it('describes the scoring formula with the same weights the engine applies', () => {
    const p = base();
    const f = p['formula'] as { affinity: { factors: { factor: string; weight: number }[] }; taste: { weight: number }; coverage: { floor: number } };
    expect(f.affinity.factors.map((x) => x.factor)).toEqual(['audio', 'genre', 'artist', 'provider', 'feedback', 'tempo']);
    expect(f.taste.weight).toBe(0.15);
    expect(f.coverage.floor).toBe(DEFAULT_ENGINE.coverageFloor);
  });
});

describe('album taste in the profile (ALBUM-TASTE-001)', () => {
  it('lists the albums the listener keeps playing, with the album and artist names', () => {
    const onAlbum = (key: string, title: string) => ({ ...song(key, 'Ken Carson', 'rap', 140), title, album: 'A Great Chaos' });
    const p = base({ events: [ev('complete', onAlbum('g', 'Green Room'), 30, 188), ev('complete', onAlbum('s', 'Singapore'), 25, 170), ev('complete', a, 20, 200)] });
    expect(p['albums']).toEqual([{ key: 'ken carson|a great chaos', name: 'A Great Chaos', artist: 'Ken Carson', score: expect.any(Number) }]);
    expect((p['albums'] as { score: number }[])[0]!.score).toBeGreaterThan(0);
    expect(base()['albums']).toEqual([]);
  });
});
