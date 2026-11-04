import type { LocalStatus } from './local-audio';

/**
 * QUEUE-CTRL-001: what a song card says about its own audio.
 *
 * Two distinct things the owner conflated, and both design models refused to merge: the **queue
 * cache** is automatic, evictable and LRU (the GB limit governs it), while a **kept** copy is a
 * deliberate user action living in the Music folder that nothing here ever deletes. A kept copy
 * also makes the song playable, so it reports ready with its own wording.
 */
export type CacheState = 'ready' | 'downloading' | 'queued' | 'failed' | 'blocked';

export interface CardCache {
  state: CacheState;
  /** Paired with text, never the only signal — colour alone may not carry state. */
  glyph: string;
  text: string;
  /** Non-null only for a permanently kept copy. */
  keptText: string | null;
  kept: boolean;
  /** Rail width, 0-100. Real job progress only; an unknown percent reads 0, never a guess. */
  progress: number;
  /** Downloading, but the job has not reported a percent: show motion, not a fake number. */
  indeterminate: boolean;
}

export function cacheStateOf(o: {
  status: LocalStatus;
  kept: boolean;
  percent: number | null;
  blocked: boolean;
  /** False when the song sits beyond the preload target, so "Queued" does not look stalled. */
  inTarget: boolean;
  error: string | null;
}): CardCache {
  const keptText = o.kept ? 'Kept in Music folder' : null;
  const base = { keptText, kept: o.kept, indeterminate: false };
  if (o.status === 'ready') return { ...base, state: 'ready', glyph: '✓', text: 'Ready in queue cache', progress: 100 };
  if (o.kept) return { ...base, state: 'ready', glyph: '✓', text: 'Ready from kept copy', progress: 100 };
  if (o.status === 'running') {
    const p = typeof o.percent === 'number' && Number.isFinite(o.percent) ? Math.max(0, Math.min(100, Math.round(o.percent))) : null;
    return { ...base, state: 'downloading', glyph: '↓', text: p === null ? 'Caching' : `Caching · ${p}%`,
      progress: p ?? 0, indeterminate: p === null };
  }
  if (o.status === 'missing') {
    // The cache being full is not the song's fault, and it clears by raising the limit.
    if (o.blocked) return { ...base, state: 'blocked', glyph: '⊘', text: 'Cache full · Raise the cache limit', progress: 0 };
    return { ...base, state: 'failed', glyph: '!', text: o.error ? `Unavailable · ${o.error}` : 'Unavailable', progress: 0 };
  }
  return { ...base, state: 'queued', glyph: '◷', text: o.inTarget ? 'Queued' : 'Queued · Outside preload target', progress: 0 };
}

export interface PreloadSetting { target: 'all' | 'count'; count: number }
/** The GB cap always outranks this; the preloader itself stops when the cache cannot fit more. */
export function preloadPlan<T>(keys: readonly T[], o: PreloadSetting): T[] {
  return o.target === 'all' ? [...keys] : keys.slice(0, Math.max(1, Math.floor(o.count)));
}

/** Each slot is a separate yt-dlp process, so a phone gets a lower ceiling than a desktop. */
export function parallelRange(platform: 'android' | 'windows' | 'browser'): { min: number; max: number; def: number } {
  if (platform === 'android') return { min: 1, max: 3, def: 1 };
  if (platform === 'windows') return { min: 1, max: 6, def: 2 };
  return { min: 1, max: 1, def: 1 };
}
