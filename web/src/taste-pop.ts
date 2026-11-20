/** TASTE-MAP-POP-001: where the song card goes, in viewport pixels. */
export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface PopPlace { x: number; y: number; w: number; side: 'right' | 'left' | 'below' | 'above' }

const GAP = 8, EDGE = 8;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Beside the cover (right, then left) when the card fits; otherwise below it (above near the bottom). Always on screen. */
export function placePop(cover: Box, size: { w: number; h: number }, view: { w: number; h: number }): PopPlace {
  const w = Math.min(size.w, view.w - EDGE * 2), h = size.h;
  const yBeside = clamp(cover.top + cover.height / 2 - h / 2, EDGE, view.h - EDGE - h);
  if (cover.right + GAP + w <= view.w - EDGE) return { x: cover.right + GAP, y: yBeside, w, side: 'right' };
  if (cover.left - GAP - w >= EDGE) return { x: cover.left - GAP - w, y: yBeside, w, side: 'left' };
  const x = clamp(cover.left + cover.width / 2 - w / 2, EDGE, view.w - EDGE - w);
  if (cover.bottom + GAP + h <= view.h - EDGE) return { x, y: cover.bottom + GAP, w, side: 'below' };
  return { x, y: clamp(cover.top - GAP - h, EDGE, view.h - EDGE - h), w, side: 'above' };
}
