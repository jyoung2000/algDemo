/**
 * MOOD-DEFAULT-CAR-001 (owner, 2026-11-25): "ensure the discover tab by default tries to find music based on your
 * current listening mood, ensure it works on windows, android, and android auto". Android Auto has no Discover tab,
 * so Playlists > "Discover for my mood" runs the same ordinary Discover run the phone's tab does (MOOD-DEFAULT-001:
 * it starts from the listening mood) and the songs it finds join the end of the car's now playing queue.
 */
import type { Track } from '../api';

export interface CarMoodDiscoverAnswer { added: number; leading: string[]; reason: string; songs: unknown[] }

interface JobStatus { done: boolean; error?: string | null }

export interface CarMoodDiscoverDeps<S> {
  recommend: () => Promise<{ job: string | null; reason?: string; mood?: string[] }>;
  job: (id: string) => Promise<JobStatus>;
  last: () => Promise<{ items: { track: Track }[] } | null>;
  song: (t: Track) => S;
  wait: (ms: number) => Promise<void>;
  /** The list after the run, for the page that shows it. */
  onQueue?: (queue: unknown) => void;
}

const POLL_MS = 1000;
/** A Discover run takes 30-60 s; past this the car stops waiting (the run still finishes into the list). */
const LIMIT_MS = 180_000;

export async function runCarMoodDiscover<S>(d: CarMoodDiscoverDeps<S>): Promise<{ added: number; leading: string[]; reason: string; songs: S[] }> {
  const before = new Set(((await d.last())?.items ?? []).map((x) => x.track.key));
  const started = await d.recommend();
  const leading = (started.mood ?? []).slice(0, 3);
  if (!started.job) return { added: 0, leading, reason: started.reason || 'Discovery could not start right now.', songs: [] };
  const t0 = Date.now();
  for (;;) {
    const st = await d.job(started.job);
    if (st.done) {
      if (st.error) throw new Error(st.error);
      break;
    }
    if (Date.now() - t0 > LIMIT_MS) throw new Error('Still discovering. The songs will join your queue when it finishes.');
    await d.wait(POLL_MS);
  }
  const last = await d.last();
  const fresh = (last?.items ?? []).map((x) => x.track).filter((t) => t?.key && !before.has(t.key));
  if (last && fresh.length) d.onQueue?.(last);
  return {
    added: fresh.length,
    leading,
    reason: fresh.length ? '' : 'No new songs for this mood right now. Your queue is unchanged.',
    songs: fresh.slice(0, 50).map((t) => d.song(t)),
  };
}

/** What the car is told when a run ends. */
export function carMoodDiscoverText(a: { added: number; leading: string[]; reason: string }): string {
  if (!a.added) return a.reason || 'No new songs for this mood right now.';
  const mood = a.leading.length ? ` for your mood (${a.leading.join(' · ')})` : ' for your mood';
  return `Added ${a.added} new song${a.added === 1 ? '' : 's'}${mood}.`;
}
