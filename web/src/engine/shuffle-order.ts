/**
 * SHUFFLE-ORDER-001 (owner, 2026-11-20): with shuffle on, the now playing queue shows the order songs will actually
 * play in. The songs still to come get ONE shuffled order (weighted by the listening mood when it has an answer),
 * written into the list: songs already heard this round above, the song playing, then the songs to come in order.
 * Playback walks that order (stepQueue `inOrder`), so the queue and the player never disagree.
 */
import type { RecItem } from '../api';
import { MOOD_FIT_UNKNOWN, moodShufflePick } from './mood-shuffle';
import { rowArtist, runArtist, spreadInsert } from './artist-variety';

export interface ShuffleMoodFit { fit: ReadonlyMap<string, number>; confidence: number; adventurous: number }
export interface ArrangeShuffleOpts {
  playingKey: string | null;
  /** Songs heard this round (the song playing included). */
  heard: ReadonlySet<string>;
  /** The order last shown for the songs to come. */
  order: readonly string[];
  /** Make a new order (shuffle just turned on, or a new round). */
  reshuffle: boolean;
  rand: () => number;
  mood?: ShuffleMoodFit | null;
  /** Songs that can play now; the first song to come must be one of them. */
  ready?: (x: RecItem) => boolean;
  hidden?: ReadonlySet<string>;
  /**
   * ARTIST-RUN-001 / WP4 (S4): artist credits of the songs played, oldest first (what stepQueue gets). Absent: the
   * songs heard this round in list order, then the song playing.
   */
  recentArtists?: readonly string[];
  /**
   * WP5 (S8): the fits the order shown was dealt with (what the last call returned as `dealtFit`). `null` or absent: it
   * was dealt before any mood answer, and the first answer may re-deal its unheard tail once.
   */
  dealtFit?: ReadonlyMap<string, number> | null;
  /** WP5 (S8): a star, dislike or Find similar since the order shown was dealt. A finished song alone never re-deals. */
  activeSignal?: boolean;
}

/** WP5 (S8): a re-deal is skipped when the fits over the tail moved less than this on average. */
export const REDEAL_MIN_CHANGE = 0.15;

export function arrangeShuffle(items: RecItem[], o: ArrangeShuffleOpts): { items: RecItem[]; order: string[]; dealtFit: ReadonlyMap<string, number> | null } {
  const key = (x: RecItem) => x.track.key;
  const current = o.playingKey ? items.find((x) => key(x) === o.playingKey) : undefined;
  const hiddenRows = items.filter((x) => x !== current && o.hidden?.has(key(x)));
  const history = items.filter((x) => x !== current && !o.hidden?.has(key(x)) && o.heard.has(key(x)));
  const coming = items.filter((x) => x !== current && !o.hidden?.has(key(x)) && !o.heard.has(key(x)));
  const byKey = new Map(coming.map((x) => [key(x), x] as const));
  const mood = o.mood && o.mood.confidence > 0 ? o.mood : null;
  // One weighted draw without replacement of `rows`, after a song by `last`.
  const deal = (rows: readonly RecItem[], last: string): string[] => {
    const pool = [...rows];
    const out: string[] = [];
    // ARTIST-VARIETY-001 (owner, 2026-11-24): the draw skips the artist just drawn (the song playing first) while
    // another artist is left, so one artist's songs are spread through the order instead of bunched together.
    while (pool.length) {
      const others = last ? pool.filter((x) => rowArtist(x.track) !== last) : pool;
      // An artist holding half of what is left goes now (when it may), or its songs end up together at the end.
      const count = new Map<string, number>();
      for (const x of others) count.set(rowArtist(x.track), (count.get(rowArtist(x.track)) ?? 0) + 1);
      const [top, n] = [...count].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
      const from = n * 2 >= pool.length && n < others.length ? others.filter((x) => rowArtist(x.track) === top) : others.length ? others : pool;
      const pick = mood
        ? moodShufflePick(from, key, mood.fit, { adventurous: mood.adventurous, confidence: mood.confidence, rand: o.rand })
        : from[Math.min(from.length - 1, Math.floor(o.rand() * from.length))]!;
      last = rowArtist(pick.track);
      pool.splice(pool.indexOf(pick), 1);
      out.push(key(pick));
    }
    return out;
  };
  let order: string[];
  let dealtFit: ReadonlyMap<string, number> | null = o.dealtFit ?? null;
  const known = o.reshuffle ? [] : o.order.filter((k) => byKey.has(k));
  if (!known.length) {
    // A new order: every song to come in one weighted draw without replacement. (Not by `added`: putting those first
    // once left a whole Discover list unshuffled. Since WP1/A8 found rows carry `found`, and hand-added rows join the
    // draw like any other song to come.)
    order = deal(coming, current ? rowArtist(current.track) : '');
    dealtFit = mood ? mood.fit : null;
  } else {
    // Keep the order shown; a song found since is mixed in behind the song already shown next. One the listener put
    // straight after the song playing (adding a song to the queue does that) plays next.
    order = [...known];
    const have = new Set(order);
    const at = current ? items.indexOf(current) : -1;
    const askedNext = at >= 0 ? items[at + 1] : undefined;
    // WP4 (S3): a song found since takes a spaced slot (spreadInsert, the PlayQueue.kt spacedSlot twin): neighbours by
    // other artists where there is one, never in front of the song already shown next.
    const artistOfKey = (k: string) => rowArtist(byKey.get(k)!.track);
    for (const x of coming) {
      if (have.has(key(x))) continue;
      if (x === askedNext) order.unshift(key(x));
      else spreadInsert(order, key(x), artistOfKey, o.rand, order.length ? 1 : 0);
      have.add(key(x));
    }
    // WP5 (S8): re-deal the unheard tail when a mood answer follows an active signal (star, dislike, Find similar), or
    // is the first answer for an order dealt before any. The song playing and the next two stay (they are committed:
    // the player cues the next one); with nothing playing nothing is committed and the whole order is redrawn. Skipped
    // when the fits over the tail moved less than REDEAL_MIN_CHANGE on average since the deal.
    if (mood && (o.activeSignal || !o.dealtFit)) {
      const keep = current ? Math.min(2, order.length) : 0;
      const tail = order.slice(keep);
      const before = o.dealtFit;
      const fitOf = (m: ReadonlyMap<string, number> | null | undefined, k: string) => m?.get(k) ?? MOOD_FIT_UNKNOWN;
      const change = tail.length ? tail.reduce((t, k) => t + Math.abs(fitOf(mood.fit, k) - fitOf(before, k)), 0) / tail.length : 0;
      if (tail.length > 1 && change >= REDEAL_MIN_CHANGE) {
        const last = keep ? artistOfKey(order[keep - 1]!) : current ? rowArtist(current.track) : '';
        order = [...order.slice(0, keep), ...deal(tail.map((k) => byKey.get(k)!), last)];
      }
      // Either way the order now rests on this answer, so the first-answer re-deal is spent.
      dealtFit = mood.fit;
    }
  }
  // The song shown next must be able to play now; one still downloading waits further down.
  if (o.ready && order.length && !o.ready(byKey.get(order[0]!)!)) {
    const i = order.findIndex((k) => o.ready!(byKey.get(k)!));
    if (i > 0) order.unshift(...order.splice(i, 1));
  }
  // WP4 (S4, ARTIST-RUN-001): the first song to come never makes a fifth in a row by one artist while a song by another
  // (that can play now) is waiting, so under inOrder stepQueue's breakRun has nothing left to change and the row after
  // the song playing is the song the player takes.
  const run = runArtist(o.recentArtists ?? [...history, ...(current ? [current] : [])].map((x) => rowArtist(x.track)));
  if (run && order.length && rowArtist(byKey.get(order[0]!)!.track) === run) {
    const i = order.findIndex((k) => rowArtist(byKey.get(k)!.track) !== run && (!o.ready || o.ready(byKey.get(k)!)));
    if (i > 0) order.unshift(...order.splice(i, 1));
  }
  const out = [...history, ...(current ? [current] : []), ...order.map((k) => byKey.get(k)!), ...hiddenRows];
  const same = out.length === items.length && out.every((x, i) => x === items[i]) && out.every((x, i) => x.rank === i + 1);
  return { items: same ? items : out.map((x, i) => (x.rank === i + 1 ? x : { ...x, rank: i + 1 })), order, dealtFit };
}

/** Shuffle off: the list in its own order again (`keys`); songs that arrived meanwhile follow in their places. */
export function restoreOrder(items: RecItem[], keys: readonly string[]): RecItem[] {
  const at = new Map(keys.map((k, i) => [k, i] as const));
  const known = items.filter((x) => at.has(x.track.key)).sort((a, b) => at.get(a.track.key)! - at.get(b.track.key)!);
  const later = items.filter((x) => !at.has(x.track.key));
  return [...known, ...later].map((x, i) => (x.rank === i + 1 ? x : { ...x, rank: i + 1 }));
}

/**
 * SHUFFLE-ONCE-001 (owner, 2026-11-24): the songs on record as heard, finished or skipped, from the engine's feedback
 * state. The queue's shuffle does not come back to them.
 */
export function heardIn(state: Record<string, Partial<Record<string, boolean>> | undefined>): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(state)) if (v?.['complete'] || v?.['skip'] || v?.['partial']) out.add(k);
  return out;
}

/** This round's heard songs and those on record, as one set. */
export function unionHeard(round: ReadonlySet<string>, record: ReadonlySet<string>): ReadonlySet<string> {
  if (!record.size) return round;
  const all = new Set(record);
  for (const k of round) all.add(k);
  return all;
}

/**
 * SHUFFLE-ONCE-001: every song that started playing in the now playing queue, kept on this device, newest last. A song
 * left mid-way (the app closed, a quick skip the engine does not count as heard) is still heard for the shuffle.
 */
export const QUEUE_STARTED_KEY = 'airwave.queue-started';
const QUEUE_STARTED_MAX = 3000;

export function startedOnRecord(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(QUEUE_STARTED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []);
  } catch { return new Set(); }
}

export function rememberStarted(key: string): void {
  try {
    const keys = [...startedOnRecord()].filter((k) => k !== key);
    keys.push(key);
    localStorage.setItem(QUEUE_STARTED_KEY, JSON.stringify(keys.slice(-QUEUE_STARTED_MAX)));
  } catch { /* storage full or blocked: this session's round still holds it */ }
}

/**
 * WP5 (plan step 4): the shuffled order of the songs to come, kept on this device, so a restart carries on with the
 * order the listener was already shown instead of dealing a new one. Kept with the round it belongs to (`epoch`) and
 * the seed it was drawn from (step 5).
 */
export const SHUFFLE_ORDER_KEY = 'airwave.shuffle-order';
/** An order is taken up again only while this share of it is still in the queue; below that, deal fresh. */
export const ORDER_KEEP_SHARE = 0.6;

export interface KeptShuffleOrder { order: readonly string[]; epoch: number; seed: number }

export function keepOrder(o: KeptShuffleOrder): void {
  try { localStorage.setItem(SHUFFLE_ORDER_KEY, JSON.stringify({ order: [...o.order], epoch: o.epoch, seed: o.seed })); }
  catch { /* storage full or blocked: this session still holds the order in memory */ }
}

/** Shuffle off, or a round that will never come back: nothing to take up again. */
export function forgetOrder(): void {
  try { localStorage.removeItem(SHUFFLE_ORDER_KEY); }
  catch { /* nothing kept, nothing to drop */ }
}

/**
 * WP5 (plan step 4): the kept order narrowed to the keys still in the queue, or null when there is nothing worth
 * taking up: nothing kept, a damaged entry, another round (`epoch`), or fewer than ORDER_KEEP_SHARE of its keys left —
 * the queue has moved on under it, so that round deals fresh.
 */
export function keptOrder(epoch: number, inQueue: ReadonlySet<string>): { order: string[]; seed: number } | null {
  try {
    const raw = localStorage.getItem(SHUFFLE_ORDER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<KeptShuffleOrder> | null;
    if (!v || !Array.isArray(v.order) || typeof v.epoch !== 'number' || typeof v.seed !== 'number') return null;
    if (v.epoch !== epoch) return null;
    const order = v.order.filter((k): k is string => typeof k === 'string');
    if (!order.length) return null;
    const left = order.filter((k) => inQueue.has(k));
    if (left.length / order.length < ORDER_KEEP_SHARE) return null;
    return { order: left, seed: v.seed };
  } catch { return null; }
}

/**
 * WP5 (plan step 5): the shuffle's draw comes from this generator, seeded by the number kept with the order, so an
 * order in a bug report can be dealt again. A 32-bit LCG (Numerical Recipes): small, no imports, and the same answer
 * on every device.
 */
export function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A seed for a fresh order, kept with it. */
export function newShuffleSeed(rand: () => number = Math.random): number {
  return Math.floor(rand() * 2 ** 32) >>> 0;
}
