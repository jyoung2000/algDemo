import type { MouseEvent } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { Track } from './api';
import type { CardCache } from './engine/queue-controls';
import './row-play.css';
import './tag-spacing.css';

/** A song that plays from a file on this device (imported from a local music folder). */
export function isLocalTrack(t: Pick<Track, 'provider'> & { url?: string | null }): boolean {
  return String(t.provider) === 'imported' || String(t.url ?? '').startsWith('imported:');
}

/**
 * ROW-PLAY-001: every song list's Play button. Ready (the full file is on this device: downloaded, or a
 * local song) is a light blue filled button; the words in the title say why, so colour is never alone.
 */
export function RowPlayButton({ track, cache, onPlay, size = 14 }: { track: Track; cache: CardCache | null | undefined; onPlay: () => void; size?: number }) {
  const local = isLocalTrack(track);
  const ready = local || cache?.state === 'ready';
  return (
    <button
      className="iconbtn playbtn"
      type="button"
      data-ready={ready || undefined}
      data-local={local || undefined}
      onClick={onPlay}
      aria-label={`Play ${track.title}`}
      title={local ? 'Play — local file' : ready ? 'Play — ready locally' : 'Play'}
    >
      <Glyph name="play" size={size} />
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
