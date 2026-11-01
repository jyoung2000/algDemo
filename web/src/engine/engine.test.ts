/** Port of server/tests/test_engine.py. Deterministic: no network, fixed `now`. */
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import * as G from './genres';
import { DEFAULT_ENGINE, DEFAULT_WEIGHTS, engineWithWeights, validateWeights } from './config';

const NOW = new Date(Date.UTC(2026, 9, 26));
const NOW_TS = 1_793_000_000.0;

function track(
  key: string,
  artist: string,
  opts: { title?: string; tags?: string[]; prov?: [string, string, number][]; release?: E.Release | null; bpm?: number | null } = {},
): E.Track {
  return {
    key,
    title: opts.title ?? key,
    artists: [artist],
    tags: (opts.tags ?? []).map((t) => G.makeTag(t, 'Deezer', 'album', 0.9)!),
    provenance: (opts.prov ?? []).map(([seed, relation, rank]) => ({ seed, relation, rank })),
    release: opts.release ?? null,
    bpm: opts.bpm ?? null,
  };
}

function ctx(
  seeds: E.Track[],
  o: {
    vectors?: Map<string, Float32Array>;
    related?: Map<string, Set<string>>;
    events?: E.FeedbackEvent[];
    fresh?: boolean;
    adventurous?: number;
    impressions?: Record<string, number>;
  } = {},
): E.Context {
  return {
    seeds,
    vectors: o.vectors ?? new Map(),
    relatedArtists: o.related ?? new Map(),
    feedback: E.buildFeedback(o.events ?? [], NOW_TS),
    impressions: o.impressions ?? {},
    settings: E.normaliseSettings({ fresh: o.fresh ?? false, adventurous: o.adventurous ?? 0.5 }),
    now: NOW,
  };
}

describe('engine (port of test_engine.py)', () => {
  // ---- missing-factor normalisation ----
  it('missing audio is not a negative score', () => {
    const seed = track('s', 'Seed Artist', { tags: ['indie rock'] });
    const c = track('a', 'Other', { tags: ['indie rock'], prov: [['s', 'related_song', 0]] });
    const sc = E.scoreOne(c, ctx([seed]));
    expect(sc.factors.audio).toBeNull();
    expect('audio' in sc.weightsUsed).toBe(false);
    expect(sc.final).toBeGreaterThanOrEqual(0);
    expect(sc.final).toBeLessThanOrEqual(1);
    expect(sc.affinity).toBeGreaterThan(0.5);
  });

  it('one weak signal does not beat rich evidence', () => {
    const seed = track('s', 'Seed', { tags: ['indie rock'], bpm: 120 });
    const sparse = track('sparse', 'Unknown Act');
    const rich = track('rich', 'Rel', { tags: ['indie rock'], prov: [['s', 'related_song', 0]], bpm: 121 });
    const c = ctx([seed]);
    const a = E.scoreOne(sparse, c), b = E.scoreOne(rich, c);
    expect(b.coverage).toBeGreaterThan(a.coverage);
    expect(b.final).toBeGreaterThan(a.final);
  });

  it('genre and provider are not double counted', () => {
    const seed = track('s', 'Seed', { tags: ['indie rock'] });
    const both = track('x', 'X', { tags: ['indie rock'], prov: [['s', 'related_song', 0]] });
    const sc = E.scoreOne(both, ctx([seed]));
    const w = E.modeWeights(DEFAULT_ENGINE.weights, 1.0);
    const sws = { genre: w.genre * (1 - DEFAULT_ENGINE.genreProviderOverlap), provider: w.provider };
    const expected = (sws.genre * sc.factors.genre! + sws.provider * sc.factors.provider!) / (sws.genre + sws.provider);
    expect(sc.perSeed.s).toBeCloseTo(expected, 10);
  });

  it('scoring is deterministic regardless of input order', () => {
    const seeds = [track('s1', 'A', { tags: ['pop'] }), track('s2', 'B', { tags: ['jazz'] })];
    const cands = Array.from({ length: 40 }, (_, i) =>
      track(`c${i}`, `Art${i % 7}`, { tags: [i % 2 ? 'pop' : 'jazz'], prov: [[i % 3 ? 's1' : 's2', 'radio', i]] }),
    );
    const q1 = E.recommend(cands, ctx(seeds)).map((s) => s.track.key);
    const q2 = E.recommend([...cands].reverse(), ctx(seeds)).map((s) => s.track.key);
    expect(q1).toEqual(q2);
  });

  // ---- multi-seed ----
  it('multi-seed keeps both taste clusters', () => {
    const seeds = [track('rock', 'Rocker', { tags: ['rock'] }), track('jazz', 'Jazzer', { tags: ['jazz'] })];
    const cands = [
      ...Array.from({ length: 20 }, (_, i) => track(`r${i}`, `R${i}`, { tags: ['rock'], prov: [['rock', 'radio', i]] })),
      ...Array.from({ length: 20 }, (_, i) => track(`j${i}`, `J${i}`, { tags: ['jazz'], prov: [['jazz', 'radio', i]] })),
    ];
    const q = E.recommend(cands, ctx(seeds));
    const by: Record<string, number> = { rock: 0, jazz: 0 };
    for (const s of q) by[s.bestSeed!]!++;
    expect(by.rock).toBeGreaterThanOrEqual(10);
    expect(by.jazz).toBeGreaterThanOrEqual(10);
  });

  it('best-seed blend beats the plain average', () => {
    const seeds = [track('rock', 'Rocker', { tags: ['rock'] }), track('jazz', 'Jazzer', { tags: ['jazz'] })];
    const c = track('x', 'X', { tags: ['rock'], prov: [['rock', 'related_song', 0]] });
    const sc = E.scoreOne(c, ctx(seeds));
    const vals = Object.values(sc.perSeed);
    const plainMean = vals.reduce((a, b) => a + b, 0) / vals.length;
    expect(sc.bestSeed).toBe('rock');
    expect(sc.affinity).toBeGreaterThan(plainMean * 0.9);
    expect(0.7 * sc.perSeed.rock! + 0.3 * plainMean).toBeGreaterThan(plainMean);
  });

  it('seed emphasis shifts queue share', () => {
    const a = track('a', 'A', { tags: ['rock'] });
    const b = track('b', 'B', { tags: ['jazz'] });
    const cands = [
      ...Array.from({ length: 30 }, (_, i) => track(`r${i}`, `R${i}`, { tags: ['rock'], prov: [['a', 'radio', i]] })),
      ...Array.from({ length: 30 }, (_, i) => track(`j${i}`, `J${i}`, { tags: ['jazz'], prov: [['b', 'radio', i]] })),
    ];
    const count = (q: E.Scored[]) => q.filter((s) => s.bestSeed === 'a').length;
    const even = E.recommend(cands, ctx([a, b]));
    const leaning = E.recommend(cands, ctx([{ ...a, emphasis: 2.0 }, b]));
    expect(count(leaning)).toBeGreaterThan(count(even));
  });

  // ---- selection and diversity ----
  it('max two per artist, and no re-sort', () => {
    const seed = track('s', 'Seed', { tags: ['pop'] });
    const cands = Array.from({ length: 40 }, (_, i) => track(`c${i}`, `Artist${i % 5}`, { tags: ['pop'], prov: [['s', 'radio', i]] }));
    const q = E.recommend(cands, ctx([seed]));
    const per: Record<string, number> = {};
    for (const s of q) {
      const p = E.primaryArtist(s.track);
      per[p] = (per[p] ?? 0) + 1;
    }
    expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
    expect(q.length).toBe(10); // 5 artists x 2: never padded up to 30
  });

  it('selection spreads audio lookalikes', () => {
    const seed = track('s', 'Seed');
    // Deterministic stand-in for the seeded numpy RNG: unit base vector and an orthogonal unit vector.
    const base = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const other = new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]);
    const vectors = new Map<string, Float32Array>([['s', base]]);
    const cands: E.Track[] = [];
    for (let i = 0; i < 6; i++) {
      vectors.set(`same${i}`, base);
      cands.push(track(`same${i}`, `S${i}`, { prov: [['s', 'radio', 0]] }));
    }
    const diff = new Float32Array(8);
    for (let i = 0; i < 8; i++) diff[i] = 0.8 * base[i]! + 0.6 * other[i]!;
    vectors.set('diff', diff);
    cands.push(track('diff', 'D', { prov: [['s', 'radio', 0]] }));
    const q = E.recommend(cands, ctx([seed], { vectors })).map((s) => s.track.key);
    expect(q.indexOf('diff')).toBeLessThan(q.length - 1);
  });

  it('seeds, disliked and hidden tracks are excluded', () => {
    const seed = track('s', 'Seed', { tags: ['pop'] });
    const cands = ['s', 'bad', 'hid', 'ok'].map((k) => track(k, k.toUpperCase(), { tags: ['pop'], prov: [['s', 'radio', 0]] }));
    const events: E.FeedbackEvent[] = [
      { event_id: '1', key: 'bad', kind: 'dislike', artist: 'BAD', ts: NOW_TS - 10 },
      { event_id: '2', key: 'hid', kind: 'hide', artist: 'HID', ts: NOW_TS - 10 },
    ];
    expect(E.recommend(cands, ctx([seed], { events })).map((s) => s.track.key)).toEqual(['ok']);
  });

  it('adventurous moves tier shares', () => {
    const safe = E.tierShares(0.0), bold = E.tierShares(1.0), mid = E.tierShares(0.5);
    expect(mid.strong!).toBeCloseTo(0.4, 10);
    expect(mid.related!).toBeCloseTo(0.3, 10);
    expect(mid.emerging!).toBeCloseTo(0.2, 10);
    expect(mid.experimental!).toBeCloseTo(0.1, 10);
    expect(safe.strong!).toBeGreaterThan(mid.strong!);
    expect(mid.strong!).toBeGreaterThan(bold.strong!);
    expect(safe.experimental!).toBeLessThan(bold.experimental!);
    for (const s of [safe, mid, bold]) expect(Object.values(s).reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 10);
  });

  it('exposure penalty is bounded', () => {
    const seed = track('s', 'Seed', { tags: ['pop'] });
    const c = track('c', 'C', { tags: ['pop'], prov: [['s', 'radio', 0]] });
    const sc = E.scoreOne(c, ctx([seed], { impressions: { c: 50 } }));
    expect(sc.exposurePenalty).toBeCloseTo(DEFAULT_ENGINE.exposurePenaltyMax, 10);
  });

  // ---- feedback ----
  it('feedback events are deduplicated and decayed', () => {
    const ev: E.FeedbackEvent = { event_id: 'e1', key: 'k', kind: 'like', artist: 'A', ts: NOW_TS };
    const once = E.buildFeedback([ev], NOW_TS);
    const twice = E.buildFeedback([ev, { ...ev }], NOW_TS);
    expect(once.track).toEqual(twice.track);
    expect(twice.events).toBe(1);
    const old = E.buildFeedback([{ ...ev, ts: NOW_TS - 45 * 86400 }], NOW_TS);
    expect(old.track.k).toBeCloseTo(once.track.k! / 2, 10);
  });

  it('seed selection is never history', () => {
    const fb = E.buildFeedback([{ event_id: 's', key: 'k', kind: 'seed', artist: 'A', ts: NOW_TS }], NOW_TS);
    expect(fb.events).toBe(0);
    expect(Object.keys(fb.track).length).toBe(0);
  });

  it('one skip does not penalise an artist but three do', () => {
    const skips: E.FeedbackEvent[] = [0, 1, 2].map((i) => ({ event_id: `x${i}`, key: `t${i}`, kind: 'skip', artist: 'A', ts: NOW_TS }));
    expect('A' in E.buildFeedback(skips.slice(0, 1), NOW_TS).artist).toBe(false);
    expect('A' in E.buildFeedback(skips.slice(0, 2), NOW_TS).artist).toBe(false);
    const same = [0, 1, 2].map((i) => ({ ...skips[0]!, event_id: `y${i}` }));
    expect('A' in E.buildFeedback(same, NOW_TS).artist).toBe(false);
    expect(E.buildFeedback(skips, NOW_TS).artist.A!).toBeLessThan(0);
  });

  it('a like re-ranks the artist up', () => {
    const seed = track('s', 'Seed', { tags: ['pop'] });
    const a = track('a', 'Liked Act', { tags: ['pop'], prov: [['s', 'radio', 5]] });
    const b = track('b', 'Other', { tags: ['pop'], prov: [['s', 'radio', 5]] });
    const events: E.FeedbackEvent[] = [{ event_id: 'l', key: 'earlier', kind: 'like', artist: 'liked act', ts: NOW_TS }];
    const before = E.scoreOne(a, ctx([seed])).final;
    const after = E.scoreOne(a, ctx([seed], { events })).final;
    expect(after).toBeGreaterThan(before);
    expect(E.scoreOne(b, ctx([seed], { events })).factors.feedback).toBeNull();
  });

  // ---- dates ----
  it('date precision rules', () => {
    const day: E.Release = { date: '2026-10-01', precision: 'day', kind: 'release', source: 'Deezer' };
    const month: E.Release = { date: '2026-10', precision: 'month', kind: 'release', source: 'Deezer' };
    const year: E.Release = { date: '2026', precision: 'year', kind: 'release', source: 'YouTube Music' };
    const upload: E.Release = { ...day, kind: 'upload' };
    expect(E.isNewRelease(day, NOW, 60)).toBe(true);
    expect(E.isNewRelease(month, NOW, 60)).toBe(false);
    expect(E.isNewRelease(year, NOW, 60)).toBe(false);
    expect(E.isNewRelease(upload, NOW, 60)).toBe(false);
    expect(E.freshness(year, NOW)).toBeNull();
    expect(E.freshness(upload, NOW)!).toBeCloseTo(E.freshness(day, NOW)! / 2, 10);
    expect(E.isNewRelease({ ...day, date: '2026-06-01' }, NOW, 60)).toBe(false);
  });

  it('year-only date is flagged as uncertain', () => {
    const seed = track('s', 'Seed');
    const c = track('c', 'C', { prov: [['s', 'radio', 0]], release: { date: '2026', precision: 'year', kind: 'release', source: 'YouTube Music' } });
    const q = E.recommend([c], ctx([seed]));
    expect(q[0]!.uncertainty.some((u) => u.includes('year'))).toBe(true);
  });

  // ---- explanations ----
  it('reasons lead with evidence and never claim audio without vectors', () => {
    const seed = track('s', 'Seed', { title: 'Seed Song', tags: ['indie rock'] });
    const c = track('c', 'Brand New', { tags: ['indie rock'], prov: [['s', 'related_song', 0]] });
    const sc = E.recommend([c], ctx([seed], { adventurous: 1.0 }))[0]!;
    const factors = sc.reasons.map((r) => r.factor);
    expect(factors[0]).toBe('provider');
    expect(factors).not.toContain('audio');
    expect(factors[factors.length - 1]).toBe('novelty');
    expect(sc.reasons[0]!.text).toContain('“Seed Song”');
    expect(sc.uncertainty.some((u) => u.includes('No audio comparison'))).toBe(true);
  });

  it('audio reason only with real vectors', () => {
    const v = new Float32Array(4).fill(0.5);
    const seed = track('s', 'Seed');
    const c = track('c', 'C', { prov: [['s', 'radio', 0]] });
    const sc = E.recommend([c], ctx([seed], { vectors: new Map([['s', v], ['c', v]]) }))[0]!;
    expect(sc.factors.audio).toBeCloseTo(1.0, 10);
    expect(sc.reasons.some((r) => r.factor === 'audio')).toBe(true);
  });

  // ---- weights ----
  it('weight validation', () => {
    expect(() => validateWeights({ ...DEFAULT_WEIGHTS, audio: -0.1 })).toThrow();
    expect(() => validateWeights({ ...DEFAULT_WEIGHTS, audio: 1.5 })).toThrow();
    expect(() => validateWeights(Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, 0])) as any)).toThrow();
    const cfg = engineWithWeights({ audio: 0.5, typo_factor: 9 });
    expect(cfg.weights.audio).toBe(0.5);
    const sum = Object.values(DEFAULT_ENGINE.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});
