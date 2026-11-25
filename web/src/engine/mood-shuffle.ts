/**
 * MOOD-SHUFFLE-001 (owner, 2026-11-19: "even shuffle should take into account my current listen mood").
 * No imports on purpose: util.ts (imported everywhere) uses it for the shuffle's next pick.
 */
export interface ShuffleMood {
  /** Song key -> 0..1 fit to the listening mood (moodFit). Missing keys count as MOOD_FIT_UNKNOWN. */
  fit: ReadonlyMap<string, number>;
  /** 0..1, how much listening the mood rests on. 0 = an even shuffle. */
  confidence: number;
  /** The Familiar (0) <-> Adventurous (1) slider. */
  adventurous: number;
}

/** A song nothing is known about sits in the middle: neither favoured nor held back. */
export const MOOD_FIT_UNKNOWN = 0.5;

/**
 * MOOD-SHUFFLE-001: one random pick, weighted towards songs that fit the mood. Every song keeps a chance,
 * so it is still a shuffle; Familiar holds the mood tightly, Adventurous lets more variety through, and
 * with no mood (confidence 0) it is an even shuffle. Weight = e^(k * fit).
 * WP5 (S1, S2; decision D3): k = confidence * ln(R(a)), R = the best-to-worst weight ratio: Familiar 8, middle 4,
 * Adventurous 2, linear between. Fits stay 0..1, so no two songs differ in weight by more than R and a mood leans on a
 * shuffle instead of sorting it (it was k = confidence * (10 - 7a), a ratio of up to e^10 ~ 22,000).
 */
export function moodRatio(adventurous: number): number {
  const a = Math.max(0, Math.min(1, adventurous));
  return a <= 0.5 ? 8 - 8 * a : 4 - 4 * (a - 0.5);
}

export function moodShufflePick<T>(items: readonly T[], keyOf: (x: T) => string, fit: ReadonlyMap<string, number>, o: { adventurous: number; confidence: number; rand: () => number }): T {
  const k = Math.max(0, Math.min(1, o.confidence)) * Math.log(moodRatio(o.adventurous));
  const w = items.map((x) => Math.exp(k * (fit.get(keyOf(x)) ?? MOOD_FIT_UNKNOWN)));
  const total = w.reduce((t, v) => t + v, 0);
  let r = o.rand() * total;
  for (let i = 0; i < items.length; i++) { r -= w[i]!; if (r < 0) return items[i]!; }
  return items[items.length - 1]!;
}
