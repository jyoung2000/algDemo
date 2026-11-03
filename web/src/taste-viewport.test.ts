// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TastePicker } from './TastePicker';
import { AUTO_FIT_DELAY, AUTO_FIT_DURATION, FULL_VIEW, WHEEL_STEP, ZOOM_MAX, ZOOM_MIN, fitTaste, panTaste, pointAt, projectPoint, revealPoint, selectionInView, tweenView, viewportBackground, zoomAt, zoomTaste } from './taste-viewport';

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

  /**
   * TASTE-MAP-PAN-ZOOM, at the component. The owner asked for desktop wheel-zoom and mouse-1 pan.
   * A click must still pick a genre, or the field loses its original purpose.
   */
  const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
    fireEvent(field(), Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra,
    }));
  const bgPos = () => field().style.backgroundPosition;
  // The field's label carries BOTH the visible spectrum and the selection. Panning is supposed to
  // change the former, so only the latter can witness "the selection did not move".
  const selection = () => /Selected [^.]+\./.exec(field().getAttribute('aria-label') ?? '')?.[0] ?? '';

  const fieldRect = () => {
    // jsdom gives every element a zero rect, and the handlers bail out on one, so the field is
    // given a real size for these cases.
    field().getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  };

  it('a mouse drag pans the map and does not change the selection', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    fieldRect();
    const zoomBefore = backgroundZoom();
    const pickedBefore = selection();
    const posBefore = bgPos();

    mouse('pointerdown', 200, 150);
    mouse('pointermove', 260, 150);
    mouse('pointerup', 260, 150);

    expect(bgPos(), 'the view moved').not.toBe(posBefore);
    expect(backgroundZoom(), 'zoom is preserved while panning').toBeCloseTo(zoomBefore, 6);
    expect(selection(), 'a drag must not pick a genre').toBe(pickedBefore);
  });

  it('dragging up moves the map up, not down', () => {
    // The screen's y grows downward while the map's grows with BPM; getting this backwards makes
    // the map fight the hand vertically while behaving correctly horizontally.
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    fieldRect();
    const yOf = () => Number.parseFloat(field().style.backgroundPosition.split(' ')[1] ?? '0');
    const before = yOf();
    // Pointer moves UP the screen (smaller clientY) => reveals higher BPM => background-position
    // is measured from the TOP, so it must move the opposite way to a downward drag.
    mouse('pointerdown', 200, 200);
    mouse('pointermove', 200, 140);
    mouse('pointerup', 200, 140);
    const afterUp = yOf();
    expect(afterUp, 'the view moved vertically').not.toBeCloseTo(before, 6);
    // ABSOLUTE direction, not just "the two drags differ": dragging up carries the content up with
    // the hand, revealing LOWER BPM, so the view's y falls. background-position is measured from
    // the top as (1 - y - size) / (1 - size), so a falling y shows as a RISING percentage.
    // Comparing the two drags to each other would pass even with the sign flipped on both.
    expect(afterUp).toBeGreaterThan(before);

    mouse('pointerdown', 200, 140);
    mouse('pointermove', 200, 200);
    mouse('pointerup', 200, 200);
    expect(yOf(), 'dragging back down reverses it').toBeLessThan(afterUp);
  });

  it('a mouse click still picks a genre', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    fieldRect();
    const pickedBefore = selection();
    // Down and up at the same place, well away from the current selection.
    mouse('pointerdown', 40, 260);
    mouse('pointerup', 40, 260);
    expect(selection()).not.toBe(pickedBefore);
  });

  it('a tiny wobble during a click is still a click, not a pan', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    fieldRect();
    const pickedBefore = selection();
    const posBefore = bgPos();
    mouse('pointerdown', 120, 120);
    mouse('pointermove', 121, 121);
    mouse('pointerup', 121, 121);
    expect(bgPos(), 'a 1px wobble must not pan').toBe(posBefore);
    expect(selection(), 'it selects instead').not.toBe(pickedBefore);
  });

  it('the wheel zooms in and out', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    fieldRect();
    const start = backgroundZoom();
    act(() => { field().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 200, clientY: 150 })); });
    const zoomedIn = backgroundZoom();
    expect(zoomedIn).toBeGreaterThan(start);
    act(() => { field().dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, clientX: 200, clientY: 150 })); });
    expect(backgroundZoom()).toBeLessThan(zoomedIn);
  });

  it('the wheel listener is non-passive, so the page does not scroll away', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    fieldRect();
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 200, clientY: 150 });
    act(() => { field().dispatchEvent(ev); });
    // React registers wheel at the root as passive; this must be a native { passive: false }
    // listener or preventDefault is ignored and the page scrolls under the zoom.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('a touch drag still picks, as it does on the phone', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    fieldRect();
    const pickedBefore = selection();
    const touch = (type: string, x: number, y: number) =>
      fireEvent(field(), Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), {
        pointerId: 7, pointerType: 'touch', isPrimary: true,
      }));
    touch('pointerdown', 60, 240);
    expect(selection(), 'touch selects on contact').not.toBe(pickedBefore);
  });


  /** GENRE-COLOUR-001 at the component: the name carries the genre's colour, and a dot shows it. */
  it('shows a colour dot beside the genre name and tints the name to match', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    const title = document.querySelector('.tpick__title') as HTMLElement;
    const swatch = title.querySelector('.tpick__swatch') as HTMLElement;
    expect(swatch, 'a colour dot sits next to the title').not.toBeNull();
    expect(swatch.style.background, 'the dot is painted').not.toBe('');
    expect(title.style.color, 'the name is tinted').not.toBe('');
    // The dot is decoration; the name already says which genre it is.
    expect(swatch.getAttribute('aria-hidden')).toBe('true');
  });

  it('the colour changes when a different genre is selected', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    const title = () => document.querySelector('.tpick__title') as HTMLElement;
    const swatch = () => document.querySelector('.tpick__swatch') as HTMLElement;
    const before = { ink: title().style.color, dot: swatch().style.background };
    // Jump to a genre in a different family, which means a different hue.
    const buttons = screen.getAllByRole('button');
    const other = buttons.find((b) => /Tech.house/i.test(b.textContent ?? ''));
    expect(other, 'a genre button to jump to').toBeTruthy();
    fireEvent.click(other!);
    expect(title().style.color, 'the name re-tints').not.toBe(before.ink);
    expect(swatch().style.background, 'the dot follows').not.toBe(before.dot);
  });

  it('the genre name stays readable, never painted in the map’s pale fill', () => {
    render(createElement(TastePicker, { placed: taste }));
    advance(AUTO_FIT_DELAY + AUTO_FIT_DURATION + 100);
    const title = document.querySelector('.tpick__title') as HTMLElement;
    const m = /hsl\((\d+)\s+(\d+)%\s+(\d+)%\)/.exec(title.style.color);
    expect(m, `title colour was ${title.style.color}`).not.toBeNull();
    // The field's fill is 62% lightness; as text on the white panel that fails contrast outright.
    expect(Number(m![3])).toBeLessThan(62);
  });

  it('cleans up scheduled work on unmount', () => {
    const r = render(createElement(TastePicker, { placed: taste }));
    r.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * TASTE-MAP-PAN-ZOOM. On a desktop the wheel zooms about the cursor and mouse-1 drags the map.
 * Both are pure viewport maths here; the component wiring is covered in the behaviour block.
 */
describe('panning and cursor-anchored zoom', () => {
  const at2x = zoomAt(FULL_VIEW, 2, 0.5, 0.5);

  it('zooming about a point keeps that point under the cursor', () => {
    // Whatever sits 25% across and 75% up must still be there after zooming in.
    const before = pointAt(FULL_VIEW, 0.25, 0.75);
    const after = pointAt(zoomAt(FULL_VIEW, 2, 0.25, 0.75), 0.25, 0.75);
    expect(after.hue).toBeCloseTo(before.hue, 6);
    expect(after.bpm).toBeCloseTo(before.bpm, 6);
  });

  it('holds the anchor at several zoom levels and positions', () => {
    for (const [z, fx, fy] of [[1.5, 0.1, 0.1], [3, 0.8, 0.2], [4, 0.5, 0.9]] as const) {
      const before = pointAt(FULL_VIEW, fx, fy);
      const after = pointAt(zoomAt(FULL_VIEW, z, fx, fy), fx, fy);
      // Near an edge the view clamps, so the anchor can only be held where there is room.
      const v = zoomAt(FULL_VIEW, z, fx, fy);
      const clamped = v.x === 0 || v.y === 0 || v.x === 1 - v.size || v.y === 1 - v.size;
      if (!clamped) {
        expect(after.hue).toBeCloseTo(before.hue, 6);
        expect(after.bpm).toBeCloseTo(before.bpm, 6);
      }
    }
  });

  it('does not re-centre the way zoomTaste does', () => {
    // The distinction that makes a wheel feel right: zoomTaste pulls the anchor to the middle.
    const anchor = pointAt(FULL_VIEW, 0.2, 0.2);
    const recentred = zoomTaste(FULL_VIEW, 2, anchor);
    const anchored = zoomAt(FULL_VIEW, 2, 0.2, 0.2);
    expect(anchored.x).not.toBeCloseTo(recentred.x, 3);
  });

  it('never zooms outside its own range, whatever it is handed', () => {
    for (const z of [0, -5, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = zoomAt(FULL_VIEW, z as number, 0.5, 0.5);
      expect(v.size).toBeLessThanOrEqual(1 / ZOOM_MIN);
      expect(v.size).toBeGreaterThanOrEqual(1 / ZOOM_MAX);
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
    }
  });

  it('stays inside the map when zooming at a corner', () => {
    for (const [fx, fy] of [[0, 0], [1, 1], [0, 1], [1, 0]] as const) {
      const v = zoomAt(FULL_VIEW, 3, fx, fy);
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.x + v.size).toBeLessThanOrEqual(1 + 1e-9);
      expect(v.y + v.size).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('pans the content with the hand, not against it', () => {
    // Dragging RIGHT should reveal what lay off to the left, so the origin moves left.
    const moved = panTaste(at2x, 0.2, 0);
    expect(moved.x).toBeLessThan(at2x.x);
    const up = panTaste(at2x, 0, 0.2);
    expect(up.y).toBeLessThan(at2x.y);
  });

  it('pans by the dragged fraction of the visible span', () => {
    // Half a field-width at 2x (size 0.5) is 0.25 of the whole map.
    const moved = panTaste(at2x, -0.5, 0);
    expect(moved.x).toBeCloseTo(at2x.x + 0.25, 6);
  });

  it('keeps the zoom level while panning', () => {
    expect(panTaste(at2x, 0.3, -0.2).size).toBe(at2x.size);
  });

  it('cannot be dragged off the edge of the map', () => {
    const far = panTaste(at2x, -99, -99);
    expect(far.x + far.size).toBeCloseTo(1, 6);
    expect(far.y + far.size).toBeCloseTo(1, 6);
    const other = panTaste(at2x, 99, 99);
    expect(other.x).toBe(0);
    expect(other.y).toBe(0);
  });

  it('does nothing at all when the whole map is already visible', () => {
    // At 1x there is no hidden content, so a drag must not shift anything. Asserting on the
    // RETURNED VALUE alone is not enough -- clamping would also hold it at 0 -- so this checks the
    // view is handed back untouched for a drag in the direction that has room to move.
    expect(panTaste(FULL_VIEW, 0.4, 0.4)).toEqual(FULL_VIEW);
    expect(panTaste(FULL_VIEW, -0.4, -0.4)).toEqual(FULL_VIEW);
    expect(panTaste(FULL_VIEW, -0.4, -0.4)).toBe(FULL_VIEW);
  });

  it('a drag moves further when zoomed IN, because the span is smaller', () => {
    // Panning is in view-fractions, so the same gesture must cover less of the map at higher zoom.
    const near = zoomAt(FULL_VIEW, 4, 0.5, 0.5);
    const far = zoomAt(FULL_VIEW, 2, 0.5, 0.5);
    const dNear = Math.abs(panTaste(near, -0.25, 0).x - near.x);
    const dFar = Math.abs(panTaste(far, -0.25, 0).x - far.x);
    expect(dNear).toBeGreaterThan(0);
    expect(dNear).toBeLessThan(dFar);
    // Exactly a quarter of the visible span, not a quarter of the whole map.
    expect(dNear).toBeCloseTo(0.25 * near.size, 6);
    expect(dFar).toBeCloseTo(0.25 * far.size, 6);
  });

  it('zooming out from a corner of an ALREADY panned view stays on the map', () => {
    // Starting from FULL_VIEW the arithmetic lands in bounds on its own (x = fx * (1 - size)), so
    // only a view that is already parked against an edge exercises the clamp at all.
    const parked = { x: 0.75, y: 0.75, size: 0.25 };
    for (const z of [1, 1.5, 2, 3]) {
      for (const [fx, fy] of [[0, 0], [0.1, 0.1], [1, 1]] as const) {
        const v = zoomAt(parked, z, fx, fy);
        expect(v.x, `z=${z} fx=${fx}`).toBeGreaterThanOrEqual(-1e-9);
        expect(v.y, `z=${z} fy=${fy}`).toBeGreaterThanOrEqual(-1e-9);
        expect(v.x + v.size, `z=${z} fx=${fx}`).toBeLessThanOrEqual(1 + 1e-9);
        expect(v.y + v.size, `z=${z} fy=${fy}`).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('zooming at the very corner cannot push the view off the map', () => {
    // Without clamping, anchoring at (1,1) leaves x = 1 - size*1 ... which looks fine at 3x but
    // not at every zoom; these check the invariant directly rather than one lucky case.
    for (const z of [1.2, 2, 2.7, 3.5, 4]) {
      for (const [fx, fy] of [[0, 0], [1, 1], [1, 0], [0, 1], [0.97, 0.03]] as const) {
        const v = zoomAt(FULL_VIEW, z, fx, fy);
        expect(v.x, `z=${z} fx=${fx}`).toBeGreaterThanOrEqual(-1e-9);
        expect(v.y, `z=${z} fy=${fy}`).toBeGreaterThanOrEqual(-1e-9);
        expect(v.x + v.size).toBeLessThanOrEqual(1 + 1e-9);
        expect(v.y + v.size).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('survives a nonsense drag instead of corrupting the view', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = panTaste(at2x, bad, bad);
      expect(Number.isFinite(v.x)).toBe(true);
      expect(Number.isFinite(v.y)).toBe(true);
    }
  });

  it('a wheel notch is small enough to feel continuous', () => {
    expect(WHEEL_STEP).toBeGreaterThan(0);
    expect(WHEEL_STEP).toBeLessThan(0.5);
    // Several notches must actually reach full zoom rather than stalling short of it.
    let z = ZOOM_MIN;
    for (let i = 0; i < 40; i += 1) z = Math.min(ZOOM_MAX, z + WHEEL_STEP);
    expect(z).toBe(ZOOM_MAX);
  });
});
