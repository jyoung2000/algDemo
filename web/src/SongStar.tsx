import { Glyph } from '@now-playing/aqua-ui/icons';
import type { PlaylistSummary } from './api';
import './song-star.css';

/** A like and a playlist save are separate facts; only an actual named playlist earns a check. */
export function inPlaylist(songKey: string | undefined, lists: PlaylistSummary[] = []): boolean {
  return Boolean(songKey && lists.some(l => !l.album && l.items.some(i => i.key === songKey)));
}

/** The same adjacent star + check in search, the queue and the current-song controls. */
export function SongStar({ saved, size = 14 }: { saved: boolean; size?: number }) {
  return <span className="song-star" aria-hidden="true" data-playlist-saved={saved}>
    <Glyph name="star" size={size} />
    {saved && <Glyph name="check" size={11} className="song-star__check" />}
  </span>;
}
