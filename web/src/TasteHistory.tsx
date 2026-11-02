import { useId, useState } from 'react';
import { familyLabel, gradientStops, snapshotColor, type Snapshot } from './taste-view';

/** Visual interpolation is intentionally separate from the exact saved percentages. */
export function historyStops(snapshot: Snapshot) {
  return gradientStops(snapshot.segs.filter((s) => Number.isFinite(s.share) && s.share > 0).map((s) => ({ color: s.color ?? snapshotColor(s.slug), share: s.share })));
}

export function TasteHistory({ history }: { history: Snapshot[] }) {
  const id = useId().replace(/:/g, '');
  // null follows the newest state; inspecting an older state never jumps as a new listen arrives.
  const [chosen, setChosen] = useState<number | null>(null);
  const index = chosen == null ? history.length - 1 : Math.max(0, history.findIndex((s) => s.t === chosen));
  const snapshot = history[index];
  if (history.length < 2 || !snapshot) return null;
  const legacy = snapshot.segs.some((s) => !s.label);
  return <div className="sound__hist">
    <p className="sound__histh">How it has moved <span>{history.length} saved updates</span></p>
    <div className="taste-history">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true" className="taste-history__gradient">
        <defs>
          <filter id={`${id}-blend`} x="-10%" width="120%" y="0" height="100%" colorInterpolationFilters="sRGB"><feGaussianBlur stdDeviation="10 0" /></filter>
          {history.map((s, i) => <linearGradient key={i} id={`${id}-${i}`} x1="0" y1="0" x2="0" y2="1">
            {historyStops(s).map((stop, j) => <stop key={j} offset={`${stop.at}%`} stopColor={stop.color} />)}
          </linearGradient>)}
        </defs>
        <g filter={`url(#${id}-blend)`}>
          {history.map((s, i) => <rect key={`${s.t}:${s.events}`} x={(i * 1000) / history.length - (i === 0 ? 30 : 0)} y="0" width={1000 / history.length + (i === 0 || i === history.length - 1 ? 30 : 1)} height="100" fill={`url(#${id}-${i})`} />)}
        </g>
      </svg>
      <input className="taste-history__scrub" type="range" min="0" max={history.length - 1} step="1" value={index}
        aria-label="Inspect taste history" aria-valuetext={`Update ${index + 1} of ${history.length}, ${new Date(snapshot.t).toLocaleString()}`}
        onChange={(e) => setChosen(history[Number(e.target.value)]!.t)} />
    </div>
    <div className="taste-history__axis"><span>Earlier</span><span>Now</span></div>
    <p className="taste-history__caption">Blended colours; exact saved shares below.{legacy ? ' This older update recorded families only.' : ''}</p>
    <div className="taste-history__detail" aria-live="polite" aria-atomic="true">
      <time dateTime={new Date(snapshot.t).toISOString()}>{new Date(snapshot.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
      <span>{snapshot.segs.map((s) => `${s.label ?? familyLabel(s.slug)} ${Math.round(s.share * 100)}%`).join(' · ')}</span>
    </div>
  </div>;
}
