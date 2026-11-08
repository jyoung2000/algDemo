/**
 * Which starting songs one discovery run asks the music services about (PLAYLIST-QUEUE-001).
 *
 * Every starting song costs about ten provider requests per run (radio, related songs, artist top,
 * search on each service). A playlist sent to the now playing queue makes every one of its songs a
 * starting song, so a 60-song list would cost some 600 requests and minutes per run. Instead a run
 * asks about a window of at most SEED_GATHER_MAX songs, and the next run moves the window on, so the
 * whole list is asked about over a few runs. Every starting song still counts when the songs found are
 * scored (similarity to each one), with its profile from the cache when the services have been asked
 * about it before.
 */
export const SEED_GATHER_MAX = 8;

/**
 * The window for this run and the cursor for the next. `pinned` songs at the front of the list (the
 * song just heard, for a listening run) are in every window.
 */
export function seedWindow<T>(seeds: T[], cursor: number, pinned = 0, max = SEED_GATHER_MAX): { window: T[]; next: number } {
  if (seeds.length <= max) return { window: seeds, next: 0 };
  const head = seeds.slice(0, pinned);
  const rest = seeds.slice(pinned);
  const room = max - head.length;
  const start = ((Math.trunc(cursor) % rest.length) + rest.length) % rest.length;
  const picked = Array.from({ length: Math.min(room, rest.length) }, (_, i) => rest[(start + i) % rest.length]!);
  return { window: [...head, ...picked], next: (start + room) % rest.length };
}
