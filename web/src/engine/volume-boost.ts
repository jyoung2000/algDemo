/**
 * VOLUME-BOOST-001 (owner, 2026-11-19): "increase the volume past the stock limits ... up to 200% with a slider or
 * android auto and the audio still sound crisp and audible".
 *
 * The slider runs 0..2. Up to 1 it is the ordinary volume; above 1 the player's own audio element stays at 100% and
 * the mix bus's master gain carries the boost, before the mix limiter. While boosted the limiter holds its gain
 * longer (LIMITER_BOOST: -2 dB, 3 ms / 250 ms) and a soft ceiling from -1 dBFS stops any peak reaching full scale.
 * Measured on the Android port of the same limiter (BoostLimiterTest): a 200% boost peaks at -0.11 dBFS with 1.2%
 * distortion on a steady tone, against +0.9 dBFS (clipping) and 2.6% with the ordinary limiter timing.
 */
export const VOLUME_MAX = 2;
/** The car's Volume button steps through these. */
export const CAR_LEVELS = [1, 1.25, 1.5, 1.75, 2] as const;
/** Where the soft ceiling starts bending (-1 dBFS). */
export const SOFT_CLIP_FROM = 0.891;

const clamp = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(VOLUME_MAX, v)) : 1);
/** What the audio element itself is set to (it cannot go past 1). */
export const elementVolume = (v: number) => Math.min(1, clamp(v));
/** What the mix bus master gain carries: 1 up to 100%, the boost above it. */
export const boostGain = (v: number) => Math.max(1, clamp(v));

export function readVolume(raw: string | null): { value: number; muted: boolean } {
  try {
    const v = JSON.parse(raw ?? 'null') as { value?: unknown; muted?: unknown } | null;
    const value = typeof v?.value === 'number' && v.value >= 0 && v.value <= VOLUME_MAX ? v.value : 0.8;
    return { value, muted: v?.muted === true };
  } catch {
    return { value: 0.8, muted: false };
  }
}

/** The car button's next level: the first step above the current volume, wrapping from 200% back to 100%. */
export function nextCarLevel(v: number): number {
  const now = clamp(v);
  return CAR_LEVELS.find((l) => l > now + 1e-6) ?? CAR_LEVELS[0];
}

/** Identity below SOFT_CLIP_FROM, then a tanh bend that approaches (never reaches) full scale. Same curve as MixBus.kt. */
export function softClipSample(x: number): number {
  const t = SOFT_CLIP_FROM;
  const a = Math.abs(x);
  if (a <= t) return x;
  const y = t + (1 - t) * Math.tanh((a - t) / (1 - t));
  return x < 0 ? -y : y;
}

export function softClipCurve(n = 4097): Float32Array<ArrayBuffer> {
  const c = new Float32Array(new ArrayBuffer(n * 4));
  // A WaveShaper reads its curve over input -1..1 and holds the end values beyond it. The shaper sits after the
  // limiter, so its input is already near or under the -2 dB threshold; only overshoots reach the bend.
  for (let i = 0; i < n; i++) c[i] = softClipSample((i / (n - 1)) * 2 - 1);
  return c;
}
