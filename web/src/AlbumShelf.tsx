import { useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { AlbumSummary, Track } from './api';
import { isBodyOfWork } from './engine/album-key';
import { Art } from './Art';
import { AlbumGlyph } from './icons';

/** What a body of work is called on screen (ALBUM-SEARCH-001). */
export const ALBUM_KIND: Record<AlbumSummary['kind'], string> = { album: 'Album', ep: 'EP', mixtape: 'Mixtape', compilation: 'Compilation', single: 'Single' };

/** ALBUM-OPEN-001: the song row's album button, shared by every song list. */
export function AlbumButton({ album, onClick }: { album: string; onClick: () => void }) {
  return (
    <button className="iconbtn" type="button" onClick={onClick} aria-label={`Open the album ${album}`} title="Open the album">
      <AlbumGlyph size={14} />
    </button>
  );
}

/**
 * The album button's place in a row: the button for a song on an album, EP or mixtape, otherwise an
 * empty slot the same size, so the duration and source columns line up down the list.
 */
export function AlbumSlot({ track, onOpen }: { track: Track; onOpen: (t: Track) => void }) {
  return isBodyOfWork(track) ? <AlbumButton album={track.album!} onClick={() => onOpen(track)} /> : <span className="iconbtn album-gap" aria-hidden="true" />;
}

const SHELF_FOLDED = 3;

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

export function albumMeta(a: Pick<AlbumSummary, 'kind' | 'year' | 'count'>): string {
  return [ALBUM_KIND[a.kind], a.year, a.count ? songs(a.count) : null].filter(Boolean).join(' · ');
}

/**
 * ALBUM-SEARCH-001. The albums a plain search finds, shown with the songs: each row opens the album
 * like a list. Three show at first so the songs stay in reach; the rest unfold on request.
 */
export function AlbumShelf({ albums, query, onOpen }: { albums: AlbumSummary[]; query: string; onOpen: (a: AlbumSummary) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? albums : albums.slice(0, SHELF_FOLDED);
  return (
    <div className="albums">
      <h3 className="albums__h">Albums</h3>
      <ul className="well tracks albums__list" aria-label={`Albums for ${query}`}>
        {shown.map((a) => (
          <li key={a.id} className="track album-row">
            <button type="button" className="album-row__open" onClick={() => onOpen(a)} aria-label={`Open the album ${a.title} by ${a.artist}`}>
              <Art src={a.artwork} size={44} />
              <span className="track__text">
                <span className="track__title">{a.title}</span>
                <span className="track__artist">{a.artist}</span>
                <span className="track__meta">{albumMeta(a)}</span>
              </span>
              <Glyph name="chevron-right" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!all && albums.length > SHELF_FOLDED && (
        <button type="button" className="linkbtn albums__more" onClick={() => setAll(true)}>
          Show all {albums.length} albums
        </button>
      )}
    </div>
  );
}
