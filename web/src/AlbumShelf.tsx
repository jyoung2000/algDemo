import { useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { AlbumSummary } from './api';
import { PROVIDER_LABEL } from './util';
import { Art } from './Art';

/** What a body of work is called on screen (ALBUM-SEARCH-001). */
export const ALBUM_KIND: Record<AlbumSummary['kind'], string> = { album: 'Album', ep: 'EP', mixtape: 'Mixtape', compilation: 'Compilation', single: 'Single' };

const SHELF_FOLDED = 3;

const songs = (n: number) => `${n} ${n === 1 ? 'song' : 'songs'}`;

export function albumMeta(a: Pick<AlbumSummary, 'kind' | 'year' | 'count'>): string {
  return [ALBUM_KIND[a.kind], a.year, a.count ? songs(a.count) : null].filter(Boolean).join(' · ');
}

/** ALBUM-SEARCH-002: the service an album came from; a SoundCloud set by someone else is a fan upload. */
export function albumSource(a: Pick<AlbumSummary, 'provider' | 'official'>): string {
  const name = PROVIDER_LABEL[a.provider] ?? a.provider;
  return a.official === false ? `${name} fan upload` : name;
}

/** The album page's line: "From YouTube Music", or "Fan upload on SoundCloud". */
export function albumFrom(a: Pick<AlbumSummary, 'provider' | 'official'>): string {
  const name = PROVIDER_LABEL[a.provider] ?? a.provider;
  return a.official === false ? `Fan upload on ${name}` : `From ${name}`;
}

/**
 * ALBUM-SEARCH-001. The albums a plain search finds, shown with the songs: each row opens the album
 * like a list. Three show at first so the songs stay in reach; the rest unfold on request.
 */
export function AlbumShelf({ albums, query, onOpen, title = 'Albums', label, folded = SHELF_FOLDED, noun = 'albums' }: {
  albums: AlbumSummary[];
  query: string;
  onOpen: (a: AlbumSummary) => void;
  /** ARTIST-PAGE-001: the artist page lists "Albums and EPs" and "Singles" with the same rows. */
  title?: string;
  label?: string;
  folded?: number;
  noun?: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? albums : albums.slice(0, folded);
  return (
    <div className="albums">
      <h3 className="albums__h">{title}</h3>
      <ul className="well tracks albums__list" aria-label={label ?? `Albums for ${query}`}>
        {shown.map((a) => (
          <li key={a.id} className="track album-row">
            <button type="button" className="album-row__open" onClick={() => onOpen(a)} aria-label={`Open the album ${a.title} by ${a.artist}`}>
              <Art src={a.artwork} size={44} />
              <span className="track__text">
                <span className="track__title">{a.title}</span>
                <span className="track__artist">{a.artist}</span>
                <span className="track__meta">
                  {albumMeta(a)} <span className="album-row__src">· {albumSource(a)}</span>
                </span>
              </span>
              <Glyph name="chevron-right" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!all && albums.length > folded && (
        <button type="button" className="linkbtn albums__more" onClick={() => setAll(true)}>
          Show all {albums.length} {noun}
        </button>
      )}
    </div>
  );
}
