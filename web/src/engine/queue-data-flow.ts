/**
 * QUEUE-DATA-FLOW-001 (owner, 2026-11-23): "the discovery / recommandation engine doesnt continously find new songs,
 * when on data the song discovery stops after a while and you repeat the same songs which isnt discovring music".
 *
 * What the tests showed (queue-data-flow.integration.test.ts, failing before this file existed):
 *  - the data allowance was NOT what stopped it: a queue heard through still topped up with the reserve at zero;
 *  - a top-up while listening only ever asked the starting songs (one of them, plus the song just heard) and one
 *    step of the taste colours. The starred artists and the artists the listening had learned were asked only when
 *    "Find my next favorite" was pressed by hand. Once the starting songs' own sources were spent, every top-up
 *    came back with songs the queue already held, so the queue went round again;
 *  - a song heard earlier came back as "new" as soon as it was no longer in the queue (a cleared or replaced queue);
 *  - one top-up on mobile data read as much as it liked (18 MB in the test).
 *
 * So a listening top-up now walks on through the listener's artists a few per run (more after a run that found
 * nothing), never offers a song already heard, asks the small sources before the large ones on mobile data, stays
 * under a small ceiling there, and says why when nothing new is left.
 */
import { fold } from './identity';

/** Where the walk through the listener's artists is kept between runs. */
export const FLOW_KEY = 'queue_flow';
/** Artists a top-up asks beside the starting songs. Small: each costs a handful of Deezer answers. */
export const FLOW_PER_RUN = 2;
/** After a top-up that found nothing new, the next one asks this many, so a dry spell ends quickly. */
export const FLOW_PER_DRY_RUN = 4;

export interface FlowState {
  /** Where the next run starts in the list of artists. */
  cursor: number;
  /** How many top-ups in a row found nothing new. */
  dry: number;
}

const whole = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

/** The saved state; anything missing or broken reads as the start. */
export function flowState(v: unknown): FlowState {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return { cursor: whole(o['cursor']), dry: whole(o['dry']) };
}

/** The next few of [pool], carrying on from where the last run stopped and coming round again at the end. */
export function flowPick<T>(pool: readonly T[], state: FlowState): { picked: T[]; next: number } {
  const count = state.dry > 0 ? FLOW_PER_DRY_RUN : FLOW_PER_RUN;
  if (pool.length <= count) return { picked: [...pool], next: 0 };
  const start = state.cursor % pool.length;
  return { picked: Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length] as T), next: (start + count) % pool.length };
}

type Row = { kind: string; key: string; track?: Record<string, unknown> | null };
type Song = { key?: unknown; title?: unknown; artists?: unknown; artist?: unknown };

const firstArtist = (t: Song | null | undefined): string => {
  const list = Array.isArray(t?.artists) ? (t!.artists as unknown[]) : [];
  const a = list.find((x): x is string => typeof x === 'string' && x.trim().length > 0) ?? (typeof t?.artist === 'string' ? t.artist : '');
  return fold(a);
};
const nameOf = (t: Song | null | undefined): string => {
  const title = typeof t?.title === 'string' ? fold(t.title) : '';
  const artist = firstArtist(t);
  return title && artist ? `${artist}\u0000${title}` : '';
};

/**
 * Whether a song has been heard: finished or skipped, under its own key or as the same title by the same artist
 * from another service. A song that was only liked, or never played, has not been heard.
 */
export function heardTest(rows: readonly Row[]): (t: Song) => boolean {
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'complete' && r.kind !== 'skip') continue;
    keys.add(r.key);
    const n = nameOf(r.track as Song | null);
    if (n) names.add(n);
  }
  return (t) => keys.has(String(t.key ?? '')) || names.has(nameOf(t) || '\u0001');
}

/** YouTube Music's answers are by far the largest; on mobile data everything else is asked first. Order is kept within each group. */
export function cheapestFirst<T extends { source: string }>(tasks: readonly T[]): T[] {
  const large = (t: T) => t.source.startsWith('ytmusic');
  return [...tasks.filter((t) => !large(t)), ...tasks.filter(large)];
}

const andList = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** What a top-up that found nothing new tells the listener: what it asked, and what the next one asks. */
export function dryReason(asked: { seeds: number; artists: readonly string[]; colours: number }, next: readonly string[]): string {
  const parts: string[] = [];
  if (asked.seeds > 0) parts.push(`your ${asked.seeds} starting ${asked.seeds === 1 ? 'song' : 'songs'}`);
  if (asked.artists.length) parts.push(andList(asked.artists.slice(0, 3)));
  if (asked.colours > 0) parts.push('your sound');
  const what = parts.length ? ` This run asked ${andList(parts)}.` : '';
  const then = next.length
    ? ` The next one asks ${andList(next.slice(0, 3))}.`
    : ' Star an artist or like a few songs and discovery has more to ask.';
  return `Nothing new this time: every song found is already in your queue or already heard.${what}${then}`;
}
