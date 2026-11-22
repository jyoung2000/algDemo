import { useContext, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import type { Track } from './api';
import type { CardCache } from './engine/queue-controls';
import { CardCacheContext } from './card-cache-context';
import { listPlayState, songRing } from './engine/play-state';
import './play-state.css';
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
  // PLAY-LIVE-001: a song still to download wears a blue ring filled to its real download progress.
  const ring = songRing(cache, local);
  const title = local ? 'Play — local file' : ready ? 'Play — ready locally' : ring && ring.progress > 0 ? `Play — downloading, ${ring.progress}%` : ring?.moving ? 'Play — downloading' : 'Play';
  return <PlayDisc ready={ready} local={local} ring={ring} onPlay={onPlay} label={`Play ${track.title}`} title={title} size={size} />;
}

/**
 * PLAY-DISC-001 (owner, 2026-11-19): one Play button for every list (Discover, Saved, Radio). A 40px
 * circle in a 44px target; light blue when the song plays at once (ready, local, a live station).
 * The triangle sits 1px right of the box centre, because a triangle's visual centre is left of its
 * box's. `playing` shows Pause in the same disc.
 */
export function PlayDisc({ ready, local, playing, onPlay, label, title, size = 16, className, ring }: { ready?: boolean; local?: boolean; playing?: boolean; onPlay: () => void; label: string; title?: string; size?: number; className?: string; ring?: { progress: number; moving: boolean } | null }) {
  const showRing = !!ring && !ready && !playing;
  return (
    <button
      className={`iconbtn playbtn${className ? ` ${className}` : ''}`}
      type="button"
      data-ready={ready || undefined}
      data-local={local || undefined}
      data-playing={playing || undefined}
      data-progress={showRing || undefined}
      data-moving={(showRing && ring!.moving) || undefined}
      style={showRing ? ({ '--dl': String(ring!.progress) } as CSSProperties) : undefined}
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
 * ALBUM-PLAY-STATE-001 (owner, 2026-11-21): "The play album button should start in black and white and only become
 * blue once all songs on the album are downloaded, have an outline around the play album button as well". One Play
 * button for a whole list (an album, a saved album, an artist's songs): neutral with a blue ring filled to the share
 * of its songs on this device, solid blue once every one is.
 */
export function ListPlayButton({ tracks, className, label, title, disabled, onClick, children, cacheOf: given }: { tracks: readonly Track[]; className: string; label: string; title?: string; disabled?: boolean; onClick: () => void; children: ReactNode; cacheOf?: ((key: string) => CardCache | null) | undefined }) {
  const fromApp = useContext(CardCacheContext);
  const cacheOf = given ?? fromApp;
  const local = new Set(tracks.filter(isLocalTrack).map((t) => t.key));
  const s = listPlayState(tracks.map((t) => t.key), cacheOf, (k) => local.has(k));
  const words = s.ready ? 'every song downloaded' : `${s.done} of ${s.total} song${s.total === 1 ? '' : 's'} downloaded`;
  return (
    <button className={`${className} listplay`} type="button" disabled={disabled} onClick={onClick} aria-label={label}
      title={`${title ?? label} — ${words}`} data-ready={s.ready || undefined} data-progress={!s.ready || undefined} data-moving={s.moving || undefined}
      style={s.ready ? undefined : ({ '--dl': String(s.progress) } as CSSProperties)}>
      {children}
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
