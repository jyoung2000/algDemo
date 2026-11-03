/**
 * Keeping cover art on the taste field from covering other cover art.
 *
 * The field plots a marker per played song at its genre/tempo position, so two plays of the same
 * song — or two songs in the same corner of one subgenre — land on the same point and the artwork
 * stacks. Measured on the owner's history: markers 4 and 5 overlapped by the full 42x42, and 1/4
 * and 1/5 partially, which is exactly what "ensure no cover art or images overlap" is about.
 *
 * This nudges a colliding marker off its exact point by the smallest amount that frees it, so the
 * picture stays next to where it belongs rather than being hidden. It is deliberately a display
 * concern: the underlying hue/BPM are untouched, and the marker's tooltip still names the song.
 */

/** A marker's position as a percentage of the field, measured from the left and the BOTTOM. */
export interface MarkerPos {
  left: number;
  bottom: number;
}

export interface SpreadOptions {
  /** Marker width as a percentage of the field's width. */
  w: number;
  /** Marker height as a percentage of the field's height. */
  h: number;
  /**
   * How far to push, as a multiple of the marker size, before giving up. Small on purpose: a
   * marker shoved across the field would misreport the song's genre.
   */
  maxRings?: number;
  /** Keep markers' centres inside the field by this fraction of their own size. */
  inset?: number;
}

const EIGHT = [0, 45, 90, 135, 180, 225, 270, 315];

const collides = (a: MarkerPos, b: MarkerPos, w: number, h: number) =>
  Math.abs(a.left - b.left) < w - 0.001 && Math.abs(a.bottom - b.bottom) < h - 0.001;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Nudge overlapping markers apart, in the order given.
 *
 * Earlier entries keep their exact position, so the caller decides who holds still. TastePicker
 * passes the trail NEWEST-first and reverses the result, so the ringed current song sits on its
 * true genre and tempo and the older plays are the ones that give way.
 *
 * Returns one position per input, in the same order. A marker that cannot be freed within
 * `maxRings` keeps its true position rather than being flung somewhere misleading.
 */
export function spreadMarkers(points: readonly MarkerPos[], opts: SpreadOptions): MarkerPos[] {
  const { w, h, maxRings = 3, inset = 0.5 } = opts;
  // Belt and braces for a field that has not been laid out yet. Not load-bearing: at w = h = 0
  // nothing registers as colliding, so every marker would pass through untouched regardless.
  if (!(w > 0) || !(h > 0)) return points.map((p) => ({ ...p }));
  const loX = w * inset;
  const hiX = 100 - w * inset;
  const loY = h * inset;
  const hiY = 100 - h * inset;
  const out: MarkerPos[] = [];

  for (const p of points) {
    const start: MarkerPos = { left: clamp(p.left, loX, hiX), bottom: clamp(p.bottom, loY, hiY) };
    if (!out.some((q) => collides(start, q, w, h))) {
      out.push(start);
      continue;
    }
    let best: MarkerPos | null = null;
    // Grow the ring until something fits. One marker-width per ring is the smallest step that can
    // actually clear a full overlap.
    for (let ring = 1; ring <= maxRings && !best; ring++) {
      for (const deg of EIGHT) {
        const rad = (deg * Math.PI) / 180;
        const cand: MarkerPos = {
          left: clamp(p.left + Math.cos(rad) * w * ring, loX, hiX),
          bottom: clamp(p.bottom + Math.sin(rad) * h * ring, loY, hiY),
        };
        if (!out.some((q) => collides(cand, q, w, h))) {
          best = cand;
          break;
        }
      }
    }
    out.push(best ?? start);
  }
  return out;
}

/** True when no two markers in the list overlap. For tests and assertions. */
export function anyOverlap(points: readonly MarkerPos[], w: number, h: number): boolean {
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (collides(points[i]!, points[j]!, w, h)) return true;
    }
  }
  return false;
}
