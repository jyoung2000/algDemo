import type { MouseEvent } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { Track } from './api';
import type { CardCache } from './engine/queue-controls';
import './row-play.css';
import './song-row.css';
import './tag-spacing.css';

/** A song that plays from a file on this device (imported from a local music folder). */
export function isLocalTrack(t: Pick<Track, 'provider'> & { url?: string | null }): boolean {
  return String(t.provider) === 'imported' || String(t.url ?? '').startsWith('imported:');
}

/**
 * ROW-PLAY-001: every song list's Play button. Ready (the full file is on this device: downloaded, or a
 * local song) is a light blue filled button; the words in the title say why, so colour is never alone.
 */
export function RowPlayButton({ track, cache, onPlay, size = 16 }: { track: Track; cache: CardCache | null | undefined; onPlay: () => void; size?: number }) {
  const local = isLocalTrack(track);
  const ready = local || cache?.state === 'ready';
  return <PlayDisc ready={ready} local={local} onPlay={onPlay} label={`Play ${track.title}`} title={local ? 'Play — local file' : ready ? 'Play — ready locally' : 'Play'} size={size} />;
}

/**
 * PLAY-DISC-001 (owner, 2026-11-19): one Play button for every list (Discover, Saved, Radio). A 40px
 * circle in a 44px target; light blue when the song plays at once (ready, local, a live station).
 * The triangle sits 1px right of the box centre, because a triangle's visual centre is left of its
 * box's. `playing` shows Pause in the same disc.
 */
export function PlayDisc({ ready, local, playing, onPlay, label, title, size = 16, className }: { ready?: boolean; local?: boolean; playing?: boolean; onPlay: () => void; label: string; title?: string; size?: number; className?: string }) {
  return (
    <button
      className={`iconbtn playbtn${className ? ` ${className}` : ''}`}
      type="button"
      data-ready={ready || undefined}
      data-local={local || undefined}
      data-playing={playing || undefined}
      aria-pressed={playing === undefined ? undefined : playing}
      onClick={onPlay}
      aria-label={label}
      title={title ?? label}
    >
      <Glyph name={playing ? 'pause' : 'play'} size={size} className={playing ? undefined : 'playbtn__tri'} />
    </button>
  );
}

/**
 * ROW-PLAY-001: double-clicking a listing plays it. A double-click that starts on one of the row's own
 * controls (a button, link, field or menu) is that control's business, not a request to play.
 */
export function playOnDoubleClick(play: () => void) {
  return (e: MouseEvent<HTMLElement>) => {
    const target = e.target as Element | null;
    if (target?.closest('button, a, input, select, textarea, label, [role="button"], [role="menu"], [role="dialog"]')) return;
    window.getSelection?.()?.removeAllRanges();
    play();
  };
}
