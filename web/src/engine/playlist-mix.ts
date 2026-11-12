/**
 * A saved list's own sound (PLAYLIST-MIX-001): the same "listening mix" the Sound card draws for the
 * listener's taste, read from the songs in the list instead of from plays.
 *
 * Every song counts once, the way a starting song does: no decay, no skips. A song's genres come
 * from its own tags, then from what the services said about it when it was a starting song (the
 * seed-profile cache), then from its artist's other songs. A song none of those name is counted as
 * not placed, and the response says how many, so the card never pretends to know a list's sound.
 */
import { buildTaste, tasteSummary, type TasteRow } from './taste';
import type { Tag } from './genres';
import type { Dict } from './shape';

export interface PlaylistMix {
  taste: Record<string, unknown> | null;
  /** Songs in the list that could be read at all. */
  songs: number;
  /** Songs with at least one genre. */
  placed: number;
}

/**
 * `genresOf` returns a song's tags from whichever source knows them, or [] when none does.
 *
 * ALBUM-RAGE-001: with `byEvidence`, every song was placed from the same album-level tags, so the
 * play counts are all equal and say nothing - the card is told to weigh by score (which carries
 * each tag's confidence) instead, so the genre the record is really in leads.
 */
export function playlistMix(tracks: Dict[], genresOf: (t: Dict) => Tag[], nowTs: number, opts: { byEvidence?: boolean } = {}): PlaylistMix {
  const rows: TasteRow[] = [];
  let placed = 0;
  for (const t of tracks) {
    const tags = genresOf(t);
    if (tags.length) placed++;
    // 'save' is how a kept song is weighted in the taste; the same weight for every song in the list.
    rows.push({ key: String(t['key']), kind: 'save', ts: nowTs, track: { ...t, tags } });
  }
  const taste = buildTaste(rows, nowTs);
  const summary = placed ? tasteSummary(taste) : null;
  if (summary && opts.byEvidence) {
    const blank = (list: unknown) => (list as { plays?: number }[] | undefined)?.map((g) => ({ ...g, plays: 0 }));
    summary['genres'] = blank(summary['genres']) ?? [];
    summary['likes'] = blank(summary['likes']) ?? [];
  }
  return { taste: summary, songs: tracks.length, placed };
}
