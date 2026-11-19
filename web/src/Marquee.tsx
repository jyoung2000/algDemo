import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './marquee.css';

/** How far cut-off text must travel to show its end; a pixel or two of rounding is not "cut off". */
export function marqueeShift(scrollWidth: number, clientWidth: number): number {
  const d = Math.round(scrollWidth - clientWidth);
  return d > 2 ? d : 0;
}

/**
 * MARQUEE-001 (owner, 2026-11-19): text cut off in a song list scrolls to show all of it, on Windows
 * and Android. It waits, glides to the end at a reading pace (30 px/s), waits, and glides back;
 * text that fits never moves. Reduced motion: it never moves and the full text stays in `title`.
 */
export function Marquee({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const b = box.current, i = inner.current;
    if (!b || !i) return;
    const measure = () => setShift(marqueeShift(i.scrollWidth, b.clientWidth));
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    ro.observe(i);
    return () => ro.disconnect();
  }, [children]);
  const secs = shift ? Math.max(4, shift / 30) + 3 : 0;
  return (
    <span ref={box} className={`mq${shift ? ' is-moving' : ''}${className ? ` ${className}` : ''}`} title={title}
      style={shift ? ({ '--mq-shift': `-${shift}px`, '--mq-time': `${(secs * 2).toFixed(1)}s` } as React.CSSProperties) : undefined}>
      <span ref={inner} className="mq__inner">{children}</span>
    </span>
  );
}
