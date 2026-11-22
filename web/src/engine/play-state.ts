/**
 * PLAY-LIVE-001 / ALBUM-PLAY-STATE-001 (owner, 2026-11-21):
 * "The play button needs to live update to blue once the song is finished downloading ... the play button when blue
 *  should have a white arrow. Also if possible have a thicker blue outer outline around the undownloaded song play
 *  button that represents the songs download progress."
 * "The play album button should start in black and white and only become blue once all songs on the album are
 *  downloaded, have an outline around the play album button as well, ensure the artist discography play buttons
 *  behave the same way as well".
 *
 * A song's state comes from two places: the queue cache (the automatic loader) and the Download button's own job.
 * The job is what the listener started and watched, so a finished job makes the song ready at once, and a running
 * job's percent drives the ring. Progress is only ever a real reported number; an unknown percent reads 0.
 */
import type { CardCache } from './queue-controls';

/** What the Download button's job says about one song (the native download list). */
export interface SongJob { state: string; percent: number | null }

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** The song's card with its Download job folded in: a finished job is ready, a running one is downloading. */
export function withJob(card: CardCache | null, job: SongJob | null | undefined): CardCache | null {
  if (!job || card?.state === 'ready') return card;
  if (job.state === 'done') {
    return { state: 'ready', glyph: '✓', text: 'Downloaded', keptText: 'Kept in Music folder', kept: true, progress: 100, indeterminate: false };
  }
  if (job.state === 'queued' || job.state === 'running') {
    const p = typeof job.percent === 'number' && Number.isFinite(job.percent) ? clamp(job.percent) : null;
    // The queue cache may already be further along with the same file; show whichever has more.
    const cached = card?.state === 'downloading' ? card.progress : 0;
    const progress = Math.max(p ?? 0, cached);
    return { state: 'downloading', glyph: '↓', text: p === null ? 'Downloading' : `Downloading · ${progress}%`, keptText: card?.keptText ?? null, kept: card?.kept ?? false, progress, indeterminate: p === null && cached === 0 };
  }
  return card;
}

/** The ring on one song's Play button: null when the song is ready (a full blue disc, no ring). */
export function songRing(card: CardCache | null | undefined, local = false): { progress: number; moving: boolean } | null {
  if (local || card?.state === 'ready') return null;
  if (card?.state === 'downloading') return { progress: clamp(card.progress), moving: card.indeterminate };
  return { progress: 0, moving: false };
}

/** A whole list's Play button: blue only when every song is ready; the ring is the share of the list on hand. */
export function listPlayState(keys: readonly string[], cacheOf: ((key: string) => CardCache | null) | null | undefined,
  isLocal: (key: string) => boolean = () => false): { ready: boolean; done: number; total: number; progress: number } {
  const unique = [...new Set(keys)];
  let done = 0, sum = 0;
  for (const k of unique) {
    const c = isLocal(k) ? null : cacheOf?.(k) ?? null;
    if (isLocal(k) || c?.state === 'ready') { done++; sum += 100; } else if (c?.state === 'downloading') sum += clamp(c.progress);
  }
  const total = unique.length;
  return { ready: total > 0 && done === total, done, total, progress: total ? clamp(sum / total) : 0 };
}
