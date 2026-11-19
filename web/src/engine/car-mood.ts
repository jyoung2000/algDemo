/**
 * CAR-MOOD-001 (owner, 2026-11-19): Android Auto's now playing queue follows the listening mood too.
 * With the phone app open, its own queue (App.tsx, MOOD-QUEUE-001) is the car's queue. With the phone
 * closed the car's queue lives in the native player, so the service asks this page, which owns the
 * engine, for the mood order of the songs still to come, and moves only those.
 *
 * The native side sends the songs it may move (after the current one; Discover queue songs, or any
 * list while shuffle is on) by media id, plus the press that prompted it (star, dislike, Find similar,
 * a song that finished). The press is recorded as a mood signal first: with the phone closed the
 * engine has not heard it yet (CarFeedback hands it to the page later; local-api skips the echo).
 */
import type { Track } from '../api';
import { similarSeedKey } from './car-similar';

export type CarMoodKind = 'like' | 'dislike' | 'similar' | 'complete' | 'skip';
const KINDS: readonly CarMoodKind[] = ['like', 'dislike', 'similar', 'complete', 'skip'];

export interface CarMoodRequest { current: string | null; upcoming: string[]; signal?: { id: string; kind: string } | null }
export interface CarMoodAnswer { order: string[]; moved: string[]; changed: boolean; leading: string[]; off?: boolean }

export interface CarMoodDeps {
  findTrack: (key: string) => Track | null | Promise<Track | null>;
  mood: (body: { upcoming: { track: Track }[]; shown: string[]; current?: { track: Track }; signal?: { track: Track; kind: CarMoodKind } }) => Promise<{ order: string[]; moved: string[]; changed: boolean; leading?: string[]; off?: boolean }>;
}

export function carMoodKind(kind: string | undefined | null): CarMoodKind | null {
  return KINDS.includes(kind as CarMoodKind) ? (kind as CarMoodKind) : null;
}

/** The mood order for the car's movable songs, as media ids. Songs the engine cannot name keep their place. */
export async function runCarMood(req: CarMoodRequest, d: CarMoodDeps): Promise<CarMoodAnswer> {
  const ids = req.upcoming.filter((id) => typeof id === 'string' && id).slice(0, 500);
  const byKey = new Map<string, string>();
  const upcoming: { track: Track }[] = [];
  for (const id of ids) {
    const key = similarSeedKey(id);
    const t = key ? await d.findTrack(key) : null;
    if (!t || byKey.has(t.key)) continue;
    byKey.set(t.key, id);
    upcoming.push({ track: t });
  }
  const curKey = req.current ? similarSeedKey(req.current) : null;
  const curTrack = curKey ? await d.findTrack(curKey) : null;
  const kind = carMoodKind(req.signal?.kind);
  const sigKey = req.signal?.id ? similarSeedKey(req.signal.id) : null;
  const sigTrack = kind && sigKey ? (sigKey === curKey ? curTrack : await d.findTrack(sigKey)) : null;
  if (upcoming.length < 2) return { order: ids, moved: [], changed: false, leading: [] };
  const plan = await d.mood({
    upcoming,
    shown: upcoming.map((u) => u.track.key),
    ...(curTrack ? { current: { track: curTrack } } : {}),
    ...(sigTrack && kind ? { signal: { track: sigTrack, kind } } : {}),
  });
  if (plan.off || !plan.changed) return { order: ids, moved: [], changed: false, leading: plan.leading ?? [], ...(plan.off ? { off: true } : {}) };
  // The named songs in the engine's order fill the named songs' slots; unnamed ones stay put.
  const named = plan.order.map((k) => byKey.get(k)).filter((id): id is string => Boolean(id));
  const queue = [...named];
  const order = ids.map((id) => ([...byKey.values()].includes(id) ? queue.shift() ?? id : id));
  const moved = plan.moved.map((k) => byKey.get(k)).filter((id): id is string => Boolean(id));
  return { order, moved, changed: order.some((id, i) => id !== ids[i]), leading: plan.leading ?? [] };
}
