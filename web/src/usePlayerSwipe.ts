import { useRef, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';

/** How far the song must be dragged before letting go changes it. */
export const PLAYER_SWIPE_MIN_PX = 56;
/** Movement before the gesture picks an axis; below this a touch is still a tap. */
const SLOP_PX = 10;
const OUT_MS = 160;

/**
 * PLAYER-SWIPE-001 (owner, 2026-11-19): on the phone's player, swipe the song left for the next one and
 * right for the previous one. Touch (and pen) only; `touch-action: pan-y` keeps vertical scrolling, and a
 * mostly vertical drag is abandoned. The song follows the finger (resisting where there is no song to go
 * to), slides out past the threshold and snaps back otherwise. Judged where the finger lifts, since a fast
 * flick sends few moves (SWIPE-FAST-001). The click that ends a swipe is swallowed, so a swipe never also
 * opens the artist page under the finger.
 */
export function usePlayerSwipe(o: { onNext: () => void; onPrev: () => void; canNext: boolean; canPrev: boolean; enabled: boolean }) {
  const g = useRef<{ id: number; x: number; y: number; dx: number; axis: 'x' | 'y' | null; el: HTMLElement } | null>(null);
  const swallowClick = useRef(false);
  const live = useRef(o);
  live.current = o;

  const allowed = (dx: number) => (dx < 0 ? live.current.canNext : live.current.canPrev);
  const paint = (el: HTMLElement, dx: number, animate: boolean) => {
    el.style.transition = animate ? `transform ${OUT_MS}ms ease, opacity ${OUT_MS}ms ease` : 'none';
    el.style.transform = dx ? `translateX(${dx}px)` : '';
    el.style.opacity = dx ? String(Math.max(0.35, 1 - Math.abs(dx) / Math.max(el.offsetWidth || 320, 1))) : '';
  };

  const end = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    g.current = null;
    if (!cancelled && Number.isFinite(e.clientX)) {
      const dx = e.clientX - s.x;
      const dy = (Number.isFinite(e.clientY) ? e.clientY : s.y) - s.y;
      if (!s.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= SLOP_PX) s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.axis === 'x') s.dx = dx;
    }
    if (s.axis !== 'x') return;
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, 400);
    const go = !cancelled && Math.abs(s.dx) >= PLAYER_SWIPE_MIN_PX && allowed(s.dx);
    if (!go) { paint(s.el, 0, true); return; }
    const dir = s.dx < 0 ? -1 : 1;
    paint(s.el, dir * Math.max(s.el.offsetWidth || 0, 160), true);
    // The song changes now; the strip slides back in with the new one.
    if (dir < 0) live.current.onNext(); else live.current.onPrev();
    const el = s.el;
    window.setTimeout(() => { paint(el, -dir * 24, false); requestAnimationFrame(() => paint(el, 0, true)); }, OUT_MS);
  };

  return {
    'data-swipe': 'player',
    style: { touchAction: 'pan-y' } as CSSProperties,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!live.current.enabled) return;
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      if (!e.isPrimary && e.isPrimary !== undefined) return;
      g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, axis: null, el: e.currentTarget };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = g.current;
      if (!s || s.id !== e.pointerId) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.axis) {
        if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
        s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (s.axis === 'y') { g.current = null; return; }
        try { s.el.setPointerCapture?.(e.pointerId); } catch { /* the pointer already left */ }
      }
      s.dx = dx;
      // Where there is no song to go to, the strip only gives a little.
      paint(s.el, allowed(dx) ? dx : dx / 4, false);
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => end(e, false),
    onPointerCancel: (e: PointerEvent<HTMLElement>) => end(e, true),
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
