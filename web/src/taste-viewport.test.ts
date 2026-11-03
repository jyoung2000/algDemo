// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TastePicker } from './TastePicker';
import { AUTO_FIT_DELAY, AUTO_FIT_DURATION, FULL_VIEW, fitTaste, pointAt, projectPoint, revealPoint, selectionInView, tweenView, viewportBackground, zoomTaste } from './taste-viewport';

const taste = [{ hue: 72, bpm: 85, label: 'A' }, { hue: 108, bpm: 103, label: 'B' }];
const closeView = (v: typeof FULL_VIEW, wanted: typeof FULL_VIEW) => {
  expect(v.x).toBeCloseTo(wanted.x); expect(v.y).toBeCloseTo(wanted.y); expect(v.size).toBeCloseTo(wanted.size);
};
describe('taste viewport geometry', () => {
  it('starts full and rejects missing/non-real points', () => {
    expect(fitTaste([])).toEqual(FULL_VIEW);
    expect(fitTaste([{ hue: NaN, bpm: 100 }, { hue: 100, bpm: 230 }])).toEqual(FULL_VIEW);
    expect(pointAt(FULL_VIEW, 0, 0)).toEqual({ hue: 0, bpm: 40 });
    expect(pointAt(FULL_VIEW, 1, 1)).toEqual({ hue: 360, bpm: 220 });
  });
  it('fits both dimensions with 15 percent per-side padding', () => {
    const v = fitTaste([{ hue: 72, bpm: 112 }, { hue: 252, bpm: 130 }]);
    closeView(v, { x: .125, y: .125, size: .65 });
    expect(projectPoint(v, { hue: 72, bpm: 112 }).left).toBeCloseTo(100 * .075 / .65);
    expect(fitTaste(taste).size).toBe(1 / 3);
  });
  it('bounds edge clusters without wrapping genre across the seam', () => {
    for (const p of [{ hue: 0, bpm: 40 }, { hue: 360, bpm: 220 }]) {
      const v = fitTaste([p]);
      expect(v.size).toBe(1 / 3);
      const q = projectPoint(v, p);
      expect(q.left).toBeGreaterThanOrEqual(-1e-10); expect(q.left).toBeLessThanOrEqual(100.000001);
      expect(q.bottom).toBeGreaterThanOrEqual(-1e-10); expect(q.bottom).toBeLessThanOrEqual(100.000001);
    }
    expect(fitTaste([{ hue: 1, bpm: 100 }, { hue: 359, bpm: 100 }])).toEqual(FULL_VIEW);
  });
  it('inverts rendered positions at every zoom and clamps hit testing', () => {
    for (const z of [1, 1.5, 2, 3, 4]) {
      const v = zoomTaste(FULL_VIEW, z, { hue: 180, bpm: 130 });
      for (const x of [0, .2, .5, 1]) for (const y of [0, .3, 1]) {
        const p = pointAt(v, x, y), q = projectPoint(v, p);
        expect(q.left).toBeCloseTo(x * 100); expect(q.bottom).toBeCloseTo(y * 100);
      }
      expect(pointAt(v, -5, 7)).toEqual(pointAt(v, 0, 1));
    }
  });
  it('limits manual zoom and reveals offscreen jumps at unchanged scale', () => {
    const v = zoomTaste(FULL_VIEW, 9, { hue: 180, bpm: 130 });
    expect(v.size).toBe(.25);
    expect(zoomTaste(v, 0, { hue: 180, bpm: 130 })).toEqual(FULL_VIEW);
    const p = { hue: 340, bpm: 200 }, next = revealPoint(v, p), q = projectPoint(next, p);
    expect(next.size).toBe(v.size); expect(q.left).toBeGreaterThan(0); expect(q.left).toBeLessThan(100);
    const selected = projectPoint(next, selectionInView(next, { hue: 10, bpm: 50 }));
    expect(selected.left).toBeCloseTo(6); expect(selected.bottom).toBeCloseTo(6);
  });
  it('interpolates bounded view geometry and aligns both background axes', () => {
    const to = { x: .1, y: .2, size: .5 };
    expect(tweenView(FULL_VIEW, to, 0)).toEqual(FULL_VIEW);
    closeView(tweenView(FULL_VIEW, to, .5), { x: .05, y: .1, size: .75 });
    expect(tweenView(FULL_VIEW, to, 1)).toEqual(to);
    expect(viewportBackground(to)).toEqual({ backgroundSize: '200% 200%', backgroundPosition: '20% 60.00000000000001%' });
  });
});

let reduced = false;

beforeEach(() => {
  reduced = false;
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const field = () => screen.getByRole('img', { name: /Taste maker field/ }) as HTMLDivElement;
const backgroundZoom = () => Number.parseFloat(field().style.backgroundSize) / 100;
const dotInside = () => {
  const dot = field().querySelector<HTMLElement>('.tpick__dot')!;
  for (const n of [dot.style.left, dot.style.bottom]) { expect(parseFloat(n)).toBeGreaterThanOrEqual(0); expect(parseFloat(n)).toBeLessThanOrEqual(100); }
};
describe('TastePicker behavior', () => {
  it('shows full for 900ms, animates for 2200ms, fits placed and trail only', () => {
    render(createElement(TastePicker, { placed: taste, trail: [{ hue: 144, bpm: 130, label: 'played' }] }));
    expect(backgroundZoom()).toBe(1); advance(AUTO_FIT_DELAY - 1); expect(backgroundZoom()).toBe(1);
    advance(1101); expect(backgroundZoom()).toBeGreaterThan(1); expect(backgroundZoom()).toBeLessThan(3); dotInside();
    advance(AUTO_FIT_DURATION);
    const v = fitTaste([...taste, { hue: 144, bpm: 130 }]);
    expect(backgroundZoom()).toBeCloseTo(1 / v.size);
    expect(parseFloat(field().querySelector<HTMLElement>('.tpick__step')!.style.bottom)).toBeCloseTo(projectPoint(v, { hue: 144, bpm: 130 }).bottom);
    dotInside();
  });

  it('plots cover art only: no genre dots and no trail lines (TASTE-MAP-ART-ONLY)', () => {
    // The owner asked for "cover art only" on the field: the coloured per-genre dots read as
    // "random dots" because nothing on the field said what they were, and the dashed line joining
    // the played songs added another mark competing with the artwork.
    render(createElement(TastePicker, { placed: taste, trail: [
      { hue: 144, bpm: 130, label: 'played one' },
      { hue: 200, bpm: 150, label: 'played two' },
    ] }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    expect(field().querySelectorAll('.tpick__placed'), 'no genre dots').toHaveLength(0);
    expect(field().querySelectorAll('.tpick__trail'), 'no trail svg').toHaveLength(0);
    expect(field().querySelectorAll('polyline'), 'no connecting line').toHaveLength(0);
    // The cover art itself stays, one marker per played song.
    expect(field().querySelectorAll('.tpick__step')).toHaveLength(2);
  });

  it('still frames the listener’s genres even though they are no longer drawn', () => {
    // Dropping the dots must not drop the genres from the viewport fit, or the field would frame
    // only the handful of recently played songs.
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    expect(backgroundZoom()).toBeCloseTo(1 / fitTaste(taste).size);
    expect((screen.getByRole('button', { name: 'My taste' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('keeps empty profiles full and disables My taste', () => {
    render(createElement(TastePicker)); advance(5000);
    expect(backgroundZoom()).toBe(1); expect((screen.getByRole('button', { name: 'My taste' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('cancels the pending fit on any manual keyboard interaction', () => {
    render(createElement(TastePicker, { placed: taste }));
    fireEvent.keyDown(field(), { key: 'ArrowLeft' }); advance(5000); expect(backgroundZoom()).toBe(1);
  });
  it('cancels an in-flight animation and Show all stays full', () => {
    render(createElement(TastePicker, { placed: taste })); advance(1500);
    fireEvent.pointerDown(field(), { button: 2 });
    const stopped = backgroundZoom(); advance(5000); expect(backgroundZoom()).toBe(stopped);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' })); advance(5000); expect(backgroundZoom()).toBe(1);
  });
  it('reduced motion stays full until manual fit; zoom controls span 1–4', () => {
    reduced = true; render(createElement(TastePicker, { placed: taste })); advance(5000); expect(backgroundZoom()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'My taste' })); expect(backgroundZoom()).toBe(3); dotInside();
    for (let i = 0; i < 10; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(backgroundZoom()).toBe(4); dotInside();
    for (let i = 0; i < 10; i++) fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(backgroundZoom()).toBe(1);
  });
  it('maps taps into the visible viewport and keeps genre jumps visible', () => {
    render(createElement(TastePicker, { placed: taste }));
    fireEvent.click(screen.getByRole('button', { name: 'My taste' }));
    const el = field();
    el.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300, height: 200 } as DOMRect);
    el.setPointerCapture = vi.fn();
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, isPrimary: true, clientX: 160, clientY: 120 });
    const expected = pointAt(fitTaste(taste), .5, .5);
    expect(el.getAttribute('aria-label')).toContain(`${Math.round(expected.bpm)} BPM`); dotInside();
    fireEvent.click(screen.getAllByRole('button', { name: /Tech.house/i })[0]!); dotInside();
    expect(backgroundZoom()).toBe(3);
  });
  it('cleans up scheduled work on unmount', () => {
    const r = render(createElement(TastePicker, { placed: taste }));
    r.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});
