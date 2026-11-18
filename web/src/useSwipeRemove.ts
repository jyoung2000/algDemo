import './swipe.css';
import { createElement, useRef, type CSSProperties, type LiHTMLAttributes, type MouseEvent, type PointerEvent, type Ref } from 'react';

/** How far a row must travel before letting go removes it. */
export const SWIPE_MIN_PX = 80;
const SWIPE_FRACTION = 0.35;
/** Movement before the gesture picks an axis; below this a touch is still a tap. */
const SLOP_PX = 10;
const OUT_MS = 180;

/**
 * SWIPE-REMOVE-001: a horizontal touch swipe on a list row removes it, as the row's X button does.
 *
 * Touch (and pen) only: a desktop mouse drag selects text and keeps the explicit X button. Rows use
 * `touch-action: pan-y`, so the browser still scrolls vertically while horizontal movement reaches
 * these handlers; a drag that is mostly vertical is abandoned at once. The row follows the finger,
 * slides out past the threshold and snaps back otherwise. A click that ends a swipe is swallowed,
 * so a swipe never also plays the song or presses a button under the finger.
 */
export function useSwipeRemove(onRemove?: (() => void) | undefined, onSwipeLeft?: (() => void) | undefined) {
  const g = useRef<{ id: number; x: number; y: number; dx: number; axis: 'x' | 'y' | null; el: HTMLElement } | null>(null);
  const swallowClick = useRef(false);

  const paint = (el: HTMLElement, dx: number, animate: boolean) => {
    el.style.transition = animate ? `transform ${OUT_MS}ms ease, opacity ${OUT_MS}ms ease` : 'none';
    el.style.transform = dx ? `translateX(${dx}px)` : '';
    el.style.opacity = dx ? String(Math.max(0.25, 1 - Math.abs(dx) / Math.max(el.offsetWidth || 320, 1))) : '';
  };

  const end = (e: PointerEvent<HTMLElement>, cancelled: boolean) => {
    const s = g.current;
    if (!s || s.id !== e.pointerId) return;
    g.current = null;
    // SWIPE-FAST-001: a fast flick sends few moves, so judge it where the finger lifted, not at the last
    // move; a flick whose axis was never settled by a move is settled by the lift.
    if (!cancelled && Number.isFinite(e.clientX)) {
      const dx = e.clientX - s.x;
      const dy = (Number.isFinite(e.clientY) ? e.clientY : s.y) - s.y;
      if (!s.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= SLOP_PX) s.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (s.axis === 'x') s.dx = dx;
    }
    if (s.axis !== 'x') return;
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, 400);
    const width = s.el.offsetWidth || 0;
    const threshold = Math.max(SWIPE_MIN_PX, width * SWIPE_FRACTION);
    s.el.removeAttribute('data-swipe-dir');
    const far = !cancelled && Math.abs(s.dx) >= threshold;
    // SWIPE-DIR-001: right removes (slides out); left saves to a list (snaps back, menu opens).
    if (far && s.dx > 0 && onRemove) {
      paint(s.el, Math.max(width, 320), true);
      window.setTimeout(() => { paint(s.el, 0, false); onRemove(); }, OUT_MS);
    } else {
      paint(s.el, 0, true);
      if (far && s.dx < 0 && onSwipeLeft) onSwipeLeft();
    }
  };

  return {
    'data-swipe': onRemove ? 'remove' : 'save',
    style: { touchAction: 'pan-y' } as CSSProperties,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
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
      s.el.setAttribute('data-swipe-dir', dx < 0 ? 'save' : 'remove');
      paint(s.el, dx, false);
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

/** A list row a touch swipe removes (SWIPE-REMOVE-001). Takes every ordinary <li> prop. */
export function SwipeLi({ onRemove, onSwipeLeft, style, children, ref, ...li }: LiHTMLAttributes<HTMLLIElement> & { onRemove?: (() => void) | undefined; onSwipeLeft?: (() => void) | undefined; ref?: Ref<HTMLLIElement> }) {
  const swipe = useSwipeRemove(onRemove, onSwipeLeft);
  // React 19 passes ref as a prop to function components; hand it to the real <li>.
  return createElement('li', { ...li, ...swipe, ref, style: { ...style, ...swipe.style } }, children);
}
