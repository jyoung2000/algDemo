import type { PlaylistSummary, RecItem, SavedItem, Track } from '../api';
import { playbackOfTrack } from '../util';

export function savedTracks(saved: SavedItem[] | null, lists: PlaylistSummary[], id: string): Track[] {
  if (id === 'all') return (saved ?? []).map(s => s.track);
  const byKey = new Map((saved ?? []).map(s => [s.track.key, s.track]));
  return (lists.find(l => l.id === id)?.items ?? []).map(i => byKey.get(i.key) ?? i.track).filter((t): t is Track => !!t);
}
/** Navigation-only rows. Saved songs do not acquire fabricated recommendation scores in the UI. */
export function playbackRows(tracks: Track[]): RecItem[] {
  return tracks.map((track, i) => ({ track, playback: playbackOfTrack(track), rank: i + 1,
    score: 0, coverage: 0, tier: 'related', evidence: 'thin', best_seed: null, reasons: [], uncertainty: [],
    new_release: false, factors: {}, weights: {}, sources: [] }));
}
/**
 * ROLLING-CACHE-001: priority order for the queue cache, highest first.
 *
 * The order is the whole message to the shell — it keeps the head of `wanted` and evicts from the
 * tail. So each list is ROTATED to begin at the song being listened to: the rest of that list is
 * still ahead of the listener and must outrank the songs already behind them. Without the rotation
 * a song two places away sorted last, and on a full cache the shell evicted what was about to play
 * to hold what had just finished.
 */
export function preparationTracks(current: Track | null, upcoming: Track[], ...lists: Track[][]): Track[] {
  const rotated = lists.map((list) => {
    const at = current ? list.findIndex(t => t.key === current.key) : -1;
    return at > 0 ? [...list.slice(at), ...list.slice(0, at)] : list;
  });
  return [...new Map([...(current ? [current] : []), ...upcoming, ...rotated.flat()].map(t => [t.key, t])).values()];
}

/** SEARCH-QUEUE-001: the playing context of a song started from the search list. */
export const SEARCH_CONTEXT = '@search';

/**
 * The rows the player's skip buttons walk: the now playing queue (no context), a saved list in its own
 * order, or the search results in theirs, so a song played from search steps on to the next result.
 */
export function contextRows(
  ctx: string | null,
  src: { queueRows: RecItem[]; search: Track[]; saved: SavedItem[] | null; lists: PlaylistSummary[] },
): RecItem[] {
  if (ctx === null) return src.queueRows;
  if (ctx === SEARCH_CONTEXT) return playbackRows(src.search);
  return playbackRows(savedTracks(src.saved, src.lists, ctx));
}

/** Where the search row's add button puts a song (QUEUE-ADD-001). */
export type AddTarget = { kind: 'queue' } | { kind: 'list'; id: string; name: string; seed: boolean };

/**
 * The saved list being played from; else the saved list in the now playing queue, whose songs are all
 * starting songs (PLAYLIST-QUEUE-001), so an added song becomes one too; else the now playing queue.
 * "All saved" is not one list, and a list deleted while it played is gone: both fall back to the queue.
 */
export function addTargetOf(ctx: string | null, queueList: { id: string; name: string } | null, lists: PlaylistSummary[]): AddTarget {
  // ALBUM-SAVE-001: a saved album keeps the album's songs only, so a song added while it plays goes to the queue.
  const playingList = ctx && ctx !== SEARCH_CONTEXT && ctx !== 'all' ? lists.find((l) => l.id === ctx && !l.album) : undefined;
  if (playingList) return { kind: 'list', id: playingList.id, name: playingList.name, seed: false };
  if (queueList && !lists.find((l) => l.id === queueList.id)?.album) return { kind: 'list', id: queueList.id, name: queueList.name, seed: true };
  return { kind: 'queue' };
}

/** A now playing queue row for a song the listener added themselves. */
export function addedRow(track: Track): RecItem {
  return {
    ...playbackRows([track])[0]!,
    reasons: [{ factor: 'added', text: 'You added it to the queue.', weight: 0 }],
    sources: ['added'],
    added: true,
  };
}

/** The queue with `row` right after `afterKey` (the song playing), or at the top; never twice. */
export function insertAfter(items: RecItem[], row: RecItem, afterKey: string | null): RecItem[] {
  const rest = items.filter((x) => x.track.key !== row.track.key);
  const i = afterKey ? rest.findIndex((x) => x.track.key === afterKey) : -1;
  const out = [...rest.slice(0, i + 1), row, ...rest.slice(i + 1)];
  return out.map((x, n) => ({ ...x, rank: n + 1 }));
}
