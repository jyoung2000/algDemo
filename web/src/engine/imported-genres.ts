/**
 * IMPORT-GENRES-001: genres, cover and length for songs imported from the listener's own folders.
 *
 * An imported song is known only by what its file says: a title and an artist (read from the file's
 * own tags where the Windows scan found them, else from an "Artist - Title" file name) and sometimes
 * a genre word. It is given the catalogue's genres, artwork and length only through a confident
 * title-plus-artist match with a catalogue recording, by the same rule the queue's genre lookup uses
 * (identity.ts `matchRecordings`): a shared artist, the same folded title, the same version words,
 * and no length that contradicts it. Anything less is no match, and the song stays untagged rather
 * than wearing another song's genres.
 */
import { makeTag, type Tag } from './genres';
import { fold, matchRecordings, type TrackLike } from './identity';

/** The reason matchRecordings gives for "same title and artist, but nothing to compare lengths with". */
export const NO_LENGTH = 'no duration to compare';

/** Where a tag read from the file's own genre field says it came from. */
export const FILE_GENRE_SOURCE = 'File genre tag';

/** Whether an imported song carries enough of an identity to be looked up at all. */
export function canMatch(t: { title?: unknown; artists?: unknown }): boolean {
  const title = typeof t.title === 'string' ? fold(t.title) : '';
  const artists = Array.isArray(t.artists) ? t.artists.filter((a) => typeof a === 'string' && fold(a)) : [];
  return Boolean(title) && artists.length > 0;
}

/**
 * The catalogue recording that is confidently this song, or null. `same` always counts; `uncertain`
 * counts only when the sole doubt is that there was no length to compare (exact title, shared
 * artist, same version) - the rule the queue's own genre lookup applies to a song with no length.
 */
export function confidentMatch<T extends TrackLike>(song: TrackLike, candidates: readonly T[]): { match: T; proven: boolean } | null {
  if (!canMatch(song)) return null;
  let alike: T | null = null;
  for (const c of candidates) {
    const v = matchRecordings(song, c);
    if (v.verdict === 'same') return { match: c, proven: true };
    if (!alike && v.verdict === 'uncertain' && v.reason === NO_LENGTH) alike = c;
  }
  return alike ? { match: alike, proven: false } : null;
}

/**
 * The genre words a file's own genre field names, as canonical tags (TAGS-CANON-001): "Hip-Hop/Rap",
 * "rnb; Trap" or "Hip Hop\u0000Rap" become one tag per genre, "rap" and "hip hop" one tag, words the
 * catalogue has no genre for dropped. Numeric ID3v1 references are resolved by the scan, not here.
 */
export function fileGenreTags(raw: unknown): Tag[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const out: Tag[] = [];
  const seen = new Set<string>();
  // Try the whole field first ("Hip-Hop/Rap" is one genre to the canon), then each part.
  const whole = makeTag(raw.trim(), FILE_GENRE_SOURCE, 'track', 0.6);
  const parts = whole ? [raw.trim()] : raw.split(/\s*(?:[;,/|\u0000]|\s&\s)\s*/);
  for (const p of parts) {
    const tag = makeTag(p.trim(), FILE_GENRE_SOURCE, 'track', 0.6);
    if (!tag || seen.has(tag.name)) continue;
    seen.add(tag.name);
    out.push(tag);
  }
  return out.slice(0, 3);
}

/** A song's own stated (not inferred) tags. */
export function statedTags(t: { tags?: unknown }): Tag[] {
  return ((Array.isArray(t.tags) ? t.tags : []) as Tag[]).filter((g) => g && typeof g.name === 'string' && !g.inferred);
}

/** One genre per canonical name, first spelling kept: "Rap" and "Hip Hop" are one tag on a song. */
export function uniqueTags(tags: readonly Tag[]): Tag[] {
  const seen = new Set<string>();
  return tags.filter((g) => g && typeof g.name === 'string' && !seen.has(g.name) && (seen.add(g.name), true));
}

/**
 * What a confident match lends the imported song: the catalogue's genres (else the file's own genre
 * words, now that the song's identity is confirmed), its cover when the song has none, and its
 * length when the song has none. The playback link is never touched: the file stays the source.
 */
export function enrichImported<T extends Record<string, unknown>>(
  song: T,
  found: { tags: readonly Tag[]; artwork?: unknown; duration?: unknown },
  fileGenre?: unknown,
): T {
  const out: Record<string, unknown> = { ...song };
  const catalogue = uniqueTags(found.tags.filter((g) => g && typeof g.name === 'string'));
  const tags = catalogue.length ? catalogue : fileGenreTags(fileGenre);
  if (tags.length && !statedTags(song).length) out['tags'] = tags;
  if (!out['artwork'] && typeof found.artwork === 'string' && /^https:\/\//.test(found.artwork)) out['artwork'] = found.artwork;
  const d = Number(found.duration);
  if (!out['duration'] && Number.isFinite(d) && d > 0) out['duration'] = Math.round(d);
  out['url'] = song['url'];
  out['provider'] = song['provider'];
  return out as T;
}
