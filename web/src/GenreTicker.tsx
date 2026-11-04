import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { LeafView } from './taste-view';
import { classNames } from './util';

/**
 * The "Your sound" header marquee (TICKER-MARQUEE-001).
 *
 * The owner asked for the header to scroll through the genres from most to least dominant, so this
 * is one continuous line of the whole ordered run rather than a single genre swapped on a timer.
 * `soundView()` already sorts `leaves` by share descending, so the order is taken as given and
 * never re-sorted here.
 *
 * How the scroll works: the run is rendered twice and the track is translated by exactly -50%, so
 * the moment the first copy leaves the window the second sits in precisely the same place and the
 * wrap is invisible. The pace comes from the number of genres, not a fixed duration, or the line
 * would crawl with twelve and race with two.
 *
 * It still rests: under the pointer, under focus, in a hidden tab and under reduced motion the
 * animation is PAUSED rather than removed, so the genres stay on screen and readable. And it only
 * scrolls when the run really does not fit, which is measured rather than assumed from a width.
 */
export function GenreTicker({ entries }: { entries: LeafView[] }) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [overflowing, setOverflowing] = useState(false);
  const windowRef = useRef<HTMLSpanElement>(null);
  const runRef = useRef<HTMLSpanElement>(null);
  // Remounting the track on this restarts the scroll at the strongest genre when the mix changes.
  const signature = entries.map((e) => `${e.label}:${e.pct}`).join('|');

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      media.removeEventListener('change', motion);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  // A line that fits should sit still and be read; on a wide desktop two genres fit easily.
  useEffect(() => {
    const box = windowRef.current;
    const run = runRef.current;
    if (!box || !run) return;
    const measure = () => setOverflowing(run.scrollWidth > box.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(run);
    return () => observer.disconnect();
  }, [signature]);

  if (!entries.length) return <p className="genre-ticker__empty">Still learning your sound</p>;

  const still = focused || hovered || hidden || reduced;
  // ~3.4s of travel per genre, so a label and its percentage can be read as they pass.
  const duration = `${Math.max(12, entries.length * 3.4 * 2)}s`;
  const run = (decorative: boolean) => (
    <span
      className="genre-ticker__run"
      ref={decorative ? undefined : runRef}
      {...(decorative ? { 'aria-hidden': 'true' as const } : { role: 'list' as const })}
    >
      {entries.map((e, i) => (
        <span
          className="genre-ticker__entry"
          key={`${e.label}-${i}`}
          {...(decorative ? {} : { role: 'listitem' as const })}
        >
          <i style={{ background: e.color }} aria-hidden="true" />
          <span>{e.label}</span>
          <b>{e.pct}%</b>
        </span>
      ))}
    </span>
  );

  return (
    <div
      className={classNames('genre-ticker', still && 'is-still', overflowing && 'is-scrolling')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <span className="genre-ticker__window" ref={windowRef}>
        <span
          className="genre-ticker__track"
          key={signature}
          style={{ '--ticker-duration': duration } as CSSProperties}
        >
          {run(false)}
          {overflowing && run(true)}
        </span>
      </span>
    </div>
  );
}
