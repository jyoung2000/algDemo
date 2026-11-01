import { Glyph } from '@now-playing/aqua-ui/icons';

interface Props {
  /** 0 to 1. */
  value: number;
  muted: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (value: number) => void;
  onToggleMute: () => void;
}

/** Speaker button (mute) and a 0–100 slider. Dragging the slider while muted unmutes. */
export function Volume({ value, muted, disabled, disabledReason, onChange, onToggleMute }: Props) {
  const pct = muted ? 0 : Math.round(value * 100);
  const silent = muted || pct === 0;
  return (
    <div className="vol" role="group" aria-label="Volume" title={disabled ? disabledReason : undefined}>
      <button className="vol__btn" type="button" onClick={onToggleMute} disabled={disabled} aria-pressed={muted} aria-label={silent ? 'Unmute' : 'Mute'}>
        <Glyph name={silent ? 'mute' : pct < 50 ? 'volume-low' : 'volume-high'} size={16} />
      </button>
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
        style={{ ['--pct' as string]: `${pct}%` }}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="vol__n" aria-hidden="true">
        {pct}
      </span>
    </div>
  );
}
