/**
 * Paths, budgets and the recommender's starting configuration. TypeScript port of
 * server/airwave_discovery/config.py. Paths and environment are server concerns and are not ported;
 * the budgets, weights and engine tuning are the values the engine uses.
 */

import { TASTE_WEIGHT } from './taste';

export const MB = 1_000_000;
export const GB = 1_000_000_000;

export const STORAGE = {
  hardCap: 5 * GB,
  target: Math.trunc(4.5 * GB),
  runtime: Math.trunc(1.2 * GB),
  models: Math.trunc(0.8 * GB),
  database: 1 * GB,
  artwork: Math.trunc(0.25 * GB),
  tempAudio: Math.trunc(0.25 * GB),
  logs: Math.trunc(0.1 * GB),
  freeDiskFloor: 512 * MB,
} as const;

export const TRANSFER = {
  daily: 100 * MB,
  perRequest: 20 * MB,
  // One preview clip is ~0.48 MB at 128 kb/s; anything far larger is not a 30-second preview.
  perAudioFile: Math.trunc(1.5 * MB),
} as const;

export const FACTORS = ['audio', 'genre', 'artist', 'provider', 'feedback', 'tempo', 'freshness', 'novelty'] as const;
export type Factor = (typeof FACTORS)[number];
export type Weights = Record<Factor, number>;

// Factors that say something about how well a candidate fits the seeds. Freshness and novelty are
// properties of the candidate alone, so they do not raise the evidence coverage of a match.
export const AFFINITY_FACTORS: Factor[] = ['audio', 'genre', 'artist', 'provider', 'feedback', 'tempo'];

export interface TierShares {
  strong: number;
  related: number;
  emerging: number;
  experimental: number;
}

export interface EngineConfig {
  /** Safe arithmetic override of the final discovery score; absent keeps exact built-in ranking. */
  rankingFormula?: string | null;
  weights: Weights;
  /**
   * Weight of the feedback factor in the evidence coverage (the "seed fit" line). Absent means
   * `weights.feedback`, which is also the feedback weight in the affinity mean. ALGO-MANAGER-001.
   */
  seedFeedbackWeight?: number;
  /** Share of listening taste blended into the affinity (v1); v2 scales its evidence-aware share by tasteWeight / TASTE_WEIGHT. */
  tasteWeight: number;
  tiers: TierShares;
  bestSeedShare: number;
  coverageFloor: number;
  genreProviderOverlap: number;
  maxPerArtist: number;
  queueSize: number;
  perSourceCap: number;
  mergedCap: number;
  audioCandidatesPerRequest: number;
  newReleaseDays: number;
  feedbackHalfLifeDays: number;
  exposurePenalty: number;
  exposurePenaltyMax: number;
  exposureWindowDays: number;
  artistSkipThreshold: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  audio: 0.35, genre: 0.15, artist: 0.15, provider: 0.1, feedback: 0.1, tempo: 0.05, freshness: 0.05, novelty: 0.05,
};

/**
 * What the Familiar–Adventurous slider does to a weight: [multiplier at Familiar, multiplier at Adventurous], 1 in
 * the middle. The scorer and the formula notes both read these, so the notes cannot drift from the scoring.
 */
export const MODE_MULTIPLIERS: Partial<Record<Factor, readonly [number, number]>> = {
  audio: [1.3, 1.0],
  artist: [1.3, 0.7],
  provider: [1.2, 1.0],
  novelty: [0.3, 2.5],
};
/** “Prefer new releases” multiplies the freshness weight by this. */
export const FRESH_WEIGHT_MULTIPLIER = 5.0;

export const DEFAULT_ENGINE: EngineConfig = {
  weights: DEFAULT_WEIGHTS,
  tasteWeight: TASTE_WEIGHT,
  tiers: { strong: 0.4, related: 0.3, emerging: 0.2, experimental: 0.1 },
  // Multi-seed blend: best single-seed affinity vs the emphasis-weighted mean over seeds.
  bestSeedShare: 0.7,
  // final = affinity * (coverageFloor + (1 - coverageFloor) * coverage).
  coverageFloor: 0.55,
  // Genre and provider evidence overlap; the genre weight is discounted by this fraction.
  genreProviderOverlap: 0.5,
  maxPerArtist: 2,
  queueSize: 30,
  perSourceCap: 40,
  mergedCap: 200,
  audioCandidatesPerRequest: 20,
  newReleaseDays: 60,
  feedbackHalfLifeDays: 45.0,
  exposurePenalty: 0.04,
  exposurePenaltyMax: 0.16,
  exposureWindowDays: 7.0,
  artistSkipThreshold: 3,
};

export const FEEDBACK_WEIGHTS: Record<string, number> = {
  seed: 6.0, // session only, never written as history
  like: 6.0,
  save: 5.0,
  replay: 4.0,
  complete: 3.0,
  qualified: 1.5, // imported play: submitted listen is not proof of completion
  dislike: -6.0,
  hide: -3.0,
  skip: -1.0,
};

/** Throws when a weight is outside 0..1 or all weights are non-positive, so a typo cannot flip a factor. */
export function validateWeights(w: Weights): Weights {
  for (const k of FACTORS) {
    const v = w[k];
    if (!(v >= 0 && v <= 1)) throw new Error(`weight ${k} must be within 0..1, got ${v}`);
  }
  const total = FACTORS.reduce((s, k) => s + w[k], 0);
  if (total <= 0) throw new Error('at least one weight must be positive');
  return w;
}

export function engineWithWeights(overrides: Partial<Record<string, number>> | null | undefined): EngineConfig {
  if (!overrides || Object.keys(overrides).length === 0) return DEFAULT_ENGINE;
  const w: Weights = { ...DEFAULT_WEIGHTS };
  for (const k of FACTORS) if (k in overrides) w[k] = Number(overrides[k]);
  return { ...DEFAULT_ENGINE, weights: validateWeights(w) };
}
