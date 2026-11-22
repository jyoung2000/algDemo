/**
 * ARTIST-SIZE-001 (owner, 2026-11-21): "when discovering and finding music try to recommend or find artist of similar
 * sizes, for example if I'm playing underground hip hop or underground rage, dont recommend me a ken carson or other
 * main stream acts".
 *
 * An artist's size is Deezer's follower count (nb_fan), the one public, keyless number every artist has. It is a
 * proxy (Deezer is bigger in some countries than others), so size only ever weighs a song down; it never removes one,
 * and an unknown size changes nothing. The reference is the geometric mean of the starting and favourite artists'
 * sizes, because sizes span five orders of magnitude and one famous seed must not drag an underground list upward.
 */

/** A candidate up to this many times bigger than the reference counts as the same size. */
export const BIGGER_OK = 3;
/** A candidate this many times smaller than a big reference still counts as the same size. */
export const SMALLER_OK = 40;
/** Decades of size beyond the band cost this much (as a power of ten): a bigger act much more than a smaller one. */
const BIGGER_COST = 1.5;
const SMALLER_COST = 0.5;
/** Never below this: a song that fits everything else can still appear, low in the list. */
const FLOOR = 0.05;
/** Below this many followers the listener's scene is underground: genre charts (the biggest acts) are not asked. */
export const SMALL_SCENE = 60_000;

const known = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

export function referenceSize(fans: readonly (number | null | undefined)[]): number | null {
  const xs = fans.filter(known);
  if (!xs.length) return null;
  return Math.round(Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length));
}

/** How much a candidate's score keeps for its artist's size: 1 inside the band, less the further outside it. */
export function sizeFit(fans: number | null | undefined, reference: number | null | undefined): number {
  if (!known(fans) || !known(reference)) return 1;
  const up = Math.log10(fans / (reference * BIGGER_OK));
  if (up > 0) return Math.max(FLOOR, 10 ** (-BIGGER_COST * up));
  const down = Math.log10((reference / SMALLER_OK) / fans);
  if (down > 0) return Math.max(FLOOR, 10 ** (-SMALLER_COST * down));
  return 1;
}

export function smallScene(reference: number | null | undefined): boolean {
  return known(reference) && reference < SMALL_SCENE;
}
