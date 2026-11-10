import { Fragment } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { ArtistSummary, ArtistTarget, Track } from './api';
import { Art } from './Art';
import { artistOf } from './util';

const DZ_ID = /^\d{1,15}$/;
const YT_ARTIST = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * The artists a song row names, each with what to open: the first carries the song's own artist id
 * (the service gives it for the lead artist); the others are looked up by their exact name.
 */
export function artistTargetsOf(t: Pick<Track, 'artists' | 'artist' | 'provider'> & { artist_ids?: Record<string, string> | null }): { name: string; target: ArtistTarget | null }[] {
  const names = (t.artists?.length ? t.artists : t.artist ? [t.artist] : []).map((n) => n.trim()).filter(Boolean);
  const ids = t.artist_ids ?? {};
  const lead: ArtistTarget = ids['deezer'] && DZ_ID.test(ids['deezer']) ? { id: `dz:${ids['deezer']}` } : ids['ytmusic'] && YT_ARTIST.test(ids['ytmusic']) ? { id: `yt:${ids['ytmusic']}` } : {};
  return names.map((name, i) => ({ name, target: /^unknown artist$/i.test(name) ? null : { ...(i === 0 ? lead : {}), name } }));
}

/**
 * ARTIST-PAGE-001: a song row's artist line, each name opening that artist's page. The names stay
 * text in the line (they wrap, never cut off); a name with nothing to open is plain text.
 */
export function ArtistNames({ track, onOpen, className = 'track__artist' }: { track: Pick<Track, 'artists' | 'artist' | 'provider'> & { artist_ids?: Record<string, string> | null }; onOpen: (t: ArtistTarget) => void; className?: string }) {
  const parts = artistTargetsOf(track);
  if (!parts.length) return <span className={className}>{artistOf(track)}</span>;
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <Fragment key={`${p.name}:${i}`}>
          {i > 0 && ', '}
          {p.target ? (
            <button type="button" className="artistlink" onClick={() => onOpen(p.target!)} aria-label={`Open the artist ${p.name}`}>
              {p.name}
            </button>
          ) : (
            p.name
          )}
        </Fragment>
      ))}
    </span>
  );
}

/** ARTIST-PAGE-001: a search that names an artist offers their page first. */
export function ArtistCard({ artist, onOpen }: { artist: ArtistSummary; onOpen: (a: ArtistSummary) => void }) {
  return (
    <div className="artists">
      <ul className="well tracks" aria-label={`Artist ${artist.name}`}>
        <li className="track album-row">
          <button type="button" className="album-row__open" onClick={() => onOpen(artist)} aria-label={`Open the artist ${artist.name}`}>
            <span className="artist-pic">
              <Art src={artist.picture} size={44} />
            </span>
            <span className="track__text">
              <span className="track__title">{artist.name}</span>
              <span className="track__meta">Artist{artist.detail ? ` · ${artist.detail}` : ''}</span>
            </span>
            <Glyph name="chevron-right" size={14} />
          </button>
        </li>
      </ul>
    </div>
  );
}

/** A search names an artist when it is that artist's name (case, accents and spacing aside). */
export function namesArtist(query: string, a: Pick<ArtistSummary, 'name'>): boolean {
  const f = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return f(query) !== '' && f(query) === f(a.name);
}
