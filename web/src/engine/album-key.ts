/**
 * The key album taste counts under (ALBUM-TASTE-001) and the test for a body of work that decides the
 * song row's album button (ALBUM-OPEN-001). Pure and network-free, so the ranker can import it.
 */
import { fold, splitArtists } from './identity';

export const ALBUM_SUFFIX = /\s*[-\u2013\u2014]\s*(EP|Single)\s*$/i;

/** The title without the " - EP" / " - Single" Apple appends. */
export function cleanAlbumTitle(title: string): string {
  return title.replace(ALBUM_SUFFIX, '').trim();
}

export type AlbumOf = { title?: string | null; album?: string | null; artists?: string[] | null; artist?: string | null };

/**
 * The primary artist and the album title, folded, so the same album from two services is one album.
 * Null when the song is not on a body of work: no album, an album marked as a single, or an album that
 * only carries the song's own name (a single by another name; an album's title track is lost to this,
 * which costs a signal, never a wrong one).
 */
export function albumKeyOf(t: AlbumOf): string | null {
  const raw = String(t.album ?? '').trim();
  if (!raw || ALBUM_SUFFIX.exec(raw)?.[1]?.toLowerCase() === 'single') return null;
  const album = fold(cleanAlbumTitle(raw));
  const title = fold(String(t.title ?? ''));
  const artist = splitArtists(t.artists?.length ? t.artists : String(t.artist ?? ''))[0] ?? '';
  if (!album || !artist || album === title) return null;
  return `${artist}|${album}`;
}

/**
 * ALBUM-SEARCH-001 / ALBUM-CAR-001: the words name this album ("a great chaos", "ken carson a great
 * chaos", or the start of its title), so the album is what was asked for, not a song.
 */
export function namesAlbum(query: string, title: string): boolean {
  const q = fold(query);
  const t = fold(cleanAlbumTitle(title));
  return q.length >= 3 && t.length >= 3 && (q.includes(t) || t.startsWith(q));
}

/** The song row's album button shows only for a song on an album, EP or mixtape. */
export function isBodyOfWork(t: AlbumOf): boolean {
  return albumKeyOf(t) !== null;
}
