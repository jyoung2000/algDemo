import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RepeatGlyph, REPEAT_ARCS, REPEAT_HEADS, REPEAT_MARKS } from './icons';

/**
 * REPEAT-COUNT-001 (owner, 2026-11-18): "the repeat song icon has the arrows too close together
 * and you cant even tell its 2 arrows in a circle". The picture is measured, not eyeballed: two
 * arcs, two solid heads on opposite sides, real gaps between them, and a clear centre for the
 * count. The count is drawn as paths, so every platform shows the same shapes.
 */
const C = 12;
const deg = (x: number, y: number) => (Math.atan2(y - C, x - C) * 180) / Math.PI;
const radius = (x: number, y: number) => Math.hypot(x - C, y - C);
const turn = (from: number, to: number) => (((to - from) % 360) + 360) % 360; // clockwise on screen
const nums = (d: string) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);

const arcs = REPEAT_ARCS.map((d) => {
  const n = nums(d); // M x y A r r 0 0 1 x y
  return { r: n[2]!, from: deg(n[0]!, n[1]!), to: deg(n[7]!, n[8]!) };
});
const heads = REPEAT_HEADS.map((d) => {
  const [ox, oy, tx, ty, ix, iy] = nums(d) as [number, number, number, number, number, number];
  return { base: Math.hypot(ox - ix, oy - iy), baseAt: deg((ox + ix) / 2, (oy + iy) / 2), tipAt: deg(tx, ty), inner: radius(ix, iy), outer: radius(ox, oy), pts: [[ox, oy], [tx, ty], [ix, iy]] };
});

describe('repeat-song icon', () => {
  it('is two arrows: two arcs, each ending in its own solid head, on opposite sides', () => {
    expect(arcs).toHaveLength(2);
    expect(heads).toHaveLength(2);
    for (const [i, a] of arcs.entries()) {
      const sweep = turn(a.from, a.to);
      expect(sweep, 'each arrow is a third of the circle, not a full ring').toBeGreaterThanOrEqual(100);
      expect(sweep).toBeLessThanOrEqual(125);
      expect(turn(a.to, heads[i]!.baseAt), 'the head sits on the end of its own arc').toBeLessThan(1);
      expect(turn(a.to, heads[i]!.tipAt), 'and points onward, clockwise').toBeGreaterThan(15);
    }
    expect(turn(heads[0]!.tipAt, heads[1]!.tipAt), 'heads half a turn apart').toBeCloseTo(180, 0);
  });

  it('leaves a real gap after each head before the other arrow begins', () => {
    for (const [i, h] of heads.entries()) {
      const gap = turn(h.tipAt, arcs[(i + 1) % 2]!.from);
      expect(gap, 'at 22 px, 35 degrees of an 8.6 radius ring is about 5 px of clear space').toBeGreaterThanOrEqual(35);
    }
  });

  it('draws heads big enough to read as arrowheads at the size the player uses', () => {
    for (const h of heads) {
      expect((h.base * 22) / 24, 'px across the head at 22 px').toBeGreaterThanOrEqual(4.5);
      expect(h.outer, 'inside the 24-unit box').toBeLessThanOrEqual(11.5);
    }
    const html = renderToStaticMarkup(<RepeatGlyph mode="off" size={22} />);
    expect(html.match(/fill="currentColor"/g), 'both heads are filled, not hairline chevrons').toHaveLength(2);
  });

  it('keeps the count clear of the arrows', () => {
    const headPts = heads.flatMap((h) => h.pts);
    for (const [mode, paths] of Object.entries(REPEAT_MARKS)) {
      const n = paths.flatMap(nums);
      const pts = n.flatMap((v, i) => (i % 2 === 0 ? [[v, n[i + 1]!] as [number, number]] : []));
      for (const [x, y] of pts) {
        expect(radius(x, y), `${mode}: inside the ring`).toBeLessThanOrEqual(5.6);
        for (const [hx, hy] of headPts) expect(Math.hypot(x - hx!, y - hy!), `${mode}: clear of a head`).toBeGreaterThanOrEqual(1.8);
      }
    }
  });

  it('shows nothing, 1, 2 or the infinity symbol in the centre', () => {
    const count = (mode: Parameters<typeof RepeatGlyph>[0]['mode']) => renderToStaticMarkup(<RepeatGlyph mode={mode} size={22} />);
    for (const mode of ['off', 'all'] as const) expect(count(mode).match(/<path/g)).toHaveLength(4);
    expect(count('once')).toContain(`d="${REPEAT_MARKS.once[0]}"`);
    expect(count('twice')).toContain(`d="${REPEAT_MARKS.twice[0]}"`);
    expect(count('one')).toContain(`d="${REPEAT_MARKS.one[0]}"`);
    // A lemniscate: one closed curve through the centre, wider than tall, the same on both sides.
    const inf = nums(REPEAT_MARKS.one[0]);
    const xs = inf.filter((_, i) => i % 2 === 0); const ys = inf.filter((_, i) => i % 2 === 1);
    expect(REPEAT_MARKS.one[0].endsWith('Z')).toBe(true);
    expect(Math.max(...xs) - C).toBeCloseTo(C - Math.min(...xs), 5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2 * (Math.max(...ys) - Math.min(...ys)) - 1);
    expect(count('one')).not.toContain('<text'); // no font: the same symbol on every platform
  });

  it('is the same drawing in the car: the Android Auto icons use these exact paths', () => {
    const res = resolve(__dirname, '../../android/app/src/main/res/drawable');
    const paths = (name: string) => [...readFileSync(resolve(res, name), 'utf8').matchAll(/android:pathData="([^"]+)"/g)].map((m) => m[1]);
    const ring = [...REPEAT_ARCS, ...REPEAT_HEADS];
    expect(paths('car_repeat_off.xml')).toEqual(ring);
    expect(paths('car_repeat_once.xml')).toEqual([...ring, ...REPEAT_MARKS.once]);
    expect(paths('car_repeat_twice.xml')).toEqual([...ring, ...REPEAT_MARKS.twice]);
    expect(paths('car_repeat_infinite.xml')).toEqual([...ring, ...REPEAT_MARKS.one]);
  });
});
