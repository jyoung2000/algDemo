import { useEffect, useId, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';

import { api, type PlaylistSummary } from './api';
import { PLAYLIST_NAME_MAX } from './engine/playlists';
import './save-menu.css';

/**
 * PLAYLISTS-001. The little menu that opens when a song is liked: tick any number of saved lists,
 * or name a new one. Ticking is applied immediately so a tap is never lost if the menu is dismissed.
 */
export function SaveMenu({
  songKey,
  title,
  lists,
  onLists,
  onClose,
}: {
  songKey: string;
  title: string;
  lists: PlaylistSummary[];
  onLists: (lists: PlaylistSummary[]) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(lists.length === 0);
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  const first = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  const headingId = useId();
  const nameId = useId();

  // Opening a menu that lands under the thumb is no use if it cannot be dismissed, so Escape,
  // a tap outside and moving focus away all close it.
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  const holding = new Set(lists.filter((l) => l.items.some((i) => i.key === songKey)).map((l) => l.id));

  const run = async (fn: () => Promise<{ lists: PlaylistSummary[] }>) => {
    setBusy(true);
    setError(null);
    try {
      onLists((await fn()).lists);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    const next = new Set(holding);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    void run(() => api.playlistEdit('set', { ids: [...next], key: songKey }));
  };

  const create = async () => {
    const clean = name.trim();
    if (!clean) {
      setError('Give the list a name.');
      return;
    }
    if (await run(() => api.playlistEdit('create', { name: clean, key: songKey }))) {
      setName('');
      setCreating(false);
    }
  };

  return (
    <div className="savemenu" role="dialog" aria-modal="false" aria-labelledby={headingId} ref={box}>
      <p className="savemenu__head" id={headingId}>
        Save <span className="savemenu__song">{title}</span> to
      </p>

      {lists.length > 0 && (
        <ul className="savemenu__list">
          {lists.map((l, i) => (
            <li key={l.id}>
              <label className="savemenu__row">
                <input
                  type="checkbox"
                  checked={holding.has(l.id)}
                  disabled={busy}
                  ref={i === 0 && !creating ? (el) => { first.current = el; } : undefined}
                  onChange={() => toggle(l.id)}
                />
                <span className="box" aria-hidden="true" />
                <span className="savemenu__name">{l.name}</span>
                <span className="savemenu__count">{l.count}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {creating ? (
        <div className="savemenu__new">
          <label className="savemenu__newlabel" htmlFor={nameId}>
            New list name
          </label>
          <input
            id={nameId}
            className="field"
            value={name}
            maxLength={PLAYLIST_NAME_MAX}
            placeholder="Late night"
            disabled={busy}
            ref={creating ? (el) => { first.current = el; } : undefined}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
            }}
          />
          <div className="savemenu__newrow">
            <button className="push" type="button" disabled={busy || !name.trim()} onClick={() => void create()}>
              Create and save
            </button>
            {lists.length > 0 && (
              <button className="linkbtn" type="button" disabled={busy} onClick={() => { setCreating(false); setError(null); }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <button className="savemenu__add" type="button" disabled={busy} onClick={() => { setCreating(true); setError(null); }}>
          <Glyph name="add" size={13} /> New list
        </button>
      )}

      {error && (
        <p className="savemenu__err" role="alert">
          {error}
        </p>
      )}
      <p className="savemenu__note">
        {holding.size === 0
          ? 'Liked songs stay in Saved whether or not you pick a list.'
          : `In ${holding.size} ${holding.size === 1 ? 'list' : 'lists'}. Changes save as you tick.`}
      </p>
      <button className="savemenu__done" type="button" onClick={onClose}>
        Done
      </button>
    </div>
  );
}
