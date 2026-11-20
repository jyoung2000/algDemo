import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Marquee, TAG_MARQUEE_SPEED } from './Marquee';
import './tag-strip.css';

/** Width that shows the first two tags whole; null when there are two or fewer (they fit as they are). */
export function twoTagCap(rects: readonly Pick<DOMRect, 'left' | 'right'>[]): number | null {
  if (rects.length <= 2) return null;
  return Math.ceil(rects[1]!.right - rects[0]!.left);
}

/**
 * TAG-STRIP-001 (owner, 2026-11-19): "only show 1-2 tags at a time depending on screen space, the tags should be inline
 * and scroll or marquis through all tags if it goes past 2 tags". One line, as wide as the first two tags (narrower if
 * the row is), and the rest glide into view with the same marquee as cut-off song names (paused under reduced motion).
 */
export function TagStrip({ children, className, label = 'Song details', title }: { children: ReactNode; className?: string; label?: string; title?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const [cap, setCap] = useState<number | null>(null);
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const measure = () => setCap(twoTagCap([...b.querySelectorAll('.mq__inner > *')].map((t) => t.getBoundingClientRect())));
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const inner = b.querySelector('.mq__inner');
    const ro = new ResizeObserver(measure);
    if (inner) ro.observe(inner);
    return () => ro.disconnect();
  }, [children]);
  return (
    <span ref={box} className={`${className ? `${className} ` : ''}tag-strip`} aria-label={label} title={title}
      style={cap ? ({ '--tag-cap': `${cap}px` } as CSSProperties) : undefined}>
      <Marquee speed={TAG_MARQUEE_SPEED}>{children}</Marquee>
    </span>
  );
}
