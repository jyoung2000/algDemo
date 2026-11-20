/**
 * SHUFFLE-ORDER-001 (owner, 2026-11-20): with shuffle on, the now playing queue shows the order songs will actually
 * play in. The songs still to come get ONE shuffled order (weighted by the listening mood when it has an answer),
 * written into the list: songs already heard this round above, the song playing, then the songs to come in order.
 * Playback walks that order (stepQueue `inOrder`), so the queue and the player never disagree.
 */
import type { RecItem } from '../api';
import { moodShufflePick } from './mood-shuffle';

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
}

export function arrangeShuffle(items: RecItem[], o: ArrangeShuffleOpts): { items: RecItem[]; order: string[] } {
  const key = (x: RecItem) => x.track.key;
  const current = o.playingKey ? items.find((x) => key(x) === o.playingKey) : undefined;
  const hiddenRows = items.filter((x) => x !== current && o.hidden?.has(key(x)));
  const history = items.filter((x) => x !== current && !o.hidden?.has(key(x)) && o.heard.has(key(x)));
  const coming = items.filter((x) => x !== current && !o.hidden?.has(key(x)) && !o.heard.has(key(x)));
  const byKey = new Map(coming.map((x) => [key(x), x] as const));
  let order: string[];
  const known = o.reshuffle ? [] : o.order.filter((k) => byKey.has(k));
  if (!known.length) {
    // A new order: every song to come in one weighted draw without replacement. (Not by `added`: songs found by a
    // custom discovery carry it too, and putting them first left a whole Discover list unshuffled.)
    const pool = [...coming];
    order = [];
    while (pool.length) {
      const pick = o.mood && o.mood.confidence > 0
        ? moodShufflePick(pool, key, o.mood.fit, { adventurous: o.mood.adventurous, confidence: o.mood.confidence, rand: o.rand })
        : pool[Math.min(pool.length - 1, Math.floor(o.rand() * pool.length))]!;
      pool.splice(pool.indexOf(pick), 1);
      order.push(key(pick));
    }
  } else {
    // Keep the order shown; a song found since is mixed in behind the song already shown next. One the listener put
    // straight after the song playing (adding a song to the queue does that) plays next.
    order = [...known];
    const have = new Set(order);
    const at = current ? items.indexOf(current) : -1;
    const askedNext = at >= 0 ? items[at + 1] : undefined;
    for (const x of coming) {
      if (have.has(key(x))) continue;
      if (x === askedNext) order.unshift(key(x));
      else order.splice(order.length ? 1 + Math.floor(o.rand() * order.length) : 0, 0, key(x));
      have.add(key(x));
    }
  }
  // The song shown next must be able to play now; one still downloading waits further down.
  if (o.ready && order.length && !o.ready(byKey.get(order[0]!)!)) {
    const i = order.findIndex((k) => o.ready!(byKey.get(k)!));
    if (i > 0) order.unshift(...order.splice(i, 1));
  }
  const out = [...history, ...(current ? [current] : []), ...order.map((k) => byKey.get(k)!), ...hiddenRows];
  const same = out.length === items.length && out.every((x, i) => x === items[i]) && out.every((x, i) => x.rank === i + 1);
  return { items: same ? items : out.map((x, i) => (x.rank === i + 1 ? x : { ...x, rank: i + 1 })), order };
}

/** Shuffle off: the list in its own order again (`keys`); songs that arrived meanwhile follow in their places. */
export function restoreOrder(items: RecItem[], keys: readonly string[]): RecItem[] {
  const at = new Map(keys.map((k, i) => [k, i] as const));
  const known = items.filter((x) => at.has(x.track.key)).sort((a, b) => at.get(a.track.key)! - at.get(b.track.key)!);
  const later = items.filter((x) => !at.has(x.track.key));
  return [...known, ...later].map((x, i) => (x.rank === i + 1 ? x : { ...x, rank: i + 1 }));
}
