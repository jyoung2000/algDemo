/**
 * SIMILAR-SOUND-001: a measured sound match, not a genre/artist/metadata guess. A percentage is the
 * app's calibrated DCLAP cosine score (calibrateAudio); it is NOT a probability that two listeners
 * would call the songs alike. Missing vectors never pass, however well metadata matches.
 */
import { calibrateAudio } from './engine';
import { cosine, DIM } from './audio';
import { matchRecordings } from './identity';

export const SIMILAR_MIN = 40;
export const SIMILAR_MAX = 95;
export const SIMILAR_DEFAULT = 70;
export const SIMILAR_LIMIT = 10;
/** SIMILAR-MIN-001 (owner, 2026-11-19): "find similar song should at bare minimum find 3 similar songs". */
export const SIMILAR_FLOOR = 3;
export const isSimilarityPercent = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= SIMILAR_MIN && n <= SIMILAR_MAX;

export type SoundTrack = { key: string; title: string; artists: string[]; [key: string]: unknown };
export interface SoundHit<T extends SoundTrack> { track: T; match: number; /** Below the chosen percentage: one of the closest, added to reach SIMILAR_FLOOR. */ below?: boolean }
/** Both vectors must be real, same-model 512-dimensional vectors; the caller retrieves them by model + preprocessing id. */
export function soundMatch(a: ArrayLike<number> | null, b: ArrayLike<number> | null): number | null {
  if (!a || !b || a.length !== DIM || b.length !== DIM) return null;
  const sim = cosine(a, b);
  return Number.isFinite(sim) ? Math.round(calibrateAudio(sim) * 100) : null;
}
/** Keep the best sound match for a recording, not the same song on six providers. Keep an existing list untouched. */
export function selectSimilar<T extends SoundTrack>(seed: T, existing: T[], candidates: SoundHit<T>[], minimum: number, limit = SIMILAR_LIMIT, floor = SIMILAR_FLOOR): SoundHit<T>[] {
  if (!isSimilarityPercent(minimum)) throw new RangeError(`Sound match must be ${SIMILAR_MIN}–${SIMILAR_MAX}%.`);
  const picked: SoundHit<T>[] = [];
  const fresh = (hit: SoundHit<T>) => ![seed, ...existing, ...picked.map((x) => x.track)].some((t) => t.key === hit.track.key || matchRecordings(t, hit.track).verdict === 'same');
  const ranked = [...candidates].filter((h) => Number.isFinite(h.match)).sort((a, b) => b.match - a.match);
  for (const hit of ranked.filter((h) => h.match >= minimum)) {
    if (!fresh(hit)) continue;
    picked.push(hit);
    if (picked.length >= limit) break;
  }
  // SIMILAR-MIN-001: fewer than three reached the percentage, so the next closest measured songs make up
  // three, each marked as below it. Still measured sound, never a guess.
  for (const hit of ranked.filter((h) => h.match < minimum)) {
    if (picked.length >= Math.min(floor, limit)) break;
    if (fresh(hit)) picked.push({ ...hit, below: true });
  }
  return picked;
}
