// TASTE-MAP-POP-001: the song card sits beside the tapped cover, inside the screen. Measured on the phone (411px wide)
// the first version ran 21px off the right edge: a 250px card beside a cover at x=146 fits on neither side.
import { describe, expect, it } from 'vitest';
import { placePop } from './taste-pop';

const rect = (left: number, top: number, w: number, h: number) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

describe('placePop', () => {
  it('beside the cover, to the right, when it fits (Windows)', () => {
    const p = placePop(rect(297, 290, 42, 42), { w: 250, h: 176 }, { w: 1164, h: 781 });
    expect(p.side).toBe('right');
    expect(p.x).toBe(297 + 42 + 8);
    expect(p.y + 176 / 2).toBeCloseTo(290 + 21, 0); // centred on the cover
  });

  it('to the left when the right has no room', () => {
    const p = placePop(rect(900, 300, 42, 42), { w: 250, h: 120 }, { w: 1000, h: 800 });
    expect(p.side).toBe('left');
    expect(p.x + 250).toBe(900 - 8);
  });

  it('on a phone with no room either side: below the cover (above near the bottom), inside the screen', () => {
    const below = placePop(rect(125, 254, 42, 42), { w: 250, h: 126 }, { w: 411, h: 860 });
    expect(below.side).toBe('below');
    expect(below.y).toBe(254 + 42 + 8);
    expect(below.x).toBeGreaterThanOrEqual(8);
    expect(below.x + 250).toBeLessThanOrEqual(411 - 8);
    const above = placePop(rect(125, 760, 42, 42), { w: 250, h: 126 }, { w: 411, h: 860 });
    expect(above.side).toBe('above');
    expect(above.y + 126).toBe(760 - 8);
  });

  it('never wider than the screen allows and never off the top or bottom', () => {
    const p = placePop(rect(10, 5, 42, 42), { w: 250, h: 300 }, { w: 240, h: 320 });
    expect(p.w).toBe(240 - 16);
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.y + 300).toBeLessThanOrEqual(320 - 8 + 1e-9);
  });
});
