import { useEffect, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import './volume-pop.css';

interface Props {
  /** 0 to 1. */
  value: number;
  muted: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (value: number) => void;
  onToggleMute: () => void;
}

/** Two taps closer together than this are a double tap (mute), not two single taps. */
export const DOUBLE_TAP_MS = 300;

/**
 * VOLUME-POP-001 (owner, 2026-11-19): "volume should have a pop up slider when tapped or double tap
 * to mute". One speaker icon sits in the control row. A tap opens a slider above it; a double tap
 * mutes or unmutes; Escape, a tap outside or another tap closes it. Keyboard: Enter/Space open it,
 * the arrow keys change the level on the slider, M mutes. Dragging the slider while muted unmutes.
 */
export function Volume({ value, muted, disabled, disabledReason, onChange, onToggleMute }: Props) {
  const pct = muted ? 0 : Math.round(value * 100);
  const silent = muted || pct === 0;
  const [open, setOpen] = useState(false);
  const tap = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => () => { if (tap.current) window.clearTimeout(tap.current); }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key); };
  }, [open]);
  const onTap = () => {
    if (tap.current) {
      // The second tap of a double tap: mute (or unmute), and leave the slider as it was.
      window.clearTimeout(tap.current);
      tap.current = null;
      onToggleMute();
      return;
    }
    tap.current = window.setTimeout(() => { tap.current = null; setOpen((o) => !o); }, DOUBLE_TAP_MS);
  };
  const verb = silent ? 'unmute' : 'mute';
  return (
    <div className={`vol vol--pop${open ? ' is-open' : ''}`} ref={root} role="group" aria-label="Volume" title={disabled ? disabledReason : undefined}
      onKeyDown={(e) => { if ((e.key === 'm' || e.key === 'M') && !disabled) { e.preventDefault(); onToggleMute(); } }}>
      <button className="vol__btn" type="button" onClick={onTap} disabled={disabled} aria-expanded={open} data-muted={silent || undefined}
        aria-label={`Volume ${pct}%${muted ? ', muted' : ''}. Tap to adjust, double tap to ${verb}`}
        title={disabled ? disabledReason : `Volume ${pct}% — tap to adjust, double tap to ${verb}`}>
        <Glyph name={silent ? 'mute' : pct < 50 ? 'volume-low' : 'volume-high'} size={18} />
      </button>
      {open && (
        <div className="vol__pop">
          <input
            className="prog__bar vol__bar"
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            disabled={disabled}
            aria-label="Volume"
            aria-valuetext={`${pct}%`}
            autoFocus
            style={{ ['--pct' as string]: `${pct}%` }}
            onChange={(e) => onChange(Number(e.target.value) / 100)}
          />
          <span className="vol__n" aria-hidden="true">{pct}</span>
          <button className="vol__mute" type="button" onClick={onToggleMute} aria-pressed={muted} aria-label={silent ? 'Unmute' : 'Mute'} title={silent ? 'Unmute' : 'Mute'}>
            <Glyph name={silent ? 'mute' : 'volume-high'} size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
