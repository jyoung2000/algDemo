/**
 * ALBUM-NAME-001 (owner, 2026-11-20): services often answer a song with its single, whose "album" is only the song's
 * own name. That name is never shown as the album, and the album the song is actually on is looked up.
 */
import { ALBUM_SUFFIX, cleanAlbumTitle } from './album-key';
import { fold, splitArtists } from './identity';

type Song = { title?: string | null; album?: string | null; artists?: string[] | null; artist?: string | null; album_looked?: boolean | number; album_confirmed?: boolean };

/** The song's title without its featured artists or a version note, folded. */
export function songCore(title: string | null | undefined): string {
  return fold(String(title ?? '').replace(/\s*[([](?:feat|ft|with)\b[^)\]]*[)\]]/gi, '').replace(/\s+(?:feat|ft)\.?\s.*$/i, ''));
}

/** The album is only the song's own name, or marked as a single. */
export function singleNamed(t: Song): boolean {
  // A look-up confirmed the album (a title track: Future's "Honest" on Honest).
  if (t.album_confirmed) return false;
  const raw = String(t.album ?? '').trim();
  if (!raw) return false;
  if (ALBUM_SUFFIX.exec(raw)?.[1]?.toLowerCase() === 'single') return true;
  const album = songCore(cleanAlbumTitle(raw));
  return Boolean(album) && album === songCore(t.title);
}

/** Bumped when the look-up rules change, so rows checked under older rules are checked again. */
export const ALBUM_LOOKUP_VERSION = 2;

/** A row whose album still needs looking up. */
export function wantsAlbum(t: Song): boolean {
  return singleNamed(t) && t.album_looked !== ALBUM_LOOKUP_VERSION;
}

const primary = (t: Song): string => fold(splitArtists(t.artists?.length ? t.artists : String(t.artist ?? ''))[0] ?? '');

/** The same song by the same lead artist on a real album (not its single, not someone else's compilation). */
export function realAlbumFrom(t: Song, candidates: readonly (Song & { album_id?: string | null })[]): { album: string; album_id: string | null } | null {
  const core = songCore(t.title), lead = primary(t);
  if (!core || !lead) return null;
  for (const c of candidates) {
    if (songCore(c.title) !== core || primary(c) !== lead) continue;
    const album = String(c.album ?? '').trim();
    if (!album || singleNamed(c) || ALBUM_SUFFIX.test(album)) continue;
    return { album, album_id: c.album_id ? String(c.album_id) : null };
  }
  return null;
}

type MbRelease = { title?: string; date?: string; status?: string; 'artist-credit'?: { name?: string }[]; 'release-group'?: { 'primary-type'?: string; 'secondary-types'?: string[] } };
type MbRecording = { title?: string; 'artist-credit'?: { name?: string }[]; releases?: MbRelease[] };

/**
 * From a MusicBrainz recording search: the album of the artist's own that holds this song. Official releases only,
 * credited to the same lead artist; a studio album beats a mixtape, then the earliest wins. Compilations, live,
 * remix and DJ-mix releases never count. `titleTrack` says the album bears the song's own name (a real album).
 */
export function albumFromMusicBrainz(body: unknown, t: Song): { album: string; titleTrack: boolean } | null {
  const recs = ((body as { recordings?: MbRecording[] } | null)?.recordings ?? []) as MbRecording[];
  const core = songCore(t.title), lead = primary(t);
  if (!core || !lead) return null;
  const albums: { title: string; date: string; rank: number }[] = [];
  for (const r of recs) {
    if (songCore(r.title) !== core || fold(r['artist-credit']?.[0]?.name ?? '') !== lead) continue;
    for (const rel of r.releases ?? []) {
      const rg = rel['release-group'] ?? {};
      if (rel.status !== 'Official' || rg['primary-type'] !== 'Album') continue;
      const sec = rg['secondary-types'] ?? [];
      if (sec.some((s) => s !== 'Mixtape/Street')) continue;
      const by = rel['artist-credit']?.[0]?.name;
      if (by && fold(by) !== lead) continue;
      const title = String(rel.title ?? '').trim();
      if (!title) continue;
      albums.push({ title, date: rel.date || '9999', rank: sec.length ? 1 : 0 });
    }
  }
  albums.sort((a, b) => a.rank - b.rank || a.date.localeCompare(b.date));
  const best = albums[0];
  return best ? { album: best.title, titleTrack: songCore(best.title) === core } : null;
}
