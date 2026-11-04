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
export function preparationTracks(current: Track | null, upcoming: Track[], ...lists: Track[][]): Track[] {
  return [...new Map([...(current ? [current] : []), ...upcoming, ...lists.flat()].map(t => [t.key, t])).values()];
}
