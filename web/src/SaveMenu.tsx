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
  lists: allLists,
  onLists,
  onClose,
  onUnstar,
}: {
  songKey: string;
  title: string;
  lists: PlaylistSummary[];
  onLists: (lists: PlaylistSummary[]) => void;
  onClose: () => void;
  /** STAR-MENU-001: the star always opens this menu, so a starred song is unstarred from here. */
  onUnstar?: (() => void) | undefined;
}) {
  // ALBUM-SAVE-001: a saved album holds the album's songs only, so it is never offered here.
  const lists = allLists.filter((l) => !l.album);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(lists.length === 0);
  const [name, setName] = useState('');
  const box = useRef<HTMLDivElement | null>(null);
  const first = useRef<HTMLInputElement | HTMLButtonElement | null>(null);
  const headingId = useId();
  const nameId = useId();

  // SAVE-MENU-STAY-001 (owner, 2026-11-23: "adding songs to playlist doesnt work"): the rows pass a new onClose
  // function on every draw, and this effect used to depend on it — so the menu took focus and scrolled itself back
  // into view on every redraw of a page that redraws several times a second. It now does both once, when it opens.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Opening a menu that lands under the thumb is no use if it cannot be dismissed, so Escape,
  // a tap outside and moving focus away all close it.
  useEffect(() => {
    const onClose = () => closeRef.current();
    first.current?.focus();
    // SAVE-MENU-REACH-001 (owner, 2026-11-23): "the playlist pop up and create menu doesn't work on
    // android". On a phone the menu opens inside the scrolling list, and a row near an edge put it off
    // the screen (measured: top -68 CSS px), so the tap looked dead. Bring it into view; 'nearest'
    // leaves a menu that is already visible where it is.
    box.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
  }, []);

  const saved = new Set(lists.filter((l) => l.items.some((i) => i.key === songKey)).map((l) => l.id));
  // SAVE-MENU-STAY-001: a tick shows at once. On a large library the engine takes seconds to answer (measured:
  // 6.7 s on the emulator with 9,400 list songs), and a box that did not move looked like a press that did nothing.
  const [ticked, setTicked] = useState<{ id: string; on: boolean } | null>(null);
  const holding = new Set(saved);
  if (ticked) { if (ticked.on) holding.add(ticked.id); else holding.delete(ticked.id); }

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
    const next = new Set(saved);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked({ id, on: next.has(id) });
    // Whatever the answer, the boxes then show what is really saved: a failed tick goes back.
    void run(() => api.playlistEdit('set', { ids: [...next], key: songKey })).finally(() => setTicked(null));
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

  /**
   * SAVE-MENU-REACH-001: while the on-screen keyboard is up, a touch that moves focus off the name
   * field hides the keyboard, and the window grows back (measured 502 → 780 CSS px) before the finger
   * lifts — the control slides out from under it and no click is ever generated, so the first press on
   * "Create and save" did nothing. Refusing the default on touch keeps focus, and the keyboard, where
   * they are: the press lands the first time. A mouse is left alone.
   */
  const holdFocus = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') e.preventDefault();
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
              <label className="savemenu__row" onPointerDown={holdFocus}>
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
            <button className="push" type="button" disabled={busy || !name.trim()} onPointerDown={holdFocus} onClick={() => void create()}>
              Create and save
            </button>
            {lists.length > 0 && (
              <button className="linkbtn" type="button" disabled={busy} onPointerDown={holdFocus} onClick={() => { setCreating(false); setError(null); }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <button className="savemenu__add" type="button" disabled={busy} onPointerDown={holdFocus} onClick={() => { setCreating(true); setError(null); }}>
          <Glyph name="add" size={13} /> New list
        </button>
      )}

      {error && (
        <p className="savemenu__err" role="alert">
          {error}
        </p>
      )}
      <p className="savemenu__note">
        {busy
          ? 'Saving\u2026'
          : holding.size === 0
            ? 'Liked songs stay in Saved whether or not you pick a list.'
            : `In ${holding.size} ${holding.size === 1 ? 'list' : 'lists'}. Changes save as you tick.`}
      </p>
      <div className="savemenu__foot">
        {onUnstar && (
          <button className="linkbtn savemenu__unstar" type="button" disabled={busy} onPointerDown={holdFocus} onClick={() => { onUnstar(); onClose(); }}>
            Remove star
          </button>
        )}
        <button className="savemenu__done" type="button" onPointerDown={holdFocus} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
