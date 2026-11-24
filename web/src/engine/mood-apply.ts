/**
 * MOOD-QUEUE-001: which queue rows the listening mood may move, and putting its order back into the
 * list. Played songs, the song playing, songs before it and songs the listener added by hand keep
 * their exact places; only the other songs still to come trade places among themselves.
 */
import type { RecItem } from '../api';

/**
 * WP1 (plan 2026-11-24, A8) / QUEUE-ADD-001: a row the listener added by hand is pinned. Find-similar and custom-discovery
 * rows carry `found` instead and are movable. Old stored queues marked those `added` too: a row with `added` plus
 * `custom: true` or a `sound_match` key is read as a found row.
 */
export function isPinned(x: RecItem): boolean {
  const r = x as RecItem & { custom?: boolean; sound_match?: unknown };
  return Boolean(x.added) && !x.found && !r.custom && !('sound_match' in r);
}

export function moodMovable(items: RecItem[], o: { currentKey: string | null; played: ReadonlySet<string>; hidden?: ReadonlySet<string> }): RecItem[] {
  const at = o.currentKey ? items.findIndex((x) => x.track.key === o.currentKey) : -1;
  return items.filter((x, i) => i > at && !isPinned(x) && !o.played.has(x.track.key) && !o.hidden?.has(x.track.key) && x.track.key !== o.currentKey);
}

/** The list with the movable songs in `order`; every other row stays where it was. */
export function placeMood(items: RecItem[], order: string[]): RecItem[] {
  const want = new Set(order);
  const byKey = new Map(items.map((x) => [x.track.key, x] as const));
  const queue = order.filter((k) => byKey.has(k));
  const present = new Set(queue);
  let j = 0;
  const out = items.map((x) => (want.has(x.track.key) && present.has(x.track.key) ? byKey.get(queue[j++]!)! : x));
  return out.map((x, i) => (x.rank === i + 1 ? x : { ...x, rank: i + 1 }));
}

/**
 * QUEUE-NEXT-001: the song the player will play next (a shuffle or mood pick, or the next song that is ready) sits
 * directly after the song playing, so the queue says what the player will do. Ranks follow the new order. Returns
 * the same array when it already agrees, or when there is nothing to move (no song playing in the list, no next song,
 * or the next song is above the song playing, as in a repeat round).
 */
export function pinNext(items: RecItem[], playingKey: string | null, nextKey: string | null): RecItem[] {
  if (!playingKey || !nextKey || playingKey === nextKey) return items;
  const at = items.findIndex((x) => x.track.key === playingKey);
  const from = items.findIndex((x) => x.track.key === nextKey);
  if (at < 0 || from <= at || from === at + 1) return items;
  const out = [...items];
  const [moved] = out.splice(from, 1);
  out.splice(at + 1, 0, moved!);
  return out.map((x, i) => (x.rank === i + 1 ? x : { ...x, rank: i + 1 }));
}

/** The visible rows' places before a re-arrangement, so the move can be animated (FLIP). */
export function captureRows(root: ParentNode | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!root) return out;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('li.rec[id]'))) out.set(el.id, el.getBoundingClientRect().top);
  return out;
}

/**
 * Slides each moved row from where it was to where it is now, and marks the songs the mood moved.
 * With reduced motion the rows simply appear in place and only the mark shows.
 */
export function playMoodMove(root: ParentNode | null | undefined, before: Map<string, number>, movedIds: ReadonlySet<string>, reduced: boolean): void {
  if (!root) return;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('li.rec[id]'))) {
    if (movedIds.has(el.id)) {
      el.classList.remove('is-mood-moved');
      void el.offsetWidth;
      el.classList.add('is-mood-moved');
      window.setTimeout(() => el.classList.remove('is-mood-moved'), 1600);
    }
    if (reduced) continue;
    const was = before.get(el.id);
    if (was === undefined) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1 || Math.abs(dy) > 2400) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${Math.round(dy)}px)`;
    void el.offsetWidth;
    el.style.transition = 'transform 420ms cubic-bezier(.2,.8,.2,1)';
    el.style.transform = '';
    window.setTimeout(() => { el.style.transition = ''; }, 460);
  }
}
