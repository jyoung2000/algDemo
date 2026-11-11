/**
 * FAST-PLAY-002. Owner: "I want to be able to play a song instantly when i click on it on all platforms".
 *
 * A click used to pay for the whole chain in front of the audio: find the song's full-song source,
 * then have the shell's yt-dlp name the source's own media file. Measured on Windows 0.18.0: 3,894 ms
 * from click to sound for a song that was neither looked up nor resolved, against 107 ms for one
 * that was. Both answers are already cached — by the engine's store and by the shell's stream
 * resolver — so the only thing that has to change is WHEN they are asked for.
 *
 * The warmer asks before the click, for the few songs a listener is about to press: the row under
 * the pointer or keyboard, the first rows of a list, the song queued next. It is deliberately mean
 * with work, because each resolve is a yt-dlp process: one song warmed once per window, a held file
 * never warmed, at most a couple of lookups at a time, and a hard budget on top, so showing a
 * thirty-row list never spawns thirty processes.
 */
import type { Track } from '../api';

export interface WarmPorts {
  /** The song's source link if the page already holds one — no network. */
  known: (track: Track) => string | null;
  /** Find the song's full-song source (cached by the engine's store). */
  find: (track: Track) => Promise<string | null>;
  /** Ask the shell to name and cache the source's media file, so a click does not wait for it. */
  resolve: (source: string) => void;
  /** True when the finished file is already held: there is nothing to warm. */
  held: (source: string) => boolean;
}

export interface WarmOptions {
  /** Lookups allowed at once. Each one can become a yt-dlp process in the shell. */
  concurrency?: number;
  /** Songs warmed within one window, however many rows are shown. */
  budget?: number;
  /** How long a warmed song counts as warm, and how long the budget window lasts. */
  ttlMs?: number;
  now?: () => number;
}

const DEFAULTS = { concurrency: 2, budget: 24, ttlMs: 10 * 60 * 1000 };

export class PlayWarmer {
  private readonly opts: Required<Omit<WarmOptions, 'now'>> & { now: () => number };
  /** Song key -> when it was warmed (or found to be unwarmable). */
  private readonly seen = new Map<string, number>();
  private readonly queue: Track[] = [];
  private running = 0;
  private windowStartedAt = 0;
  private spentThisWindow = 0;

  constructor(private readonly ports: WarmPorts, options: WarmOptions = {}) {
    this.opts = { ...DEFAULTS, now: () => Date.now(), ...options } as Required<Omit<WarmOptions, 'now'>> & { now: () => number };
  }

  get inFlight(): number {
    return this.running;
  }

  /** Warm one song: the row under the pointer, the keyboard's row, the song queued next. */
  warm(track: Track | null | undefined): void {
    if (!track?.key) return;
    const at = this.opts.now();
    const last = this.seen.get(track.key);
    if (last !== undefined && at - last < this.opts.ttlMs) return;
    // Claimed up front, so the same row hovered twice while its lookup runs costs one lookup.
    this.seen.set(track.key, at);
    if (this.seen.size > 400) this.seen.delete(this.seen.keys().next().value!);
    this.queue.push(track);
    this.pump();
  }

  /** Warm the first `count` rows of a list, in the order they are shown. */
  warmFirst(tracks: readonly (Track | null | undefined)[], count: number): void {
    for (const track of tracks.slice(0, Math.max(0, count))) this.warm(track);
  }

  private budgetLeft(at: number): boolean {
    if (at - this.windowStartedAt >= this.opts.ttlMs) {
      this.windowStartedAt = at;
      this.spentThisWindow = 0;
    }
    return this.spentThisWindow < this.opts.budget;
  }

  private pump(): void {
    while (this.running < this.opts.concurrency && this.queue.length) {
      const at = this.opts.now();
      if (!this.budgetLeft(at)) {
        this.queue.length = 0;
        return;
      }
      const track = this.queue.shift()!;
      this.spentThisWindow += 1;
      this.running += 1;
      void this.one(track).catch(() => undefined).then(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async one(track: Track): Promise<void> {
    let source: string | null = null;
    try {
      source = this.ports.known(track) ?? (await this.ports.find(track));
    } catch {
      // Offline, or the provider refused: forget it so a later hover may try again.
      this.seen.delete(track.key);
      return;
    }
    // No source at all is a durable answer for this window: do not ask again on every hover.
    if (!source) return;
    try {
      if (this.ports.held(source)) return;
      this.ports.resolve(source);
    } catch {
      this.seen.delete(track.key);
    }
  }
}
