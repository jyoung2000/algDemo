import { describe, expect, it } from 'vitest';

import { anyOverlap, spreadMarkers, type MarkerPos } from './taste-spread';

/**
 * TASTE-MAP-ART-ONLY: cover art on the taste field must not cover other cover art.
 *
 * Numbers come from the owner's real field: a 362x275 field with 42px markers, so a marker is
 * 11.6% of the width and 15.3% of the height.
 */
const W = (42 / 362) * 100;
const H = (42 / 275) * 100;

describe('spreading cover art so none of it overlaps', () => {
  it('separates two plays of the same song, which land on one point', () => {
    const same: MarkerPos[] = [
      { left: 50, bottom: 50 },
      { left: 50, bottom: 50 },
    ];
    expect(anyOverlap(same, W, H), 'they start fully stacked').toBe(true);
    const out = spreadMarkers(same, { w: W, h: H });
    expect(anyOverlap(out, W, H)).toBe(false);
    expect(out).toHaveLength(2);
  });

  it('leaves the first marker exactly where it belongs', () => {
    const out = spreadMarkers(
      [
        { left: 40, bottom: 60 },
        { left: 40, bottom: 60 },
      ],
      { w: W, h: H },
    );
    expect(out[0]).toEqual({ left: 40, bottom: 60 });
    expect(out[1]).not.toEqual({ left: 40, bottom: 60 });
  });

  it('does not touch markers that already have room', () => {
    const apart: MarkerPos[] = [
      { left: 10, bottom: 20 },
      { left: 60, bottom: 80 },
      { left: 35, bottom: 50 },
    ];
    expect(spreadMarkers(apart, { w: W, h: H })).toEqual(apart);
  });

  it('clears the owner’s measured overlap: 5 markers, 3 colliding pairs', () => {
    // 1/4 and 1/5 partially, 4/5 completely — the real reading off the Electron build.
    const real: MarkerPos[] = [
      { left: 61.2, bottom: 47.0 },
      { left: 20.4, bottom: 12.8 },
      { left: 44.1, bottom: 30.2 },
      { left: 61.2, bottom: 54.8 },
      { left: 61.2, bottom: 47.0 },
    ];
    expect(anyOverlap(real, W, H)).toBe(true);
    const out = spreadMarkers(real, { w: W, h: H });
    expect(anyOverlap(out, W, H), 'every pair must be clear afterwards').toBe(false);
    // Nothing is flung across the field: each stays within 3 marker-widths of its true point.
    out.forEach((p, i) => {
      expect(Math.abs(p.left - real[i]!.left)).toBeLessThanOrEqual(W * 3 + 0.01);
      expect(Math.abs(p.bottom - real[i]!.bottom)).toBeLessThanOrEqual(H * 3 + 0.01);
    });
  });

  it('keeps every marker inside the field', () => {
    // A pile in the corner must not push anything off the edge.
    const corner: MarkerPos[] = Array.from({ length: 6 }, () => ({ left: 0, bottom: 0 }));
    const out = spreadMarkers(corner, { w: W, h: H });
    for (const p of out) {
      expect(p.left).toBeGreaterThanOrEqual(W * 0.5 - 0.001);
      expect(p.left).toBeLessThanOrEqual(100 - W * 0.5 + 0.001);
      expect(p.bottom).toBeGreaterThanOrEqual(H * 0.5 - 0.001);
      expect(p.bottom).toBeLessThanOrEqual(100 - H * 0.5 + 0.001);
    }
  });

  it('is deterministic, so the field does not reshuffle on every render', () => {
    const pts: MarkerPos[] = [
      { left: 50, bottom: 50 },
      { left: 50, bottom: 50 },
      { left: 52, bottom: 51 },
      { left: 10, bottom: 90 },
    ];
    const a = spreadMarkers(pts, { w: W, h: H });
    const b = spreadMarkers(pts, { w: W, h: H });
    expect(a).toEqual(b);
  });

  it('returns a position for every input, in order', () => {
    const pts: MarkerPos[] = Array.from({ length: 10 }, (_, i) => ({ left: 50 + (i % 2), bottom: 50 }));
    const out = spreadMarkers(pts, { w: W, h: H });
    expect(out).toHaveLength(10);
    expect(out.every((p) => Number.isFinite(p.left) && Number.isFinite(p.bottom))).toBe(true);
  });

  it('does nothing when the field has not been measured yet', () => {
    // Before the first layout pass the marker size in percent is 0; positions must pass through
    // untouched rather than collapsing to the centre.
    const pts: MarkerPos[] = [
      { left: 50, bottom: 50 },
      { left: 50, bottom: 50 },
    ];
    expect(spreadMarkers(pts, { w: 0, h: 0 })).toEqual(pts);
  });

  it('gives up honestly rather than misplacing a marker it cannot free', () => {
    // 40 markers on one point cannot all fit in 3 rings; the ones that cannot be freed keep their
    // true position instead of being thrown to the far side of the field.
    const pile: MarkerPos[] = Array.from({ length: 40 }, () => ({ left: 50, bottom: 50 }));
    const out = spreadMarkers(pile, { w: W, h: H });
    expect(out).toHaveLength(40);
    out.forEach((p) => {
      expect(Math.abs(p.left - 50)).toBeLessThanOrEqual(W * 3 + 0.01);
      expect(Math.abs(p.bottom - 50)).toBeLessThanOrEqual(H * 3 + 0.01);
    });
  });
});
