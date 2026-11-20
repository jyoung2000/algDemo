import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './marquee.css';

/** How far cut-off text must travel to show its end; a pixel or two of rounding is not "cut off". */
export function marqueeShift(scrollWidth: number, clientWidth: number): number {
  const d = Math.round(scrollWidth - clientWidth);
  return d > 2 ? d : 0;
}

/** Space between the end of the text and its following copy in a loop (px). */
export const MARQUEE_GAP = 32;
/** Reading pace of a cut-off song name (px a second). */
export const MARQUEE_SPEED = 30;
/** TAG-SPEED-001 (owner, 2026-11-20): tags glide faster than names ("faster, not crazy fast"). */
export const TAG_MARQUEE_SPEED = 48;
/** MARQUEE-STEADY-001: how much faster a scroll under way runs to finish its loop when the text changes. */
export const MARQUEE_FINISH_RATE = 4;
/** One loop: a rest on the first letter (the first fifth) and the glide through at `speed`, never under 4 s. */
export function marqueeLoopSeconds(distance: number, speed: number = MARQUEE_SPEED): number {
  return Math.max(4, distance / speed) / 0.8;
}
/** Resting on the first letter (the first fifth of a loop) a restart costs nothing; part-way through it finishes first. */
export function marqueeRestart(progress: number): 'now' | 'finish' {
  return progress > 0.2 ? 'finish' : 'now';
}

/**
 * MARQUEE-001 (owner, 2026-11-19): text cut off in a song list scrolls to show all of it, on Windows
 * and Android. Reduced motion: it never moves and the full text stays in `title`.
 *
 * MARQUEE-START-001 (owner, 2026-11-19): a name only scrolls while it is on screen, and each time it comes into view
 * (or its text changes) it starts from the first letter, pausing there before it glides.
 *
 * MARQUEE-LOOP-001 (owner, 2026-11-20): it rests on the first letter, scrolls all the way through, and a hidden copy
 * follows MARQUEE_GAP behind, so when the text has gone the copy sits exactly where it began and the loop wraps.
 *
 * MARQUEE-STEADY-001 (owner, 2026-11-20): "keeps scrolling all the way through instead of just snapping back". It
 * watches the TEXT, not React's element objects, so a redraw around it (the player every second, the queue on every
 * update) never restarts it. New text part-way through a loop runs the loop out at MARQUEE_FINISH_RATE and starts the
 * new text from its first letter when the loop comes round, instead of jumping back.
 */
export function Marquee({ children, className, title, speed = MARQUEE_SPEED }: { children: ReactNode; className?: string; title?: string; speed?: number }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const echo = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState('');
  const [shift, setShift] = useState(0);
  const [measured, setMeasured] = useState(0);
  // What the running loop uses: the text it was started for and its length. Changed only between loops.
  const [applied, setApplied] = useState<{ text: string; loop: number }>({ text: '', loop: 0 });
  const restart = useRef(false);
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver !== 'function');
  // Every commit: has the text itself changed? (Cheap; a redraw with the same text changes nothing.)
  useLayoutEffect(() => {
    const t = inner.current?.textContent ?? '';
    if (t !== text) setText(t);
  });
  useLayoutEffect(() => {
    const b = box.current, i = inner.current;
    if (!b || !i) return;
    const measure = () => {
      setShift(marqueeShift(i.scrollWidth, b.clientWidth));
      // The copy starts one text width plus the gap along; sub-pixel width so the wrap lands exactly.
      setMeasured(Math.round(((i.getBoundingClientRect().width || i.scrollWidth) + MARQUEE_GAP) * 100) / 100);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    ro.observe(i);
    return () => ro.disconnect();
  }, [text]);
  const long = shift > 0;
  useLayoutEffect(() => {
    const b = box.current;
    if (!b || !long || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === b) setOnScreen(e.isIntersecting);
    });
    io.observe(b);
    return () => { io.disconnect(); setOnScreen(false); };
  }, [long]);
  const moving = long && onScreen;
  const anims = () => [inner.current, echo.current].flatMap((el) => (el && typeof el.getAnimations === 'function' ? el.getAnimations() : []));
  // New text or a new length: straight away while resting on the first letter, else run the loop out fast first.
  useLayoutEffect(() => {
    if (applied.text === text && applied.loop === measured) return;
    const next = { text, loop: measured };
    const a = moving ? anims()[0] : undefined;
    const t = a?.effect?.getComputedTiming?.();
    const progress = typeof t?.progress === 'number' ? t.progress : 0;
    if (!a || marqueeRestart(progress) === 'now') { restart.current = Boolean(a); setApplied(next); return; }
    for (const x of anims()) x.playbackRate = MARQUEE_FINISH_RATE;
    const el = inner.current;
    const done = () => { restart.current = true; setApplied(next); };
    el?.addEventListener('animationiteration', done, { once: true });
    return () => el?.removeEventListener('animationiteration', done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, measured, moving, applied]);
  // The new loop starts cleanly from its first letter, both copies together, at reading pace again.
  useLayoutEffect(() => {
    if (!restart.current) return;
    restart.current = false;
    for (const x of anims()) { x.playbackRate = 1; x.currentTime = 0; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);
  const loop = applied.loop || measured;
  return (
    <span ref={box} className={`mq${long ? ' is-long' : ''}${moving ? ' is-moving' : ''}${className ? ` ${className}` : ''}`} title={title}
      style={long ? ({ '--mq-loop': `-${loop}px`, '--mq-gap': `${MARQUEE_GAP}px`, '--mq-time': `${marqueeLoopSeconds(loop, speed).toFixed(1)}s` } as React.CSSProperties) : undefined}>
      <span ref={inner} className="mq__inner">{children}</span>
      {long ? <span ref={echo} className="mq__echo" aria-hidden="true">{children}</span> : null}
    </span>
  );
}
