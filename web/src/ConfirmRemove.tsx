import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './confirm-remove.css';

/** REMOVE-CONFIRM-001: set to 'off' when the listener ticks "Don't ask again". */
export const CONFIRM_REMOVE_KEY = 'airwave:confirm-remove';
export function confirmRemoveWanted(): boolean {
  try { return localStorage.getItem(CONFIRM_REMOVE_KEY) !== 'off'; } catch { return true; }
}

/**
 * REMOVE-CONFIRM-001 (owner, 2026-11-20): the Discover X removes a song for good (REMOVE-FOREVER-001), so it asks
 * first and says what will happen. Cancel has the focus; Escape and the backdrop cancel.
 */
export function ConfirmRemove({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  const head = useId(), body = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [quiet, setQuiet] = useState(false);
  useEffect(() => { cancel.current?.focus(); }, []);
  const confirm = () => {
    if (quiet) { try { localStorage.setItem(CONFIRM_REMOVE_KEY, 'off'); } catch { /* private mode: ask again next time */ } }
    onConfirm();
  };
  return createPortal(
    <div className="confirm-remove">
      <div className="confirm-remove__backdrop" onClick={onCancel} />
      <div className="confirm-remove__box" role="alertdialog" aria-modal="true" aria-labelledby={head} aria-describedby={body}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
        <h2 id={head} className="confirm-remove__title">Remove “{title}”?</h2>
        <p id={body} className="confirm-remove__text">
          It leaves your queue and won’t be recommended again, similar songs will come up less, and its downloaded copy
          is deleted. Like or star it later to bring it back.
        </p>
        <label className="confirm-remove__quiet">
          <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} /> Don’t ask again
        </label>
        <div className="confirm-remove__actions">
          <button ref={cancel} type="button" className="confirm-remove__btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="confirm-remove__btn confirm-remove__btn--danger" onClick={confirm}>Remove</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
