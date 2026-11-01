/** Golden parity: the TypeScript engine must reproduce the Python engine's queue on the same inputs
 * (server/tools/golden_engine.py -> golden/engine.json). */
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import * as G from './genres';
import golden from './golden/engine.json';

type Row = { key: string; final: number; affinity: number; coverage: number; tier: string; best_seed: string | null; exposure_penalty: number; new_release: boolean };

const f = golden as unknown as {
  now: string;
  now_ts: number;
  seeds: (E.Track & { emphasis?: number })[];
  candidates: E.Track[];
  vectors: Record<string, number[]>;
  events: E.FeedbackEvent[];
  related_artists: Record<string, string[]>;
  impressions: Record<string, number>;
  expected: Record<string, Row[]>;
};

// JSON stores the tags as Python dicts; they already match the TS Tag shape.
const seeds = f.seeds.map((s) => ({ ...s, provenance: [], release: null, title: s.title, tags: s.tags as G.Tag[] }));
const cands = f.candidates.map((c) => ({ ...c, tags: c.tags as G.Tag[] }));
// float64, as in Python: Float32Array loses ~1e-8 in the dot product, which shows up as a score gap.
const vectors = new Map(Object.entries(f.vectors).map(([k, v]) => [k, Float64Array.from(v)] as const));
const related = new Map(Object.entries(f.related_artists).map(([k, v]) => [k, new Set(v)] as const));
const now = new Date(f.now + 'T00:00:00Z');

const settingsFor: Record<string, { adventurous: number; fresh: boolean }> = {
  neutral: { adventurous: 0.5, fresh: false },
  familiar: { adventurous: 0.0, fresh: false },
  adventurous: { adventurous: 1.0, fresh: true },
};

describe('engine golden parity (Python -> TypeScript)', () => {
  for (const label of Object.keys(settingsFor)) {
    it(`queue matches Python: ${label}`, () => {
      const ctx: E.Context = {
        seeds,
        vectors,
        relatedArtists: related,
        feedback: E.buildFeedback(f.events, f.now_ts),
        impressions: f.impressions,
        settings: E.normaliseSettings(settingsFor[label]!),
        now,
      };
      const q = E.recommend(cands, ctx);
      const want = f.expected[label]!;
      expect(q.map((s) => s.track.key)).toEqual(want.map((r) => r.key));
      for (let i = 0; i < want.length; i++) {
        const got = q[i]!, exp = want[i]!;
        expect(got.tier, `tier @${i}`).toBe(exp.tier);
        expect(got.bestSeed, `best_seed @${i}`).toBe(exp.best_seed);
        expect(got.newRelease, `new_release @${i}`).toBe(exp.new_release);
        expect(got.final, `final @${i}`).toBeCloseTo(exp.final, 9);
        expect(got.affinity, `affinity @${i}`).toBeCloseTo(exp.affinity, 9);
        expect(got.coverage, `coverage @${i}`).toBeCloseTo(exp.coverage, 9);
        expect(got.exposurePenalty, `exposure @${i}`).toBeCloseTo(exp.exposure_penalty, 9);
      }
    });
  }
});
