/** DISCOVERY-001: a batch adds songs; its limit never truncates the existing list. */
import { matchRecordings } from './identity';

type Track = Record<string, any>;
type Item = { track: Track; rank?: number; [key: string]: any };

/** QUEUE-KEEP-DISCOVER-001: top up at five songs left, so a run (30-60 s) finishes before the queue runs dry. */
export const LISTENING_LOW_WATER = 5;

export function newDiscoveryTracks<T extends Track>(candidates: T[], existing: Track[]): T[] {
  const seen = [...existing];
  return candidates.filter((track) => {
    if (
      seen.some(
        (old) => old['key'] === track['key'] || matchRecordings(old, track).verdict === 'same',
      )
    )
      return false;
    seen.push(track);
    return true;
  });
}

export function appendDiscovery<T extends Item>(existing: T[], incoming: T[], limit: number): T[] {
  const fresh = new Set(
    newDiscoveryTracks(
      incoming.map((x) => x.track),
      existing.map((x) => x.track),
    ),
  );
  return [...existing, ...incoming.filter((x) => fresh.has(x.track)).slice(0, limit)].map(
    (x, i) => ({ ...x, rank: i + 1 }),
  );
}

/** Explicit completion only: no provider work on skips, previews outside the list, loops or seeks. */
export function needsListeningDiscovery(
  enabled: boolean,
  kind: string,
  inList: boolean,
  remaining: number,
): boolean {
  // QUEUE-KEEP-DISCOVER-001: a skip is listening too; skipping through a queue must not leave it to run dry.
  // WP3 (A3): a Next press mid-song (partial) is listening as well.
  return enabled && (kind === 'complete' || kind === 'skip' || kind === 'partial') && inList && remaining <= LISTENING_LOW_WATER;
}
