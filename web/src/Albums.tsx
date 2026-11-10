import { useEffect, useRef, useState } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, ApiError, type AlbumView as AlbumData, type PlaylistSummary, type Track } from './api';
import { Art } from './Art';
import { ALBUM_KIND, albumFrom } from './AlbumShelf';
import { markKey } from './util';
import { ListSaveButton } from './ListSaveButton';
import { albumFolderName } from './engine/list-save';
import { TrackList } from './Search';

export { AlbumShelf, albumSource } from './AlbumShelf';

/** What to open: an album found by a search, or the album a song is on. */
export type AlbumTarget = { id: string } | { track: Track };

export const albumTargetKey = (t: AlbumTarget): string => ('id' in t ? t.id : `track:${t.track.key}`);

interface Props {
  target: AlbumTarget;
  onBack: () => void;
  onPreview: (t: Track, list: Track[]) => void;
  seedKeys: Set<string>;
  onAdd: (t: Track) => void;
  onDownload?: ((t: Track) => void) | undefined;
  onLike?: ((t: Track, like: boolean) => void) | undefined;
  onRemoveSeed?: ((t: Track) => void) | undefined;
  lists?: PlaylistSummary[] | undefined;
  onLists?: ((lists: PlaylistSummary[]) => void) | undefined;
  onQueueAdd?: ((t: Track) => void) | undefined;
  addLabel?: string | undefined;
  addedKeys?: ReadonlySet<string> | undefined;
  playingKey?: string | null | undefined;
}

type State = { state: 'loading' } | { state: 'ready'; album: AlbumData } | { state: 'failed'; message: string };

function length(sec: number | null): string | null {
  if (!sec) return null;
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/**
 * ALBUM-OPEN-001. Owner: "open albums like i would playlist or song list". The album's songs in album
 * order, each playable as the full song; Play album hands the player the whole album so the skip
 * buttons walk it; Save album keeps it in Saved, under Albums (ALBUM-SAVE-001); download and folder work as on
 * any list. Playing it teaches the album taste (ALBUM-TASTE-001) like any other listening.
 */
export function AlbumView({ target, onBack, onPreview, seedKeys, onAdd, onDownload, onLike, onRemoveSeed, lists, onLists, onQueueAdd, addLabel, addedKeys, playingKey }: Props) {
  const [st, setSt] = useState<State>({ state: 'loading' });
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => back.current?.focus({ preventScroll: true }), []);

  // App mounts a fresh view for each album (keyed by albumTargetKey), so loading is the initial state.
  useEffect(() => {
    const c = new AbortController();
    api.album(target, c.signal).then(
      (r) => { if (!c.signal.aborted) setSt({ state: 'ready', album: r.album }); },
      (e: unknown) => {
        if (c.signal.aborted) return;
        setSt({ state: 'failed', message: e instanceof ApiError ? e.message : 'The album could not be opened. Check the connection and try again.' });
      },
    );
    return () => c.abort();
  }, [target]);

  /** ALBUM-SAVE-001: the saved album for this album, if it is in Saved. */
  const savedOf = (a: AlbumData) => lists?.find((l) => l.album?.id === a.id) ?? null;
  const toggleSave = async (a: AlbumData) => {
    setSaving(true);
    setNote(null);
    const held = savedOf(a);
    try {
      const r = held ? await api.playlistEdit('delete', { id: held.id }) : await api.playlistEdit('save_album', { album: a });
      onLists?.(r.lists);
      setNote(held ? 'Removed from Saved.' : 'Saved. Find it in Saved, under Albums.');
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : held ? 'The album could not be removed.' : 'The album could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card album" aria-labelledby="album-h" aria-busy={st.state === 'loading'}>
      <div className="album__bar">
        <button ref={back} className="push album__back" type="button" onClick={onBack} aria-label="Back">
          <Glyph name="chevron-left" size={14} /> Back
        </button>
      </div>
      {st.state === 'loading' && (
        <p className="state" role="status">
          <span className="sdot sdot--busy" aria-hidden="true" /> Opening the album…
        </p>
      )}
      {st.state === 'failed' && (
        <p className="state state--bad" role="alert">
          <Glyph name="warning" size={14} /> {st.message}
        </p>
      )}
      {st.state === 'ready' && (() => {
        const a = st.album;
        const meta = [a.year, `${a.tracks.length} ${a.tracks.length === 1 ? 'song' : 'songs'}`, length(a.duration)].filter(Boolean).join(' · ');
        return (
          <>
            <div className="album__head">
              <Art src={a.artwork} size={112} />
              <div className="album__text">
                <span className="album__kind">{ALBUM_KIND[a.kind]}</span>
                <h2 id="album-h" className="album__title">{a.title}</h2>
                <span className="album__artist">{a.artist}</span>
                <span className="album__meta">{meta}</span>
                <span className="album__src">
                  <ProviderMark provider={markKey(a.provider)} size={13} /> {albumFrom(a)}
                </span>
              </div>
            </div>
            <div className="album__actions">
              <button className="push push--default" type="button" disabled={!a.tracks.length} onClick={() => onPreview(a.tracks[0]!, a.tracks)}>
                <Glyph name="play" size={14} /> Play album
              </button>
              {(() => {
                const held = savedOf(a);
                return (
                  <button
                    className={held ? 'push is-on' : 'push'}
                    type="button"
                    aria-pressed={Boolean(held)}
                    aria-label={held ? `Saved. Remove ${a.title} from Saved` : `Save album ${a.title}`}
                    disabled={saving || !a.tracks.length}
                    onClick={() => void toggleSave(a)}
                  >
                    <Glyph name="heart" size={14} /> {held ? 'Saved' : 'Save album'}
                  </button>
                );
              })()}
              {/* LIST-SAVE-FOLDER-001: the whole album, downloaded into a folder of its own. */}
              <ListSaveButton tracks={a.tracks} kind="album" name={albumFolderName(a.title, a.artist)} label={`the album ${a.title}`} />
            </div>
            {note && (
              <p className="state album__note" role="status">
                <Glyph name="info" size={14} /> {note}
              </p>
            )}
            {a.tracks.length ? (
              <TrackList
                tracks={a.tracks}
                numbered
                seedKeys={seedKeys}
                onAdd={onAdd}
                onPreview={onPreview}
                onDownload={onDownload}
                onLike={onLike}
                onRemoveSeed={onRemoveSeed}
                lists={lists}
                onLists={onLists}
                onQueueAdd={onQueueAdd}
                addLabel={addLabel}
                addedKeys={addedKeys}
                playingKey={playingKey}
                label={`Songs on ${a.title}`}
              />
            ) : (
              <p className="empty">None of this album’s songs can be played here.</p>
            )}
          </>
        );
      })()}
    </section>
  );
}
