import type { Playback, Track } from '../api';

/**
 * Where the listener was when the app last stopped.
 *
 * RESUME-001. Both shells host the player in a web view that the OS may tear down — Android
 * recreates the Activity under memory pressure or with "Don't keep activities" on, and closing the
 * Windows window ends the page. The audio graph cannot survive that, but the listener's PLACE can:
 * without this, reopening the app landed on an empty player and the song they were part-way through
 * was simply lost.
 *
 * Only the song and the playhead are kept. The cached audio file itself is already persistent
 * (that is the queue cache's job), so a resumed song usually needs no new download at all.
 */
export interface ResumePoint {
  track: Track;
  playback: Playback;
  /** Playhead in seconds when the snapshot was taken. */
  t: number;
  /** Epoch seconds, so a stale place can be dropped rather than resurrected weeks later. */
  saved_at: number;
}

const KEY = 'airwave.resume';
/** A week later this is not "where I was", it is archaeology. */
const MAX_AGE_S = 7 * 24 * 60 * 60;
/**
 * Below this the listener had barely started, and restoring it would fight the obvious intent of
 * pressing play on a fresh song. Above `MIN_LEFT_S` from the end there is nothing worth returning to.
 */
const MIN_T_S = 20;
const MIN_LEFT_S = 15;

export function readResume(now = Date.now()): ResumePoint | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<ResumePoint>;
    if (!p || typeof p !== 'object') return null;
    const { track, playback, t, saved_at } = p;
    if (!track?.key || !playback || typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null;
    if (typeof saved_at !== 'number' || now / 1000 - saved_at > MAX_AGE_S) return null;
    return { track, playback, t, saved_at };
  } catch {
    // Corrupt or written by an older version: a lost place is not worth a crash on launch.
    return null;
  }
}

export function writeResume(track: Track, playback: Playback, t: number, duration: number, now = Date.now()): boolean {
  // A 30-second preview has no place worth keeping, and neither does a song just started or nearly
  // over. `duration` 0 means it is not known yet, which is itself a reason to wait.
  if (!(t >= MIN_T_S) || !(duration > 0) || duration - t <= MIN_LEFT_S) return false;
  try {
    const point: ResumePoint = { track, playback, t: Math.round(t), saved_at: Math.round(now / 1000) };
    window.localStorage.setItem(KEY, JSON.stringify(point));
    return true;
  } catch {
    // Private mode or a full quota: the place just is not remembered.
    return false;
  }
}

export function clearResume(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
