import type { ArtistTarget, Track } from './api';
import { ArtistNames, artistTargetsOf } from './ArtistLinks';
import { artistOf } from './util';
import { creditedTrack } from './engine/credited-names';
import { Marquee } from './Marquee';
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
  const names = artistTargetsOf(credits).map((part) => part.name).join(', ') || artistOf(track);
  return (
    <>
      {album && (
        // LINES-001 (owner, 2026-11-19): album and artists keep a line each and scroll when cut off.
        <span className="song-credits__album-line"><Marquee title={album}>
          {onOpenAlbum ? (
            <button type="button" className="song-credits__album" aria-label={`Open the album ${album}`} onClick={(event) => { event.stopPropagation(); onOpenAlbum(track); }}>
              {album}
            </button>
          ) : <span className="song-credits__album">{album}</span>}
        </Marquee></span>
      )}
      <Marquee className={artistClassName} title={names}>
        {onOpenArtist ? <ArtistNames track={credits} onOpen={onOpenArtist} className="song-credits__artists" /> : <span className="song-credits__artists">{names}</span>}
      </Marquee>
    </>
  );
}
