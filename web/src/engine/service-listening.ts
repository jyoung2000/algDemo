/**
 * QUEUE-HEARD-001 (owner, 2026-11-20): "my discover queue is the same set of songs even though I listened to every
 * song". With the phone app closed (screen off, Android Auto) the phone's engine plays the Discover queue by itself.
 * The service's engine page now does for each song it finishes what the phone page does: records the listen (taste
 * learns from it) and asks the engine whether the queue needs topping up. New songs join the end of the engine's
 * queue (EnginePlayer.appendFound), as Find similar's do from the car.
 *
 * Only while the phone app is not open (`pageLive: false`): an open page records and tops up its own queue. Only for
 * the Discover queue (media ids without '/'); a saved list or an album has its own rules. The listen id is the one the
 * phone page builds for the same engine event when it wakes, so the store keeps one copy and one top-up.
 */
import type { Track } from '../api';
import { listenFromEvent, type EngineEvent } from './native-engine';

export interface ListeningDeps<S extends { id: string } = { id: string; [k: string]: unknown }> {
  findTrack(key: string): Promise<Track | null> | Track | null;
  feedback(kind: 'complete' | 'skip' | 'partial', track: Track, extra: { event_id: string; listened: number; duration?: number; coverage: number; medium: string; origin: string }): Promise<unknown>;
  recommend(o: { event_id: string; exclude: string[] }): Promise<{ job: string | null; reason?: string }>;
  job(id: string): Promise<{ done: boolean; error?: string | null }>;
  last(): Promise<{ items: { track: Track }[] } | null>;
  song(t: Track): S;
  append(songs: S[]): void;
  wait(ms: number): Promise<void>;
}

type Event = EngineEvent & { at?: number };

/** The id of a listen the engine reported; the phone page and this page build the same one for the same event. */
export function engineEventId(kind: string, key: string, ev: { seq: number; at?: number }): string {
  return `${kind}:${key.slice(0, 40)}:${engineInstance(ev)}`.slice(0, 80);
}
/** `engine-<seq>-<when>`; an engine too old to say when falls back to now (one copy per page, as before). */
export function engineInstance(ev: { seq: number; at?: number }): string {
  return `engine-${ev.seq}-${typeof ev.at === 'number' && Number.isFinite(ev.at) ? ev.at : Date.now().toString(36)}`;
}

const POLL_MS = 1500;
/** A top-up is a discovery run (30-60 s); past this it is left to finish on its own and its songs wait for the page. */
const JOB_WAIT_MS = 240_000;

export class ServiceListening<S extends { id: string } = { id: string; [k: string]: unknown }> {
  private readonly seen = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private topping = false;

  constructor(private readonly d: ListeningDeps<S>) {}

  /** One native player state (`window.__awServiceState`). */
  onState(json: unknown): void {
    let o: Record<string, unknown>;
    try {
      o = (typeof json === 'string' ? JSON.parse(json) : json) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!o || typeof o !== 'object' || o['pageLive'] !== false) return;
    const ev = o['event'] as Event | undefined;
    if (!ev || typeof ev.seq !== 'number' || !ev.from || typeof ev.from.id !== 'string' || !ev.from.id) return;
    const mediaId = typeof o['mediaId'] === 'string' ? (o['mediaId'] as string) : '';
    if (mediaId.includes('/') || ev.from.id.includes('/')) return;
    const mark = `${ev.seq}:${ev.at ?? ''}:${ev.from.id}`;
    if (this.seen.has(mark)) return;
    this.seen.add(mark);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value as string);
    this.chain = this.chain.then(() => this.handle(ev)).catch(() => undefined);
  }

  /** Resolves once every event seen so far has been handled (tests, and nothing else waits on it). */
  idle(): Promise<void> {
    return this.chain;
  }

  private async handle(ev: Event): Promise<void> {
    const listen = listenFromEvent(ev);
    if (!listen) return;
    const track = await this.d.findTrack(ev.from.id);
    if (!track) return;
    const eventId = engineEventId(listen.kind, track.key, ev);
    await this.d.feedback(listen.kind, track, {
      event_id: eventId,
      listened: Math.round(listen.listened * 10) / 10,
      ...(listen.duration !== null ? { duration: listen.duration } : {}),
      coverage: Math.round(listen.coverage * 10) / 10,
      medium: 'full',
      origin: 'queue',
    });
    if (this.topping) return;
    this.topping = true;
    try {
      const before = new Set(((await this.d.last())?.items ?? []).map((x) => x.track.key));
      const { job } = await this.d.recommend({ event_id: eventId, exclude: [] });
      if (!job) return;
      const until = Date.now() + JOB_WAIT_MS;
      for (;;) {
        const st = await this.d.job(job);
        if (st.done) {
          if (st.error) return;
          break;
        }
        if (Date.now() > until) return;
        await this.d.wait(POLL_MS);
      }
      const fresh = ((await this.d.last())?.items ?? []).map((x) => x.track).filter((t) => t?.key && !before.has(t.key));
      if (fresh.length) this.d.append(fresh.map((t) => this.d.song(t)));
    } finally {
      this.topping = false;
    }
  }
}
