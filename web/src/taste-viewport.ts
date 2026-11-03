/** Normalized, non-wrapping genre/tempo viewport. y grows upward, like BPM. */
export interface TastePoint { hue: number; bpm: number }
export interface TasteViewport { x: number; y: number; size: number }
export const FULL_VIEW: TasteViewport = { x: 0, y: 0, size: 1 };
export const AUTO_FIT_DELAY = 900;
export const AUTO_FIT_DURATION = 2200;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const validPoint = (p: TastePoint) => Number.isFinite(p.hue) && Number.isFinite(p.bpm) && p.hue >= 0 && p.hue <= 360 && p.bpm >= 40 && p.bpm <= 220;
const xy = (p: TastePoint) => ({ x: p.hue / 360, y: (p.bpm - 40) / 180 });
function centered(x: number, y: number, size: number): TasteViewport {
  return { x: clamp(x - size / 2, 0, 1 - size), y: clamp(y - size / 2, 0, 1 - size), size };
}
/** 15% padding on each side; at most 3x, even for a singleton. Hue is NOT circular. */
export function fitTaste(points: readonly TastePoint[]): TasteViewport {
  const ps = points.filter(validPoint).map(xy);
  if (!ps.length) return { ...FULL_VIEW };
  const xs = ps.map(p => p.x), ys = ps.map(p => p.y);
  const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
  const size = clamp(Math.max(right - left, top - bottom) * 1.3, 1 / 3, 1);
  return centered((left + right) / 2, (bottom + top) / 2, size);
}
/** Percentages can intentionally be outside the field: the field clips them. */
export function projectPoint(v: TasteViewport, p: TastePoint) {
  const q = xy(p);
  return { left: (q.x - v.x) / v.size * 100, bottom: (q.y - v.y) / v.size * 100 };
}
/** Hit testing uses fractions from the LEFT and BOTTOM, not screen-top. */
export function pointAt(v: TasteViewport, left: number, bottom: number): TastePoint {
  return { hue: (v.x + clamp(left, 0, 1) * v.size) * 360, bpm: 40 + (v.y + clamp(bottom, 0, 1) * v.size) * 180 };
}
export function zoomTaste(v: TasteViewport, zoom: number, anchor: TastePoint): TasteViewport {
  const q = validPoint(anchor) ? xy(anchor) : { x: v.x + v.size / 2, y: v.y + v.size / 2 };
  const size = 1 / clamp(zoom, 1, 4);
  return centered(q.x, q.y, size);
}
/** The zoom range the controls and the wheel share: 1x (everything) to 4x. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
/** One wheel notch. Small enough that a trackpad's many small deltas still feel smooth. */
export const WHEEL_STEP = 0.18;

/**
 * Zoom about a point on the FIELD, keeping whatever is under it where it is.
 *
 * `zoomTaste` re-centres the view on its anchor, which is right for "show me this genre" but wrong
 * for a wheel: the thing under the cursor would jump to the middle. Here the fractional position
 * (left, bottom) holds its world point, so the map grows around the cursor.
 */
export function zoomAt(v: TasteViewport, zoom: number, left: number, bottom: number): TasteViewport {
  const size = 1 / clamp(Number.isFinite(zoom) ? zoom : 1, ZOOM_MIN, ZOOM_MAX);
  const fx = clamp(Number.isFinite(left) ? left : 0.5, 0, 1);
  const fy = clamp(Number.isFinite(bottom) ? bottom : 0.5, 0, 1);
  // The world point under the cursor now, which must still be under it afterwards.
  const wx = v.x + fx * v.size;
  const wy = v.y + fy * v.size;
  return { x: clamp(wx - fx * size, 0, 1 - size), y: clamp(wy - fy * size, 0, 1 - size), size };
}

/**
 * Drag the map. `dx`/`dy` are fractions of the FIELD moved by the pointer, y measured upward.
 *
 * The content follows the hand: dragging right reveals what was off to the left, so the view's
 * origin moves the opposite way. At 1x there is nowhere to go and this returns the view unchanged.
 */
export function panTaste(v: TasteViewport, dx: number, dy: number): TasteViewport {
  const ax = Number.isFinite(dx) ? dx : 0;
  const ay = Number.isFinite(dy) ? dy : 0;
  const room = 1 - v.size;
  if (room <= 0) return v;
  return { x: clamp(v.x - ax * v.size, 0, room), y: clamp(v.y - ay * v.size, 0, room), size: v.size };
}
/** Pan only when necessary, preserving zoom and leaving a small selection inset. */
export function revealPoint(v: TasteViewport, p: TastePoint): TasteViewport {
  const q = projectPoint(v, p);
  return q.left >= 6 && q.left <= 94 && q.bottom >= 6 && q.bottom <= 94 ? v : zoomTaste(v, 1 / v.size, p);
}
/** Fitting is navigation: keep the selected location inside the new visible domain. */
export function selectionInView(v: TasteViewport, p: TastePoint): TastePoint {
  const q = projectPoint(v, p);
  return pointAt(v, clamp(q.left / 100, .06, .94), clamp(q.bottom / 100, .06, .94));
}
export function tweenView(from: TasteViewport, to: TasteViewport, progress: number): TasteViewport {
  const t = clamp(progress, 0, 1), ease = t * t * (3 - 2 * t);
  return { x: from.x + (to.x - from.x) * ease, y: from.y + (to.y - from.y) * ease, size: from.size + (to.size - from.size) * ease };
}
/** CSS background-position is measured against the excess image size, not the field. */
export function viewportBackground(v: TasteViewport) {
  return { backgroundSize: `${100 / v.size}% ${100 / v.size}%`, backgroundPosition: v.size === 1 ? '0% 0%' : `${v.x / (1 - v.size) * 100}% ${(1 - v.y - v.size) / (1 - v.size) * 100}%` };
}
