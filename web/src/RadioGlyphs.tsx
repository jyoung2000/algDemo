/**
 * RADIO-UI-011: the radio refresh arrow. The owner said the half-circle arrow that replaced the old
 * near-full ring "still needs revising and fixing". It is now one clockwise arc of 295° (radius 7.5,
 * centred on the ring at 12.4,12.8) whose arrowhead's tip IS the arc's end point, so the head and the
 * arc meet in a single round-joined corner with no gap or overlap. The head's arms are 4.2 units long
 * and sit at 45° either side of the arc's tangent there.
 *
 * Same conventions as the app's other line icons (icons.tsx): 24-unit grid, stroke 2, round caps and
 * joins, currentColor. The ring centre is offset up-right of 12,12 so that the drawing's ink (the ring
 * plus the head poking out at the top right) has its centroid at 11.95,11.92: optically centred.
 *
 * While refreshing it spins around the ring centre, not the box centre, so the ring stays still and
 * only the gap and head travel: RADIO_REFRESH_ORIGIN is that centre as a fraction of the box.
 */
export const RADIO_REFRESH_RING = { cx: 12.4, cy: 12.8, r: 7.5, sweep: 295 } as const;
export const RADIO_REFRESH_PATHS = [
  'M19.2 15.97A7.5 7.5 0 1 1 18.15 7.98',
  'M18.51 3.8L18.15 7.98L13.96 7.61',
] as const;
/** CSS transform-origin for the spin: the ring centre on the 24-unit grid, as box percentages. */
export const RADIO_REFRESH_ORIGIN = '51.667% 53.333%';

export function RadioRefreshGlyph({ size = 16, className = 'radio-refresh__icon' }: { size?: number; className?: string }) {
  return (
    <svg className={`glyph glyph--stroke ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ transformOrigin: RADIO_REFRESH_ORIGIN }}>
      {RADIO_REFRESH_PATHS.map(d => <path key={d} d={d} />)}
    </svg>
  );
}
