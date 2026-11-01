import { useRef } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';

interface Props {
  onStep: (dir: 1 | -1) => void;
  onSelect: () => void;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onPlayPause: () => void;
  canPlay: boolean;
}

/** Degrees of rotation per focus step. */
const STEP_DEG = 24;

/**
 * An optional click-wheel. Dragging round the ring moves the focused song in the queue; the centre
 * plays it. Every action here is also an ordinary button, row click or key, so the wheel is never the
 * only way to do anything. The ring itself is a slider for keyboard and screen-reader users.
 */
export function Wheel({ onStep, onSelect, onMenu, onPrev, onNext, onPlayPause, canPlay }: Props) {
  const ring = useRef<HTMLDivElement>(null);
  const drag = useRef<{ angle: number; acc: number; id: number } | null>(null);

  const angleOf = (e: React.PointerEvent) => {
    const r = ring.current!.getBoundingClientRect();
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
  };

  return (
    <div className="wheel" aria-label="Click wheel">
      <div
        ref={ring}
        className="wheel__ring"
        role="slider"
        tabIndex={0}
        aria-label="Scroll the queue: turn clockwise for the next song"
        aria-valuetext="Moves the highlighted song"
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            onStep(1);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            onStep(-1);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { angle: angleOf(e), acc: 0, id: e.pointerId };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const a = angleOf(e);
          let delta = a - d.angle;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          d.angle = a;
          d.acc += delta;
          while (Math.abs(d.acc) >= STEP_DEG) {
            const dir = d.acc > 0 ? 1 : -1;
            onStep(dir);
            d.acc -= dir * STEP_DEG;
          }
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <button className="wheel__btn wheel__btn--menu" type="button" onClick={onMenu} tabIndex={-1} aria-label="Back to search">
          MENU
        </button>
        <button className="wheel__btn wheel__btn--prev" type="button" onClick={onPrev} tabIndex={-1} aria-label="Previous song">
          <Glyph name="previous" size={13} />
        </button>
        <button className="wheel__btn wheel__btn--next" type="button" onClick={onNext} tabIndex={-1} aria-label="Next song">
          <Glyph name="next" size={13} />
        </button>
        <button className="wheel__btn wheel__btn--play" type="button" onClick={onPlayPause} disabled={!canPlay} tabIndex={-1} aria-label="Play or pause">
          <Glyph name="play" size={10} />
          <Glyph name="pause" size={10} />
        </button>
        <button className="wheel__centre" type="button" onClick={onSelect} tabIndex={-1} aria-label="Play the highlighted song" />
      </div>
    </div>
  );
}
