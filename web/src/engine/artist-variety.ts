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
