import { clearStoppedAt, isNewSession, readStoppedAt } from './session';
import { QUEUE_STARTED_KEY } from './shuffle-order';

/**
 * Session reset state (0.20.20). Persisted so a fresh listening session survives a reload:
 * - the cleared set: queued songs the listener has not played since the session reset. The server's
 *   feedback state would otherwise re-mark them heard on the next load, so they are subtracted from it.
 * - the play counts: plays per song this session, for the discovery row shading.
 */
export const SESSION_CLEARED_KEY = 'airwave.session-cleared';
export const SESSION_PLAYS_KEY = 'airwave.session-plays';

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function readJson(s: KV, key: string): unknown {
  try {
    return JSON.parse(s.getItem(key) ?? 'null') as unknown;
  } catch {
    return null;
  }
}

function writeJson(s: KV, key: string, value: unknown): void {
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the reset is then best effort for this session.
  }
}

export function clearedKeys(s: KV): Set<string> {
  const v = readJson(s, SESSION_CLEARED_KEY);
  return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []);
}

/** Heard songs with the cleared ones taken out: those are eligible for shuffle again this session. */
export function subtractCleared(heard: ReadonlySet<string>, cleared: ReadonlySet<string>): ReadonlySet<string> {
  if (!cleared.size) return heard;
  const out = new Set<string>();
  for (const k of heard) if (!cleared.has(k)) out.add(k);
  return out;
}

/** Drops the given keys from the queue's started record, keeping the order of the rest. */
export function forgetStarted(s: KV, keys: readonly string[]): void {
  const drop = new Set(keys);
  const v = readJson(s, QUEUE_STARTED_KEY);
  const kept = Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && !drop.has(k)) : [];
  writeJson(s, QUEUE_STARTED_KEY, kept);
}

/** Fresh session: the queue's songs count as unplayed again for shuffle. */
export function clearQueueForSession(s: KV, keys: readonly string[]): void {
  if (!keys.length) return;
  const cleared = clearedKeys(s);
  for (const k of keys) cleared.add(k);
  writeJson(s, SESSION_CLEARED_KEY, [...cleared]);
  forgetStarted(s, keys);
}

/** A queued song played this session is heard again, as usual. */
export function unclearKey(s: KV, key: string): void {
  const cleared = clearedKeys(s);
  if (cleared.delete(key)) writeJson(s, SESSION_CLEARED_KEY, [...cleared]);
}

export function readPlays(s: KV): Record<string, number> {
  const v = readJson(s, SESSION_PLAYS_KEY);
  const out: Record<string, number> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[k] = n;
    }
  }
  return out;
}

export function writePlays(s: KV, plays: Readonly<Record<string, number>>): void {
  writeJson(s, SESSION_PLAYS_KEY, plays);
}

/**
 * Runs at launch and on a foreground return. If audio has been stopped for more than the idle limit,
 * this is a new session: play counts clear and the stop marker is cleared. Returns whether it was fresh.
 */
export function beginFreshSession(s: KV, nowMs: number): boolean {
  if (!isNewSession(readStoppedAt(s), nowMs)) return false;
  writePlays(s, {});
  clearStoppedAt(s);
  return true;
}
