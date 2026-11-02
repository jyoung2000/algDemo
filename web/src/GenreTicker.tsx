import { useEffect, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { LeafView } from './taste-view';

/** A readable, pausable one-at-a-time marquee, never an endlessly moving line of text. */
export function GenreTicker({ entries }: { entries: LeafView[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const signature = entries.map((e) => `${e.label}:${e.pct}`).join('|');
  useEffect(() => setIndex(0), [signature]);
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
  const still = paused || focused || hovered || hidden || reduced;
  useEffect(() => {
    if (still || entries.length < 2) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % entries.length), 4800);
    return () => window.clearInterval(timer);
  }, [still, signature, entries.length]);
  const entry = entries[index % Math.max(1, entries.length)];
  if (!entry) return <p className="genre-ticker__empty">Still learning your sound</p>;
  return (
    <div className="genre-ticker" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)} onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false); }}>
      <span className="genre-ticker__window" aria-live="off">
        <span className="genre-ticker__entry" key={entry.label}>
          <i style={{ background: entry.color }} aria-hidden="true" />
          <span>{entry.label}</span><b>{entry.pct}%</b>
        </span>
      </span>
      {entries.length > 1 && <>
        {!reduced && <button type="button" className="quiet-control" aria-label={paused ? 'Resume genre rotation' : 'Pause genre rotation'} aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
          <Glyph name={paused ? 'play' : 'pause'} size={12} />
        </button>}
        <button type="button" className="quiet-control" aria-label={`Next genre (${index % entries.length + 1} of ${entries.length})`} onClick={() => { setPaused(true); setIndex((i) => (i + 1) % entries.length); }}>
          <Glyph name="chevron-right" size={14} />
        </button>
      </>}
    </div>
  );
}
