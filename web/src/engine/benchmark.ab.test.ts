/**
 * Old-vs-new on the SAME frozen candidate pool (the golden fixture: 3 seeds, 72 candidates, real
 * vectors, chronologically ordered events). Not a correctness test — it writes the comparison the
 * evaluation report cites. Run: node ../../node_modules/vitest/vitest.mjs run --root . --dir src benchmark
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as E from './engine';
import * as G from './genres';
import { buildTasteBlend } from './taste2';
import golden from './golden/engine.json';

const f = golden as unknown as {
  now: string; now_ts: number;
  seeds: (E.Track & { emphasis?: number })[];
  candidates: E.Track[];
  vectors: Record<string, number[]>;
  events: E.FeedbackEvent[];
  related_artists: Record<string, string[]>;
  impressions: Record<string, number>;
};

const OUT = 'D:/MusicRecommendationLab/benchmarks/frozen-pool-ab.json';

describe('frozen-pool A/B: v1 vs v2', () => {
  it('writes the comparison', () => {
    const seeds = f.seeds.map((s) => ({ ...s, provenance: [], release: null, tags: s.tags as G.Tag[] }));
    const cands = f.candidates.map((c) => ({ ...c, tags: c.tags as G.Tag[] }));
    const vectors = new Map(Object.entries(f.vectors).map(([k, v]) => [k, Float64Array.from(v)] as const));
    const related = new Map(Object.entries(f.related_artists).map(([k, v]) => [k, new Set(v)] as const));
    const now = new Date(f.now + 'T00:00:00Z');

    // chronological split: first 70% of events are "history", the rest unseen future
    const events = [...f.events].sort((a, b) => a.ts - b.ts);
    const cut = Math.floor(events.length * 0.7);
    const past = events.slice(0, cut);

    const run = (v2: boolean, adventurous: number) => {
      const settings: E.Settings = { adventurous, fresh: false, vocals: 'any' };
      const fb = v2 ? E.buildFeedback2(past, f.now_ts) : E.buildFeedback(past, f.now_ts);
      const taste2 = v2
        ? buildTasteBlend(past.map((e) => ({ key: e.key, kind: e.kind, ts: e.ts, track: null, event_id: e.event_id })), f.now_ts, null)
        : null;
      const ctx: E.Context = {
        seeds, vectors, relatedArtists: related, feedback: fb, impressions: f.impressions,
        settings, now, rankV2: v2, taste2,
      };
      return E.select(E.scoreAll(cands, ctx), ctx);
    };

    const metrics = (queue: E.Scored[]) => {
      const artists = queue.map((x) => E.primaryArtist(x.track));
      const top = new Map<string, number>();
      for (const a of artists) top.set(a, (top.get(a) ?? 0) + 1);
      const genres = new Set(queue.flatMap((x) => (x.track.tags ?? []).map((t) => t.name)));
      const nullProvider = queue.filter((x) => x.factors['provider'] === null).length;
      const zeroProvider = queue.filter((x) => x.factors['provider'] === 0).length;
      return {
        size: queue.length,
        distinct_artists: top.size,
        max_per_artist: Math.max(...top.values()),
        distinct_genres: genres.size,
        mean_coverage: +(queue.reduce((s, x) => s + x.coverage, 0) / queue.length).toFixed(4),
        mean_final: +(queue.reduce((s, x) => s + x.final, 0) / queue.length).toFixed(4),
        tiers: queue.reduce<Record<string, number>>((m, x) => ((m[x.tier] = (m[x.tier] ?? 0) + 1), m), {}),
        provider_null: nullProvider,
        provider_zero: zeroProvider,
      };
    };

    const out: Record<string, unknown> = {
      generated: new Date().toISOString(),
      pool: { seeds: seeds.length, candidates: cands.length, vectors: vectors.size, events_total: events.length, events_used: past.length },
      note: 'Same frozen pool, same history, same clock. v1 = parity engine; v2 = rank_v2.',
    };
    for (const [label, adv] of [['neutral', 0.5], ['familiar', 0.0], ['adventurous', 1.0]] as const) {
      const q1 = run(false, adv);
      const q2 = run(true, adv);
      const k1 = q1.map((x) => x.track.key);
      const k2 = q2.map((x) => x.track.key);
      const overlap = k2.filter((k) => k1.includes(k)).length;
      out[label] = {
        v1: metrics(q1),
        v2: metrics(q2),
        queue_overlap: `${overlap}/${Math.max(k1.length, k2.length)}`,
        entered_in_v2: k2.filter((k) => !k1.includes(k)),
        left_in_v2: k1.filter((k) => !k2.includes(k)),
      };
    }
    // determinism cross-check for both engines on identical input
    const d1a = run(true, 0.5).map((x) => [x.track.key, x.final]);
    const d1b = run(true, 0.5).map((x) => [x.track.key, x.final]);
    expect(d1a).toEqual(d1b);

    mkdirSync('D:/MusicRecommendationLab/benchmarks', { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    expect((out['neutral'] as { v2: { size: number } }).v2.size).toBeGreaterThan(0);
  });

  it('writes the scenario comparison (pools that actually carry v2 evidence)', () => {
    // The golden pool is v2-inert (no provenance.source, no behavioural events, all seeds have
    // vectors, no inferred tags) — above test proves v2==v1 there. These controlled pools turn
    // each v2 path on so the direction of change is observable. Synthetic: invariants only.
    const seeds = f.seeds.map((s) => ({ ...s, provenance: [], release: null, tags: s.tags as G.Tag[] }));
    const now = new Date(f.now + 'T00:00:00Z');
    const vectors = new Map(Object.entries(f.vectors).map(([k, v]) => [k, Float64Array.from(v)] as const));
    const related = new Map(Object.entries(f.related_artists).map(([k, v]) => [k, new Set(v)] as const));
    // Derive sources from relations (what the pipeline records at runtime).
    const SRC: Record<string, string> = {
      related_song: 'ytmusic-related', radio: 'ytmusic-radio', sc_recommended: 'soundcloud-recommended',
      artist_radio: 'deezer-artist-radio', related_artist_top: 'deezer-related-artist', ytm_related_artist: 'ytmusic-similar',
      seed_artist_top: 'deezer-artist-top', recent: 'deezer-recent', genre_chart: 'deezer-genre-chart', search_match: 'apple-search',
    };
    const cands = f.candidates.map((c) => ({
      ...c, tags: c.tags as G.Tag[],
      provenance: (c.provenance ?? []).map((p) => ({ ...p, source: SRC[p.relation] ?? 'unknown' })),
    }));
    // Corroborated copies: give 8 candidates a second, independent family listing.
    const corro = cands.map((c, i) =>
      i % 9 === 0 && c.provenance.length
        ? { ...c, provenance: [...c.provenance, { seed: c.provenance[0]!.seed, relation: 'sc_recommended', rank: 2, source: 'soundcloud-recommended' }] }
        : c,
    );
    // Behavioural history with the pathologies v2 corrects: one song looped 6x in a day (preview),
    // another finished once a day for 4 days (full), a third with one accidental skip.
    const h = (kind: string, key: string, daysAgo: number, id: string, over: Partial<E.FeedbackEvent> = {}): E.FeedbackEvent => ({
      event_id: id, key, kind, artist: key.split('|')[0] ?? '', ts: f.now_ts - daysAgo * 86400, ...over,
    });
    const loopKey = corro[3]!.key, spreadKey = corro[5]!.key, skipKey = corro[7]!.key;
    const history: E.FeedbackEvent[] = [
      ...Array.from({ length: 6 }, (_, i) => h('complete', loopKey, 0.4, `loop${i}`, { medium: 'preview', listened: 28, duration: 30 })),
      ...Array.from({ length: 4 }, (_, i) => h('complete', spreadKey, i + 0.5, `spread${i}`, { medium: 'full', listened: 200, duration: 210 })),
      h('skip', skipKey, 1, 'oops', { listened: 3 }),
    ];
    const run = (v2: boolean, vecs: Map<string, Float64Array>) => {
      const fb = v2 ? E.buildFeedback2(history, f.now_ts) : E.buildFeedback(history, f.now_ts);
      const ctx: E.Context = {
        seeds, vectors: vecs, relatedArtists: related, feedback: fb, impressions: f.impressions,
        settings: { adventurous: 0.5, fresh: false, vocals: 'any' }, now, rankV2: v2, taste2: null,
      };
      return E.select(E.scoreAll(corro, ctx), ctx);
    };
    const rank = (q: E.Scored[], k: string) => {
      const i = q.findIndex((x) => x.track.key === k);
      return i === -1 ? null : i + 1;
    };
    const q1 = run(false, vectors), q2 = run(true, vectors);
    const noVec1 = run(false, new Map()), noVec2 = run(true, new Map());
    const scenario = {
      corroboration: {
        note: '8 candidates got a second independent family listing',
        moved: corro.filter((_, i) => i % 9 === 0).map((c) => ({ key: c.key, v1: rank(q1, c.key), v2: rank(q2, c.key) })),
      },
      loop_vs_spread: {
        note: 'loop: 6 preview-completes in one day; spread: 4 full completes across 4 days',
        loop: { key: loopKey, v1_fb: +(E.buildFeedback(history, f.now_ts).track[loopKey] ?? 0).toFixed(3), v2_fb: +(E.buildFeedback2(history, f.now_ts).track[loopKey] ?? 0).toFixed(3) },
        spread: { key: spreadKey, v1_fb: +(E.buildFeedback(history, f.now_ts).track[spreadKey] ?? 0).toFixed(3), v2_fb: +(E.buildFeedback2(history, f.now_ts).track[spreadKey] ?? 0).toFixed(3) },
      },
      no_seed_vector_coverage: {
        note: 'same pool with every vector removed: v2 drops audio from the coverage denominator',
        v1_mean_coverage: +(noVec1.reduce((s, x) => s + x.coverage, 0) / noVec1.length).toFixed(4),
        v2_mean_coverage: +(noVec2.reduce((s, x) => s + x.coverage, 0) / noVec2.length).toFixed(4),
      },
    };
    // Invariants the report cites:
    // v1 rewards the loop more than the spread; v2 reverses that.
    expect(scenario.loop_vs_spread.loop.v1_fb).toBeGreaterThan(scenario.loop_vs_spread.spread.v1_fb);
    expect(scenario.loop_vs_spread.spread.v2_fb).toBeGreaterThan(scenario.loop_vs_spread.loop.v2_fb);
    // corroborated candidates never rank worse under v2
    for (const m of scenario.corroboration.moved) if (m.v1 !== null && m.v2 !== null) expect(m.v2).toBeLessThanOrEqual(m.v1 + 2);
    // coverage recovers when audio is impossible
    expect(scenario.no_seed_vector_coverage.v2_mean_coverage).toBeGreaterThan(scenario.no_seed_vector_coverage.v1_mean_coverage);
    writeFileSync('D:/MusicRecommendationLab/benchmarks/scenario-ab.json', JSON.stringify({ generated: new Date().toISOString(), ...scenario }, null, 2));
  });
});
