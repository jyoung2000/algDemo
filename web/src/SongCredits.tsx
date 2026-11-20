import type { ArtistTarget, Track } from './api';
import { ArtistNames, artistTargetsOf } from './ArtistLinks';
import { artistOf } from './util';
import { creditedTrack } from './engine/credited-names';
import { Marquee } from './Marquee';
import { singleNamed } from './engine/album-name';
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
  // ALBUM-NAME-001 (owner, 2026-11-20): a single's "album" is only the song's own name; it reads "Single" (still
  // opening the single) until the album the song is on is found, never the song title posing as an album.
  const single = !hideAlbum && singleNamed(track);
  const album = hideAlbum ? '' : single ? 'Single' : track.album?.trim();
  const credits = creditedTrack(track);
  const names = artistTargetsOf(credits).map((part) => part.name).join(', ') || artistOf(track);
  return (
    <>
      {album && (
        // LINES-001 (owner, 2026-11-19): album and artists keep a line each and scroll when cut off.
        <span className="song-credits__album-line"><Marquee title={album}>
          {onOpenAlbum ? (
            <button type="button" className="song-credits__album" aria-label={single ? `Open the single ${track.album?.trim() ?? ''}` : `Open the album ${album}`} onClick={(event) => { event.stopPropagation(); onOpenAlbum(track); }}>
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
