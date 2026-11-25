/**
 * ARTIST-VARIETY-001 (owner, 2026-11-24): "shuffle / listening mood needs more artist variety, I was listening to a lot
 * of electronic rap but only kept getting slayr music when i hearted and listen to other artist as well".
 *
 * The cap of two songs per artist used to hold for one discovery batch only, and every top-up (one per song heard while
 * the queue runs low, seeded from the song just heard) added up to two more by the same artist. These helpers count
 * what is already there, so the cap holds for the queue as a whole.
 */
import { primaryArtist } from './engine';

/**
 * Songs per artist (primaryArtist) still to play in the queue (`items` not in `heard`). Only songs still waiting count:
 * a queue heard through caps nobody, so a top-up can never come back empty because of this (QUEUE-NEVER-DRY-001).
 */
export function artistLoad(
  items: readonly { track: { key?: unknown; artists?: unknown; artist?: unknown } }[],
  heard: ReadonlySet<string>,
): Record<string, number> {
  const load: Record<string, number> = {};
  const seen = new Set<string>();
  for (const x of items) {
    const key = String(x.track.key ?? '');
    if (!key || heard.has(key) || seen.has(key)) continue;
    seen.add(key);
    const names = Array.isArray(x.track.artists) ? x.track.artists.map(String) : x.track.artist ? [String(x.track.artist)] : [];
    const a = primaryArtist({ artists: names });
    if (a) load[a] = (load[a] ?? 0) + 1;
  }
  return load;
}

/** The artist a queue row is by, as the engine names it (for keeping one artist's songs apart). */
export function rowArtist(t: { artists?: readonly string[] | null; artist?: string | null }): string {
  return primaryArtist({ artists: t.artists?.length ? [...t.artists] : t.artist ? [t.artist] : [] });
}

/**
 * ARTIST-RUN-001 (owner, 2026-11-24): "On shuffle ensure the same artist cant be played more than 4 times in a row on
 * the discover tab if the discover / now playing queue has multiple artist".
 */
export const MAX_ARTIST_RUN = 4;

/**
 * The artist (as the engine names it) of the last MAX_ARTIST_RUN plays when they were all by one artist, else ''.
 * [recent] holds the artist credits of the songs played, oldest first.
 */
export function runArtist(recent: readonly string[]): string {
  if (recent.length < MAX_ARTIST_RUN) return '';
  const last = recent.slice(-MAX_ARTIST_RUN).map((a) => primaryArtist({ artists: [a] }));
  return last[0] && last.every((a) => a === last[0]) ? last[0] : '';
}

/**
 * WP4 (A5, S3, S4, M3): one artist-variety rule, used everywhere. [artist] (as the engine names it) is one of the last
 * [gap] artists in [recentArtists] (oldest first), so placing it now would sit it too close to its own songs.
 */
export function tooClose(recentArtists: readonly string[], artist: string, gap: number): boolean {
  if (!artist || gap <= 0) return false;
  return recentArtists.slice(-gap).includes(artist);
}

/**
 * WP4 (S3): put [item] into [order] at a random slot (at [from] or later) whose neighbours are other artists; when every
 * slot has that artist beside it, any slot from [from] will do. The web twin of PlayQueue.kt spacedSlot/insertSpaced
 * (WP7-APPEND-001), so the phone and the page space top-ups the same way. Returns the slot used.
 */
export function spreadInsert<T>(order: T[], item: T, artistOf: (x: T) => string, rand: () => number, from = 0): number {
  const a = artistOf(item);
  const slots: number[] = [];
  for (let i = Math.max(0, Math.min(from, order.length)); i <= order.length; i++) slots.push(i);
  const open = slots.filter((i) => (i === 0 || artistOf(order[i - 1]!) !== a) && (i >= order.length || artistOf(order[i]!) !== a));
  const pool = open.length ? open : slots;
  const at = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!;
  order.splice(at, 0, item);
  return at;
}

/** WP4 (A5): how many recent listens count against the per-artist cap, and the smallest batch before the escape. */
export const RECENT_LISTENS = 10;
export const NEVER_DRY_MIN = 5;

/**
 * WP4 (A5, ARTIST-VARIETY-001): the artist load a batch is chosen under is the songs waiting ([waiting], from
 * artistLoad) PLUS the artists of the last [n] listens ([listens] oldest first).
 */
export function withRecentListens(
  waiting: Readonly<Record<string, number>>,
  listens: readonly { artist?: unknown }[],
  n = RECENT_LISTENS,
): Record<string, number> {
  const load: Record<string, number> = { ...waiting };
  for (const r of listens.slice(-n)) {
    const a = primaryArtist({ artists: r.artist ? [String(r.artist)] : [] });
    if (a) load[a] = (load[a] ?? 0) + 1;
  }
  return load;
}

/**
 * WP4 (A5) never-dry escape (QUEUE-NEVER-DRY-001): choose under [full] (waiting + recent listens); if that batch would
 * come back with fewer than [min] songs, choose again under [waiting] alone (without the recent listens).
 */
export function selectNeverDry<T>(
  choose: (load: Readonly<Record<string, number>>) => T[],
  full: Readonly<Record<string, number>>,
  waiting: Readonly<Record<string, number>>,
  min = NEVER_DRY_MIN,
): T[] {
  const out = choose(full);
  return out.length >= min || full === waiting ? out : choose(waiting);
}
