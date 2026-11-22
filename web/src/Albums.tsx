import { useEffect, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { ListPlayButton } from './RowPlay';
import { SourceMark } from './SourceMark';
import { api, ApiError, type AlbumView as AlbumData, type ArtistTarget, type PlaylistSummary, type Track } from './api';
import { Art } from './Art';
import { ALBUM_KIND, albumFrom } from './AlbumShelf';
import { ListSaveButton } from './ListSaveButton';
import { albumFolderName } from './engine/list-save';
import { TrackList } from './Search';
import { SoundCard } from './SoundCard';
import { listMixNote } from './list-mix-note';
import { Develop, Skeleton, SkeletonList } from './Skeleton';
import './album-spacing.css';

export { AlbumShelf, albumSource } from './AlbumShelf';

/** What to open: an album found by a search, or the album a song is on. */
export type AlbumTarget = { id: string } | { track: Track };

export const albumTargetKey = (t: AlbumTarget): string => ('id' in t ? t.id : `track:${t.track.key}`);

interface Props {
  target: AlbumTarget;
  onBack: () => void;
  onPreview: (t: Track, list: Track[]) => void;
  /** SHUFFLE-START-001: play the whole album; the app chooses the song it starts on. */
  onPlayAll?: (list: Track[]) => void;
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
  /** ARTIST-PAGE-001: the album's artist, and each artist on its songs, open their pages. */
  onOpenArtist?: ((t: ArtistTarget) => void) | undefined;
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
export function AlbumView({ target, onBack, onPreview, onPlayAll, seedKeys, onAdd, onDownload, onLike, onRemoveSeed, lists, onLists, onQueueAdd, addLabel, addedKeys, playingKey, onOpenArtist }: Props) {
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
        /* ALBUM-SKELETON-001: the album page's own shape while it opens (the 112px cover beside the kind, title,
           artist and details lines, the three action pills, then song rows), labelled once for screen readers.
           The loaded page develops into focus where it stood, so nothing jumps. */
        <div className="album-skel" role="status" aria-label="Opening the album…">
          <span className="vh">Opening the album…</span>
          <div className="album__head" aria-hidden="true">
            <Skeleton kind="art" w={112} h={112} />
            <span className="album__text">
              <Skeleton kind="line" w={56} h={10} />
              <Skeleton kind="line" w="58%" h={20} />
              <Skeleton kind="line" w="34%" />
              <Skeleton kind="line" w="44%" h={10} />
            </span>
          </div>
          <div className="album__actions" aria-hidden="true">
            <Skeleton kind="pill" w={118} h={36} />
            <Skeleton kind="pill" w={112} h={36} />
            <Skeleton kind="pill" w={104} h={36} />
          </div>
          <SkeletonList rows={6} art={40} label="Loading songs…" />
        </div>
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
          <Develop>
            <div className="album__head">
              <Art src={a.artwork} size={112} />
              <div className="album__text">
                <span className="album__kind">{ALBUM_KIND[a.kind]}</span>
                <h2 id="album-h" className="album__title">{a.title}</h2>
                {onOpenArtist && a.artist && !/^various artists$/i.test(a.artist) ? (
                  <button type="button" className="album__artist artistlink artistlink--head" onClick={() => onOpenArtist({ name: a.artist })} aria-label={`Open the artist ${a.artist}`}>
                    {a.artist} <Glyph name="chevron-right" size={12} />
                  </button>
                ) : (
                  <span className="album__artist">{a.artist}</span>
                )}
                <span className="album__meta">{meta}</span>
                <span className="album__src">
                  <SourceMark provider={a.provider} size={13} /> {albumFrom(a)}
                </span>
              </div>
            </div>
            <div className="album__actions">
              {/* ALBUM-PLAY-STATE-001: black and white with a ring for the share downloaded; blue once every song is. */}
              <ListPlayButton tracks={a.tracks} className="push push--default" label="Play album" disabled={!a.tracks.length} onClick={() => (onPlayAll ? onPlayAll(a.tracks) : onPreview(a.tracks[0]!, a.tracks))}>
                <Glyph name="play" size={14} /> Play album
              </ListPlayButton>
              {(() => {
                const held = savedOf(a);
                return (
                  // ALBUM-TIDY-001 (owner, 2026-11-22): "make the save album just a heart". Filled once it is saved.
                  <button
                    className="iconbtn artist__star album__save"
                    type="button"
                    aria-pressed={Boolean(held)}
                    aria-label={held ? `Saved. Remove ${a.title} from Saved` : `Save album ${a.title}`}
                    title={held ? 'Saved. Tap to remove it from Saved' : 'Save album'}
                    disabled={saving || !a.tracks.length}
                    onClick={() => void toggleSave(a)}
                  >
                    <Glyph name={held ? 'heart-filled' : 'heart'} size={16} />
                  </button>
                );
              })()}
              {/* LIST-SAVE-FOLDER-001: the whole album, downloaded into a folder of its own. */}
              <ListSaveButton tracks={a.tracks} kind="album" name={albumFolderName(a.title, a.artist)} label={`the album ${a.title}`} icon />
            </div>
            {note && (
              <p className="state album__note" role="status">
                <Glyph name="info" size={14} /> {note}
              </p>
            )}
            {/*
              ALBUM-SOUND-001: what this album sounds like, in the same coloured bar the listener's
              own sound uses, read from the genres of its songs. No genre known means it says so
              rather than drawing a gradient out of nothing.
            */}
            {a.tracks.length > 0 && (
              <SoundCard
                key={a.id}
                taste={a.mix?.taste ?? null}
                listening={false}
                title={`Sound of \u201C${a.title}\u201D`}
                hideTitle
                hideNote
                label="This album's mix"
                historyKey={`airwave.sound.album.${a.id}`}
                idleText={a.mix ? listMixNote(a.mix, 'album') : 'Reading the album\u2026'}
                emptyText={
                  a.mix
                    ? `No genre known yet for the ${a.mix.songs} ${a.mix.songs === 1 ? 'song' : 'songs'} on this album. Add one to your queue and discovery looks them up.`
                    : 'Reading the album\u2026'
                }
              />
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
                onOpenArtist={onOpenArtist}
                label={`Songs on ${a.title}`}
              />
            ) : (
              <p className="empty">None of this album’s songs can be played here.</p>
            )}
          </Develop>
        );
      })()}
    </section>
  );
}
