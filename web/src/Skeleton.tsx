import { type CSSProperties, type ReactNode } from 'react';
import './skeleton.css';

/* SKELETON-001: placeholder loaders for search, artist and radio data. The shapes mirror the real
   layout so nothing jumps when data lands. While loading, a "radio tuning" sweep runs over the
   blocks; when live content arrives, wrap it in <Develop> — it focuses in like a developing photo
   (blur + desaturation + a left-to-right wipe), which is the transition animation, not a plain swap. */

export function Skeleton({ kind = 'line', w, h, className, style }: {
  kind?: 'line' | 'art' | 'pill' | 'block';
  w?: number | string;
  h?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={['skel', `skel--${kind}`, className].filter(Boolean).join(' ')}
      style={{ width: w, height: h, ...style }}
      aria-hidden="true"
    />
  );
}

/** A row of skeleton shapes shaped like one list entry (artwork + two text lines + a pill). */
export function SkeletonRow({ art = 48, lines = 2, pill = false }: { art?: number; lines?: number; pill?: boolean }) {
  return (
    <div className="skel-row" aria-hidden="true">
      <Skeleton kind="art" w={art} h={art} />
      <span className="skel-row__text">
        <Skeleton kind="line" w="62%" />
        {lines > 1 && <Skeleton kind="line" w="38%" />}
        {lines > 2 && <Skeleton kind="line" w="50%" />}
      </span>
      {pill && <Skeleton kind="pill" w={64} />}
    </div>
  );
}

/** A whole placeholder list; label it for screen readers once per list, not per row. */
export function SkeletonList({ rows = 6, label, art, pill }: { rows?: number; label: string; art?: number; pill?: boolean }) {
  return (
    <div className="skel-list" role="status" aria-label={label}>
      <span className="vh">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} art={art} pill={pill} />
      ))}
    </div>
  );
}

/** Wrap freshly loaded content so it develops into focus where its skeleton stood. */
export function Develop({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={['skel-develop', className].filter(Boolean).join(' ')}>{children}</div>;
}
