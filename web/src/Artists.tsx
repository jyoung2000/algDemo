import { useEffect, useRef, useState } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, ApiError, type AlbumSummary, type ArtistTarget, type ArtistView as ArtistData, type PlaylistSummary, type Track } from './api';
import { Art } from './Art';
import { AlbumShelf } from './AlbumShelf';
import { ListSaveButton } from './ListSaveButton';
import { TrackList } from './Search';

export type { ArtistTarget } from './api';
export { ArtistCard, ArtistNames, artistTargetsOf, namesArtist } from './ArtistLinks';

export const artistTargetKey = (t: ArtistTarget): string => t.id ?? `name:${(t.name ?? '').toLowerCase()}`;

/** Songs shown before "Show all": enough to start from, short enough that the albums stay in reach. */
export const SONGS_FOLDED = 10;

interface Props {
  target: ArtistTarget;
  onBack: () => void;
  onPreview: (t: Track, list: Track[]) => void;
  onOpenAlbum: (a: AlbumSummary) => void;
  onOpenArtist: (t: ArtistTarget) => void;
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

type State = { state: 'loading' } | { state: 'ready'; artist: ArtistData } | { state: 'failed'; message: string };
type Every = { state: 'loading' } | { state: 'ready'; songs: Track[]; failed: number } | { state: 'failed' };

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

function sourceLine(a: ArtistData): { line: string; marks: ('deezer' | 'ytmusic')[] } {
  const marks = (['deezer', 'ytmusic'] as const).filter((p) => a.sources[p]?.state === 'ok');
  const names = marks.map((p) => (p === 'deezer' ? 'Deezer' : 'YouTube Music'));
  return { line: names.length ? `From ${names.join(' and ')}` : '', marks };
}

/**
 * ARTIST-PAGE-001. Owner: "can we add artist pages where we can see all of an artist songs and
 * albums". Opens on the most played songs; every song on every album and single follows a moment
 * later, so "Show all" lists everything the artist has released. Albums, EPs and singles open as
 * album pages. Every song plays as the full song, as from a search.
 */
export function ArtistView({ target, onBack, onPreview, onOpenAlbum, onOpenArtist, seedKeys, onAdd, onDownload, onLike, onRemoveSeed, lists, onLists, onQueueAdd, addLabel, addedKeys, playingKey }: Props) {
  const [st, setSt] = useState<State>({ state: 'loading' });
  const [every, setEvery] = useState<Every>({ state: 'loading' });
  const [all, setAll] = useState(false);
  const back = useRef<HTMLButtonElement>(null);

  useEffect(() => back.current?.focus({ preventScroll: true }), []);

  // App mounts a fresh view for each artist (keyed by artistTargetKey), so loading is the initial state.
  useEffect(() => {
    const c = new AbortController();
    api.artist(target, c.signal).then(
      (r) => {
        if (c.signal.aborted) return;
        setSt({ state: 'ready', artist: r.artist });
        // Every song on every album and single: asked once the page is up, so it never holds it up.
        const t: ArtistTarget = { id: r.artist.id, name: r.artist.name };
        api.artistSongs(t, c.signal).then(
          (s) => { if (!c.signal.aborted) setEvery({ state: 'ready', songs: s.songs, failed: s.failed }); },
          () => { if (!c.signal.aborted) setEvery({ state: 'failed' }); },
        );
      },
      (e: unknown) => {
        if (c.signal.aborted) return;
        setSt({ state: 'failed', message: e instanceof ApiError ? e.message : 'The artist could not be opened. Check the connection and try again.' });
      },
    );
    return () => c.abort();
  }, [target]);

  const listProps = { seedKeys, onAdd, onPreview, onDownload, onLike, onRemoveSeed, lists, onLists, onQueueAdd, addLabel, addedKeys, playingKey, onOpenArtist };

  return (
    <section className="card album artist" aria-labelledby="artist-h" aria-busy={st.state === 'loading'}>
      <div className="album__bar">
        <button ref={back} className="push album__back" type="button" onClick={onBack} aria-label="Back">
          <Glyph name="chevron-left" size={14} /> Back
        </button>
      </div>
      {st.state === 'loading' && (
        <p className="state" role="status">
          <span className="sdot sdot--busy" aria-hidden="true" /> Opening the artist…
        </p>
      )}
      {st.state === 'failed' && (
        <p className="state state--bad" role="alert">
          <Glyph name="warning" size={14} /> {st.message}
        </p>
      )}
      {st.state === 'ready' && (() => {
        const a = st.artist;
        const full = every.state === 'ready' ? every.songs : a.songs;
        const shown = all ? full : full.slice(0, SONGS_FOLDED);
        const src = sourceLine(a);
        const meta = [a.detail, every.state === 'ready' ? songs(every.songs.length) : null, a.albums.length ? `${a.albums.length} ${a.albums.length === 1 ? 'album' : 'albums'}` : null].filter((x): x is string => Boolean(x));
        return (
          <>
            <div className="album__head">
              <span className="artist-pic">
                <Art src={a.picture} size={112} />
              </span>
              <div className="album__text">
                <span className="album__kind">Artist</span>
                <h2 id="artist-h" className="album__title">{a.name}</h2>
                {meta.length > 0 && (
                  <span className="album__meta">
                    {meta.map((part, i) => (
                      <span key={part}>
                        {i > 0 && ' · '}
                        <span className="artist__part">{part}</span>
                      </span>
                    ))}
                  </span>
                )}
                {src.line && (
                  <span className="album__src">
                    {src.marks.map((p) => <ProviderMark key={p} provider={p} size={13} />)} {src.line}
                  </span>
                )}
              </div>
            </div>
            <div className="album__actions">
              <button className="push push--default" type="button" disabled={!full.length} onClick={() => onPreview(full[0]!, full)}>
                <Glyph name="play" size={14} /> Play songs
              </button>
              {/* LIST-SAVE-FOLDER-001: every song, downloaded into a folder named after the artist. */}
              {every.state === 'ready' && <ListSaveButton tracks={every.songs} kind="list" name={a.name} label={`every song by ${a.name}`} />}
            </div>
            <h3 className="albums__h">{all && every.state === 'ready' ? 'All songs' : 'Most played'}</h3>
            {full.length ? (
              <TrackList tracks={shown} {...listProps} label={`Songs by ${a.name}`} />
            ) : (
              <p className="empty">No songs by {a.name} were found.</p>
            )}
            <div className="artist__more">
              {every.state === 'loading' && (
                <p className="state" role="status">
                  <span className="sdot sdot--busy" aria-hidden="true" /> Finding every song on {a.name}’s albums and singles…
                </p>
              )}
              {every.state === 'failed' && (
                <p className="state" role="status">
                  <Glyph name="info" size={14} /> Only the most played songs could be listed. The albums below still open.
                </p>
              )}
              {!all && full.length > SONGS_FOLDED && (
                <button type="button" className="linkbtn albums__more" onClick={() => setAll(true)}>
                  {every.state === 'ready' ? `Show all ${full.length} songs` : `Show all ${full.length} most played`}
                </button>
              )}
              {every.state === 'ready' && every.failed > 0 && (
                <p className="state" role="status">
                  <Glyph name="info" size={14} /> {every.failed === 1 ? '1 album could not be read' : `${every.failed} albums could not be read`}, so their songs may be missing.
                </p>
              )}
            </div>
            {a.albums.length > 0 && <AlbumShelf albums={a.albums} query={a.name} onOpen={onOpenAlbum} title="Albums and EPs" label={`Albums by ${a.name}`} folded={6} noun="albums" />}
            {a.singles.length > 0 && <AlbumShelf albums={a.singles} query={a.name} onOpen={onOpenAlbum} title="Singles" label={`Singles by ${a.name}`} folded={6} noun="singles" />}
          </>
        );
      })()}
    </section>
  );
}
