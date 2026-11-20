/**
 * ALLOWANCE-ARCH-001 (owner, 2026-11-20): one place that decides what network use the allowance governs.
 *
 * Three lanes:
 *  - `interactive`: what the listener asked for (a search, an artist or album page, a discovery they started).
 *    Counted, never refused for the allowance.
 *  - `playback`: finding and loading the song being played or coming up. Counted, never refused. Full songs are
 *    never limited (owner rule).
 *  - `background`: work nobody asked for by hand (queue top-ups while listening, genre and album look-ups).
 *    The only lane the allowance limits, and only on a metered connection (mobile data): on Wi-Fi it does not apply.
 *
 * The allowance is a reserve the size of the Settings value (100 MB by default) that refills continuously, a
 * twenty-fourth of it every hour, so there is no midnight cliff and paused work resumes by itself.
 */
import { Meter } from './net';
import type { Store } from './store';

export type Lane = 'interactive' | 'playback' | 'background';

/** Where the reserve is kept between starts. */
export const RESERVE_KEY = 'allowance_reserve';
/** A lane the allowance does not limit: only the request's own cap applies. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const DAY_SECONDS = 86_400;

interface Reserve {
  /** Bytes left when last written. */
  level: number;
  /** Unix seconds of that moment. */
  at: number;
  /** The allowance the level was measured against. */
  capacity: number;
  /** What the shell last said about the connection; null when it never has. */
  metered: boolean | null;
}

export interface AllowanceState {
  /** The Settings value in bytes. */
  capacity: number;
  /** Bytes of background work left right now. */
  level: number;
  /** Bytes that come back each hour. */
  refill_per_hour: number;
  /** True off mobile data: the allowance does not apply. */
  unmetered: boolean;
  /** True when background work is waiting for the reserve. */
  paused: boolean;
  /** Unix seconds when paused work can carry on by itself; null when it is not paused. */
  resumes_at: number | null;
  /** Bytes read today, by lane. */
  today: Record<string, number>;
}

export class Budget {
  private reserve: Reserve;

  constructor(
    private readonly store: Store,
    /** The allowance in bytes, read each time so a Settings change applies at once. */
    private readonly capacity: () => number,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    const cap = this.cap();
    const saved = store.get<Partial<Reserve>>(RESERVE_KEY);
    const ok = saved && Number.isFinite(saved.level) && Number.isFinite(saved.at) && Number.isFinite(saved.capacity);
    this.reserve = ok
      ? { level: Number(saved.level), at: Number(saved.at), capacity: Number(saved.capacity), metered: typeof saved.metered === 'boolean' ? saved.metered : null }
      : { level: cap, at: this.now(), capacity: cap, metered: null };
  }

  private cap(): number {
    const c = Math.trunc(Number(this.capacity()));
    return Number.isFinite(c) && c > 0 ? c : 0;
  }

  /** The reserve brought up to this moment: refilled for the time passed and fitted to the current allowance. */
  private settle(): Reserve {
    const cap = this.cap();
    const now = this.now();
    const r = this.reserve;
    // A raised allowance gives the difference at once; a lowered one caps what is left.
    let level = r.level + Math.max(0, cap - r.capacity);
    level += (Math.max(0, now - r.at) * cap) / DAY_SECONDS;
    this.reserve = { level: Math.max(0, Math.min(cap, level)), at: now, capacity: cap, metered: r.metered };
    return this.reserve;
  }

  private save(): void {
    void this.store.put(RESERVE_KEY, this.reserve).catch(() => undefined);
  }

  /** The reserve has to hold this much before paused background work starts again. */
  private resumeLevel(cap: number): number {
    return Math.min(cap, Math.max(1_000_000, cap / 100));
  }

  get unmetered(): boolean {
    return this.reserve.metered === false;
  }

  /** What the shell says about the connection. Nothing said (undefined, null) changes nothing. */
  network(metered: boolean | null | undefined): void {
    if (typeof metered !== 'boolean' || metered === this.reserve.metered) return;
    this.settle();
    this.reserve.metered = metered;
    this.save();
  }

  /** A meter for one piece of work. `cap` bounds that piece whatever the lane. */
  meter(lane: Lane, cap: number): Meter {
    const record = (category: string, n: number) => this.store.addTransfer(category, n, undefined, lane);
    if (lane !== 'background') return new Meter(cap, UNLIMITED, record);
    if (this.unmetered) return new Meter(cap, UNLIMITED, record);
    // Paused means paused: nothing is let through until the reserve is back at the level it resumes at. Spending
    // the little that has come back would keep it from ever getting there.
    const left = this.state().paused ? 0 : Math.floor(this.settle().level);
    return new Meter(cap, left, (category, n) => {
      record(category, n);
      // The connection can change while a piece of work runs: only metered bytes draw on the reserve.
      if (this.unmetered || n <= 0) return;
      const r = this.settle();
      r.level = Math.max(0, r.level - n);
      this.save();
    });
  }

  /** How many of `n` background items to do now: all with plenty left, half below a quarter, none while paused. */
  batch(n: number): number {
    const s = this.state();
    if (s.unmetered) return n;
    if (s.paused) return 0;
    return s.level < s.capacity / 4 ? Math.max(1, Math.ceil(n / 2)) : n;
  }

  /** Fill the reserve at once ("Check again" in Settings). Returns the bytes given back. */
  refill(): number {
    const r = this.settle();
    const given = Math.max(0, r.capacity - r.level);
    r.level = r.capacity;
    this.save();
    return Math.round(given);
  }

  state(): AllowanceState {
    const r = this.settle();
    const rate = r.capacity / DAY_SECONDS;
    const need = this.resumeLevel(r.capacity);
    const unmetered = this.unmetered;
    const paused = !unmetered && r.level < need;
    return {
      capacity: r.capacity,
      level: Math.round(r.level),
      refill_per_hour: Math.round(rate * 3600),
      unmetered,
      paused,
      resumes_at: paused && rate > 0 ? r.at + (need - r.level) / rate : null,
      today: this.store.transferLanes(),
    };
  }
}
