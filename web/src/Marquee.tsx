import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './marquee.css';

/** How far cut-off text must travel to show its end; a pixel or two of rounding is not "cut off". */
export function marqueeShift(scrollWidth: number, clientWidth: number): number {
  const d = Math.round(scrollWidth - clientWidth);
  return d > 2 ? d : 0;
}

/** Space between the end of the text and its following copy in a loop (px). */
export const MARQUEE_GAP = 32;
/** One loop: a rest on the first letter (the first fifth) and the glide through, at 30 px a second, never under 4 s. */
export function marqueeLoopSeconds(distance: number): number {
  return Math.max(4, distance / 30) / 0.8;
}

/**
 * MARQUEE-001 (owner, 2026-11-19): text cut off in a song list scrolls to show all of it, on Windows
 * and Android. It waits, glides to the end at a reading pace (30 px/s), waits, and glides back;
 * text that fits never moves. Reduced motion: it never moves and the full text stays in `title`.
 *
 * MARQUEE-START-001 (owner, 2026-11-19): "song names should start at the beginning before they start
 * scrolling". Every row used to start its loop when the list loaded, so a row scrolled into view later was
 * caught part-way along. Now a name only scrolls while it is on screen, and each time it comes into view
 * (or its text changes) the loop starts again from the first letter, pausing there before it glides.
 */
/*
 * MARQUEE-LOOP-001 (owner, 2026-11-20): "Ensure the marquis / scroll effect fully loops and scrolls". It no longer
 * glides to the end and back: it rests on the first letter, scrolls all the way through, and a hidden copy follows
 * MARQUEE_GAP behind, so when the text has gone the copy sits exactly where it began and the loop wraps with no jump.
 */
export function Marquee({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const [loop, setLoop] = useState(0);
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver !== 'function');
  useLayoutEffect(() => {
    const b = box.current, i = inner.current;
    if (!b || !i) return;
    const measure = () => {
      setShift(marqueeShift(i.scrollWidth, b.clientWidth));
      // The copy starts one text width plus the gap along; sub-pixel width so the wrap lands exactly.
      setLoop(Math.round(((i.getBoundingClientRect().width || i.scrollWidth) + MARQUEE_GAP) * 100) / 100);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    ro.observe(i);
    return () => ro.disconnect();
  }, [children]);
  useLayoutEffect(() => {
    const b = box.current;
    if (!b || !shift || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.target === b) setOnScreen(e.isIntersecting);
    });
    io.observe(b);
    return () => { io.disconnect(); setOnScreen(false); };
  }, [shift, children]);
  const moving = Boolean(shift) && onScreen;
  return (
    <span ref={box} className={`mq${shift ? ' is-long' : ''}${moving ? ' is-moving' : ''}${className ? ` ${className}` : ''}`} title={title}
      style={shift ? ({ '--mq-loop': `-${loop}px`, '--mq-gap': `${MARQUEE_GAP}px`, '--mq-time': `${marqueeLoopSeconds(loop).toFixed(1)}s` } as React.CSSProperties) : undefined}>
      <span ref={inner} className="mq__inner">{children}</span>
      {shift ? <span className="mq__echo" aria-hidden="true">{children}</span> : null}
    </span>
  );
}
