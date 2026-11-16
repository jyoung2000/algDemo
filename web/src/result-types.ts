import type { AlbumSummary, Track } from './api';

/**
 * RESULT-TYPES-001: the kinds of result the icon menu above search results and on an artist's
 * discography page can narrow to. Songs from a search carry no release type, so a song counts as
 * a single when its release is named after it (how singles are released: "Overseas" on "Overseas",
 * or "X - Single"), and as an album song when it sits on a differently named release. A song with
 * no release name is neither. A feature is a song credited to more than one artist, or one whose
 * title credits a guest ("feat.", "ft.", "with").
 */
export type ResultType = 'artists' | 'singles' | 'albums' | 'features' | 'lyrics' | 'songs';

const FEAT = /\((?:feat\.?|ft\.?|featuring|with)\s[^)]*\)|\[(?:feat\.?|ft\.?|featuring|with)\s[^\]]*\]|\s(?:feat\.?|ft\.?|featuring)\s.*$/i;
const SINGLE_SUFFIX = /\s*[-–—]\s*single\s*$|\s*\(single\)\s*$|\s*\[single\]\s*$/i;

const norm = (s: string) =>
  s.replace(FEAT, '').replace(SINGLE_SUFFIX, '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function isSingleTrack(t: Pick<Track, 'title' | 'album'>): boolean {
  const album = t.album?.trim();
  if (!album) return false;
  if (SINGLE_SUFFIX.test(album)) return true;
  const a = norm(album);
  return a.length > 0 && a === norm(t.title);
}

export function isAlbumTrack(t: Pick<Track, 'title' | 'album'>): boolean {
  return Boolean(t.album?.trim()) && !isSingleTrack(t);
}

export function isFeatureTrack(t: Pick<Track, 'title' | 'artists' | 'artist' | 'version'>): boolean {
  if ((t.artists?.filter(Boolean).length ?? 0) > 1) return true;
  return FEAT.test(t.title) || (t.version ? /\b(?:feat\.?|ft\.?|featuring)\s/i.test(t.version) : false);
}

export const isSingleRelease = (a: Pick<AlbumSummary, 'kind'>) => a.kind === 'single';

const plain = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * RESULT-ARTIST-001: a search names an artist when it is the artist's name, holds the whole name
 * ("ken carson songs"), or is the start of it while typing ("ken car"). A word of the name alone
 * ("carson") does not, so a song merely titled after an artist is not theirs.
 */
export function namesArtistIn(query: string, name: string): boolean {
  const q = plain(query);
  const a = plain(name);
  if (!q || !a) return false;
  return q === a || ` ${q} `.includes(` ${a} `) || (q.length >= 3 && a.startsWith(q));
}

/** RESULT-ARTIST-001: a song is by the searched artist when the search names one of its credited artists. */
export function isByArtist(t: Pick<Track, 'artists' | 'artist'>, query: string): boolean {
  const names = t.artists?.length ? t.artists : t.artist ? t.artist.split(/\s*,\s*|\s+&\s+/) : [];
  return names.some((n) => n && namesArtistIn(query, n));
}

/** Whether a song from a title search shows under the selected icons (lyric matches are their own kind). */
export function songMatches(t: Track, types: ReadonlySet<ResultType>, query = ''): boolean {
  if (!types.size) return true;
  return (
    (types.has('artists') && isByArtist(t, query)) ||
    (types.has('singles') && isSingleTrack(t)) ||
    (types.has('albums') && isAlbumTrack(t)) ||
    (types.has('features') && isFeatureTrack(t))
  );
}

/** Whether an album search result shows under the selected icons. */
export function releaseMatches(a: AlbumSummary, types: ReadonlySet<ResultType>, query = ''): boolean {
  if (!types.size) return true;
  if (types.has('artists') && namesArtistIn(query, a.artist)) return true;
  return isSingleRelease(a) ? types.has('singles') : types.has('albums');
}
