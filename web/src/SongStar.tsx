import { Glyph } from '@now-playing/aqua-ui/icons';
import type { PlaylistSummary } from './api';
import './song-star.css';

/** A like and a playlist save are separate facts; only an actual named playlist earns a check. */
export function inPlaylist(songKey: string | undefined, lists: PlaylistSummary[] = []): boolean {
  return Boolean(songKey && lists.some(l => !l.album && l.items.some(i => i.key === songKey)));
}

/**
 * The same heart in search, the queue and the current-song controls. HEART-NO-TICK-001 (owner, 2026-11-24: "Remove
 * the check box near the heart icon"): no playlist tick; `saved` is kept as a data attribute only.
 */
export function SongStar({ saved, size = 14 }: { saved: boolean; size?: number }) {
  return <span className="song-star" aria-hidden="true" data-playlist-saved={saved}>
    <Glyph name="heart" size={size} />
  </span>;
}
