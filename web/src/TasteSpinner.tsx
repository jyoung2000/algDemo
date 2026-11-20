import { useEffect, useRef, useState } from 'react';
import './taste-spinner.css';

/** How long the arrow turns faster after songs are added. */
export const SPIN_FAST_MS = 4000;

/**
 * TASTE-SPIN-001 (owner): a grey half-circle arrow before the "Learned from N songs" line. It turns while a song
 * plays and turns a little faster for a few seconds when songs are added to the now playing queue.
 */
export function TasteSpinner({ playing, songs, size = 14 }: { playing: boolean; songs: number; size?: number }) {
  const last = useRef(songs);
  const [fast, setFast] = useState(false);
  useEffect(() => {
    const grew = songs > last.current;
    last.current = songs;
    if (!grew) return;
    setFast(true);
    const t = window.setTimeout(() => setFast(false), SPIN_FAST_MS);
    return () => window.clearTimeout(t);
  }, [songs]);
  return (
    <svg className={`taste-spin${playing ? ' is-on' : ''}${playing && fast ? ' is-fast' : ''}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {/* the upper half of a circle, with the arrowhead at its right end pointing down the way it turns */}
      <path className="taste-spin__arc" d="M2.5 8a5.5 5.5 0 0 1 11 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path className="taste-spin__head" d="M10.6 6.9 13.5 9.6 15.6 6.3Z" fill="currentColor" />
    </svg>
  );
}
