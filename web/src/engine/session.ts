/**
 * Listening session rules (0.20.20 session reset).
 *
 * A session ends when the listener has had no audio playing for more than four minutes: the app
 * was paused or closed and not resumed in that window. A new session starts paused at zero and
 * forgets the per-session play counts. Background playback keeps a session going, because the
 * stop marker is written only while audio is stopped and cleared when audio starts again.
 */

/** Four minutes. Exactly four minutes is still the same session; more than that is a new one. */
export const IDLE_LIMIT_MS = 4 * 60_000;

/** localStorage key holding the epoch-millisecond time audio last stopped. */
export const SESSION_STOPPED_KEY = 'airwave.audioStoppedAt';

/** Most shade steps a row can take. Past this the row stops darkening so text and icons stay legible. */
export const MAX_SHADE_STEP = 3;

/** Minimal storage surface, so the rules can be tested without a browser. */
type KeyValue = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** True when the listener was away longer than the idle limit. No recorded stop means nothing to reset. */
export function isNewSession(stoppedAtMs: number | null, nowMs: number): boolean {
  if (stoppedAtMs === null || !Number.isFinite(stoppedAtMs)) return false;
  return nowMs - stoppedAtMs > IDLE_LIMIT_MS;
}

export function readStoppedAt(storage: KeyValue): number | null {
  try {
    const raw = storage.getItem(SESSION_STOPPED_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeStoppedAt(storage: KeyValue, nowMs: number): void {
  try {
    storage.setItem(SESSION_STOPPED_KEY, String(nowMs));
  } catch {
    // Storage full or unavailable: losing the marker only means a long pause keeps its session.
  }
}

export function clearStoppedAt(storage: KeyValue): void {
  try {
    storage.removeItem(SESSION_STOPPED_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

export type LaunchDecision = { fresh: true; paused: true; playheadSec: 0 } | { fresh: false };

/** What to do when the app opens: a new session starts paused at zero; otherwise nothing changes. */
export function sessionOnLaunch(stoppedAtMs: number | null, nowMs: number): LaunchDecision {
  return isNewSession(stoppedAtMs, nowMs) ? { fresh: true, paused: true, playheadSec: 0 } : { fresh: false };
}

/** Returns a new map with one more play for `key`. The input is not changed. */
export function countPlay(counts: Readonly<Record<string, number>>, key: string): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

/** A new session forgets every play count. */
export function resetSessionCounts(_counts: Readonly<Record<string, number>>): Record<string, number> {
  return {};
}

/** How far a row is darkened for a given play count: 0 is the white default, capped at MAX_SHADE_STEP. */
export function shadeStep(plays: number): number {
  if (!Number.isFinite(plays) || plays <= 0) return 0;
  return Math.min(Math.floor(plays), MAX_SHADE_STEP);
}
