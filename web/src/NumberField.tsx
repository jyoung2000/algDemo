import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & {
  value: number;
  min: number;
  max: number;
  /** Called with a whole, in-range number only. */
  onValue: (n: number) => void;
};

/**
 * CUSTOM-INPUTS-001: a number setting that can be typed into on a phone. What is typed stays in the field; only a
 * valid in-range number is saved while typing, and on leaving the field an empty or out-of-range entry becomes the
 * nearest valid value. (Saving every keystroke turned a cleared field into the minimum and "400" into "2000".)
 */
export function NumberField({ value, min, max, onValue, onBlur, onFocus, inputMode = 'numeric', ...rest }: Props) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);
  const valid = (s: string): number | null => {
    if (!/^\d+(?:\.\d+)?$/.test(s.trim())) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  return (
    <input
      {...rest}
      type="number"
      inputMode={inputMode}
      min={min}
      max={max}
      value={draft}
      onFocus={(e) => { editing.current = true; onFocus?.(e); }}
      onChange={(e) => {
        const s = e.target.value;
        setDraft(s);
        const n = valid(s);
        if (n !== null && n !== value) onValue(n);
      }}
      onBlur={(e) => {
        editing.current = false;
        const s = draft.trim();
        const typed = s === '' || !Number.isFinite(Number(s)) ? null : Number(s);
        const n = typed === null ? value : Math.min(max, Math.max(min, typed));
        setDraft(String(n));
        if (n !== value) onValue(n);
        onBlur?.(e);
      }}
    />
  );
}
