// @vitest-environment happy-dom
// TASTE-SPIN-002 (owner, 2026-11-20): "the semi circle in the learned label is not a full semi circle, make it a full
// semi circle". The arc's right end was hidden under the arrowhead, which reached up above the diameter, so the
// visible stroke read as a little over a quarter. The arc is now an exact half circle and the arrowhead hangs below
// its right end, pointing the way it turns, without covering any of it.
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { TasteSpinner } from './TasteSpinner';

const nums = (d: string) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);

describe('the taste spinner is a full half circle', () => {
  const { container } = render(createElement(TasteSpinner, { playing: false, songs: 0 }));
  const arc = container.querySelector('path.taste-spin__arc')!.getAttribute('d')!;
  const head = container.querySelector('path.taste-spin__head')!.getAttribute('d')!;
  it('the arc runs from one end of a diameter to the other (180 degrees), centred in the icon', () => {
    const m = arc.match(/^M\s*([\d.]+)[ ,]([\d.]+)\s*A\s*([\d.]+)[ ,]([\d.]+)\s+0\s+0\s+1\s+([\d.]+)[ ,]([\d.]+)$/);
    expect(m, arc).not.toBeNull();
    const [x0, y0, rx, ry, x1, y1] = m!.slice(1).map(Number) as [number, number, number, number, number, number];
    expect(rx).toBe(ry);
    expect(y1).toBe(y0);
    expect(x1 - x0).toBeCloseTo(2 * rx, 5);
    expect((x0 + x1) / 2).toBe(8);
    expect(y0).toBe(8); // turns about its own centre
  });
  it('the arrowhead sits below the diameter, so none of the arc is covered', () => {
    const p = nums(head.replace(/^M/, ''));
    const ys = p.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(8);
    const xs = p.filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(16);
    expect(Math.max(...ys)).toBeLessThanOrEqual(16);
  });
});
