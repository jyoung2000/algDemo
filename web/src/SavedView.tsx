import { useEffect, useId, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';

import { api, type PlaylistSummary, type SavedItem, type Track } from './api';
import { Art } from './Art';
import { SaveMenu } from './SaveMenu';
import { PLAYLIST_NAME_MAX } from './engine/playlists';
import { artistOf, classNames } from './util';
import './save-menu.css';
import './saved-lists.css';

interface Props {
  saved: SavedItem[] | null;
  lists: PlaylistSummary[];
  onLists: (lists: PlaylistSummary[]) => void;
  /** `listId` is the list the play started from, so the engine can apply that list's rule. */
  onPreview: (track: Track, listId?: string) => void;
  onRemoveSaved: (track: Track) => void;
  onDownload?: (track: Track) => void;
  onVisibleList?: (id: string) => void;
}

const ALL = 'all';

/**
 * PLAYLISTS-001. Saved songs, plus the lists the listener makes out of them.
 *
 * "All saved" is every liked song and cannot be renamed or deleted; the named lists are theirs.
 * There is deliberately no "Add" button here: a saved song is not a starting song, and the owner
 * asked for that control to go.
 */
export function SavedView({ saved, lists, onLists, onPreview, onRemoveSaved, onDownload, onVisibleList }: Props) {
  const [view, setView] = useState<string>(ALL);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const newId = useId();
  const renameId = useId();

  const current = lists.find((l) => l.id === view) ?? null;
  useEffect(() => { onVisibleList?.(view); }, [view, onVisibleList]);

  // A list deleted elsewhere must not leave the page showing an empty mystery.
  useEffect(() => {
    if (view !== ALL && !lists.some((l) => l.id === view)) setView(ALL);
  }, [lists, view]);

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

  const create = async () => {
    const clean = name.trim();
    if (!clean) {
      setError('Give the list a name.');
      return;
    }
    if (await run(() => api.playlistEdit('create', { name: clean }))) {
      setName('');
      setCreating(false);
      // A new list is appended, so on a phone it lands past the right edge of the swipe row.
      requestAnimationFrame(() => {
        const el = scroller.current;
        if (el) el.scrollTo({ left: el.scrollWidth, behavior: 'smooth' });
      });
    }
  };

  const rename = async () => {
    const clean = name.trim();
    if (!current || !clean) return;
    if (await run(() => api.playlistEdit('rename', { id: current.id, name: clean }))) {
      setName('');
      setRenaming(false);
    }
  };

  const remove = async () => {
    if (!current) return;
    if (await run(() => api.playlistEdit('delete', { id: current.id }))) setView(ALL);
  };

  // What the chosen view shows. A list holds keys, so its songs come from the saved rows where
  // possible and from the engine's own copy of the track otherwise.
  const byKey = new Map((saved ?? []).map((s) => [s.track.key, s.track]));
  const rows: { track: Track; played?: boolean }[] =
    current === null
      ? (saved ?? []).map((s) => ({ track: s.track }))
      : current.items
          .map((i) => ({ track: byKey.get(i.key) ?? (i.track as Track | null), played: i.played }))
          .filter((r): r is { track: Track; played: boolean } => Boolean(r.track));

  return (
    <section className="card" aria-labelledby="saved-h">
      <h2 id="saved-h">Saved</h2>

      <div className="lists" role="group" aria-label="Your saved lists">
        {/* One row on a phone, swiped sideways for the lists that do not fit. The create field is
            deliberately outside the scroller: a text input inside it would be unusable. */}
        <div className="lists__scroll" ref={scroller}>
          <button
            className={classNames('lists__tab', view === ALL && 'is-on')}
            type="button"
            aria-pressed={view === ALL}
            onClick={() => setView(ALL)}
          >
            <Glyph name="heart" size={13} /> All saved
            <span className="lists__count">{saved?.length ?? 0}</span>
          </button>
          {lists.map((l) => (
            <button
              key={l.id}
              className={classNames('lists__tab', view === l.id && 'is-on')}
              type="button"
              aria-pressed={view === l.id}
              onClick={() => setView(l.id)}
            >
              {l.name}
              <span className="lists__count">{l.count}</span>
            </button>
          ))}
          {!creating && (
            <button className="lists__add" type="button" onClick={() => { setCreating(true); setName(''); setError(null); }}>
              <Glyph name="add" size={13} /> New list
            </button>
          )}
        </div>
      </div>

      {creating && (
        <div className="lists__create">
          <label className="vh" htmlFor={newId}>
            New list name
          </label>
          <input
            id={newId}
            className="field"
            autoFocus
            value={name}
            maxLength={PLAYLIST_NAME_MAX}
            placeholder="Late night"
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void create();
              }
              if (e.key === 'Escape') {
                setCreating(false);
                setName('');
                setError(null);
              }
            }}
          />
          <button className="push" type="button" disabled={busy || !name.trim()} onClick={() => void create()}>
            Create
          </button>
          <button className="linkbtn" type="button" onClick={() => { setCreating(false); setName(''); setError(null); }}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <p className="banner banner--bad" role="alert">
          {error}
        </p>
      )}

      {current && (
        <div className="lists__bar">
          {renaming ? (
            <>
              <label className="vh" htmlFor={renameId}>
                Rename {current.name}
              </label>
              <input
                id={renameId}
                className="field"
                autoFocus
                value={name}
                maxLength={PLAYLIST_NAME_MAX}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void rename();
                  }
                  if (e.key === 'Escape') setRenaming(false);
                }}
              />
              <button className="push" type="button" disabled={busy || !name.trim()} onClick={() => void rename()}>
                Save name
              </button>
              <button className="linkbtn" type="button" onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {/* Why this list is or is not asking for more songs — the owner's rule, stated. */}
              <p className="lists__state">
                {current.count === 0
                  ? 'Empty. Like a song and pick this list to fill it.'
                  : current.discovery_ready
                    ? 'You have played everything here, so discovery may add to it.'
                    : `${current.unplayed} of ${current.count} still to play. Discovery waits until you have heard them all.`}
              </p>
              <button className="linkbtn" type="button" onClick={() => { setRenaming(true); setName(current.name); setError(null); }}>
                Rename
              </button>
              <button className="linkbtn linkbtn--bad" type="button" disabled={busy} onClick={() => void remove()}>
                Delete list
              </button>
            </>
          )}
        </div>
      )}

      {saved == null ? (
        <p className="state">
          <span className="sdot sdot--busy" aria-hidden="true" /> Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="empty">{current ? 'Nothing in this list yet.' : 'Songs you like appear here.'}</p>
      ) : (
        <ul className="well tracks tracks--saved">
          {rows.map(({ track, played }) => (
            <li key={track.key} className="track">
              <Art src={track.artwork} size={44} />
              <div className="track__text">
                <span className="track__title">{track.title}</span>
                <span className="track__artist">{artistOf(track)}</span>
              </div>
              {current && (
                <span className={classNames('track__played', played && 'is-on')}>
                  {played ? 'Played' : 'Not played'}
                </span>
              )}
              <span className="track__actions">
                <button className="iconbtn" type="button" aria-label={`Play ${track.title}`} onClick={() => onPreview(track, current?.id)}>
                  <Glyph name="play" size={14} />
                </button>
                {onDownload && (
                  <button className="iconbtn" type="button" aria-label={`Download ${track.title}`} title="Download" onClick={() => onDownload(track)}>
                    <Glyph name="download" size={14} />
                  </button>
                )}
                <button
                  className={classNames('iconbtn', menuFor === track.key && 'is-on')}
                  type="button"
                  aria-expanded={menuFor === track.key}
                  aria-label={`Choose lists for ${track.title}`}
                  title="Save to lists"
                  onClick={() => setMenuFor(menuFor === track.key ? null : track.key)}
                >
                  <Glyph name="folder" size={14} />
                </button>
                <button
                  className="iconbtn"
                  type="button"
                  aria-label={current ? `Remove ${track.title} from ${current.name}` : `Remove ${track.title} from Saved`}
                  title={current ? `Remove from ${current.name}` : 'Remove from Saved'}
                  onClick={() => {
                    if (current) void run(() => api.playlistEdit('remove', { id: current.id, key: track.key }));
                    else onRemoveSaved(track);
                  }}
                >
                  <Glyph name="close" size={14} />
                </button>
              </span>
              {menuFor === track.key && (
                <div className="track__savemenu">
                  <SaveMenu songKey={track.key} title={track.title} lists={lists} onLists={onLists} onClose={() => setMenuFor(null)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
