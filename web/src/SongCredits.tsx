import type { ArtistTarget, Track } from './api';
import { ArtistNames, artistTargetsOf } from './ArtistLinks';
import { artistOf } from './util';
import { creditedTrack } from './engine/credited-names';
import './song-credits.css';

/**
 * SONG-CREDITS-001: song title (rendered by the row), then album, then every credited artist.
 * The album text replaces the former album action icon; unknown albums take no space. Keep the
 * same component in search, queue and saved lists so phone and desktop have identical navigation.
 */
export function SongCredits({ track, onOpenAlbum, onOpenArtist, artistClassName = 'track__artist', hideAlbum = false }: {
  track: Track;
  onOpenAlbum?: ((track: Track) => void) | undefined;
  onOpenArtist?: ((target: ArtistTarget) => void) | undefined;
  artistClassName?: string;
  /** An album page already names its own album above its numbered songs. */
  hideAlbum?: boolean;
}) {
  const album = hideAlbum ? '' : track.album?.trim();
  const credits = creditedTrack(track);
  return (
    <>
      {album && (
        <span className="song-credits__album-line">
          {onOpenAlbum ? (
            <button type="button" className="song-credits__album" aria-label={`Open the album ${album}`} onClick={(event) => { event.stopPropagation(); onOpenAlbum(track); }}>
              {album}
            </button>
          ) : <span className="song-credits__album">{album}</span>}
        </span>
      )}
      {onOpenArtist ? <ArtistNames track={credits} onOpen={onOpenArtist} className={artistClassName} /> : <span className={artistClassName}>{artistTargetsOf(credits).map((part) => part.name).join(', ') || artistOf(track)}</span>}
    </>
  );
}
