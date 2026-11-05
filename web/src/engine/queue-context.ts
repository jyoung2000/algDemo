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
