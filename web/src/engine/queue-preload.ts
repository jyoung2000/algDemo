import type { Track } from '../api';
import { cacheStateOf, preloadPlan, type CardCache, type PreloadSetting } from './queue-controls';
import type { LocalStatus } from './local-audio';

/** WHOLE-QUEUE-001: disk prefetch, NOT a second bank of audio elements/Blobs. */
export interface QueueCacheStatus {
  total: number; ready: number; active: number; failed: number; blocked: boolean; queued: number;
  parallel: number; bulkActive: boolean;
  /**
   * Songs that failed and have another attempt booked (RETRY-SPIN-001).
   *
   * Owner: "i dont see a spinning arrow indicating active retrying." A song serving its
   * 5s/30s/2min/5min backoff is neither downloading nor given up on, and counting it only as
   * `failed` left the interface looking idle while the app was still working. A song parked for
   * want of cache space is NOT retrying — it is waiting for room, which the blocked flag says.
   */
  retrying: number;
}
interface Library {
  status(url: string): string;
  observe?(urls: readonly string[]): void;
  error(url: string): string | null;
  ensure(url: string, label: string, retry: boolean, background: boolean): Promise<void>;
  subscribe(fn: () => void): () => void;
}
interface Backend {
  /**
   * The link to download for this song. `exclude` names links that already failed, so a resolver
   * can offer a different source instead of repeating one that cannot work (SOURCE-SWAP-001).
   */
  resolve(track: Track, retry?: boolean, exclude?: readonly string[]): Promise<string | null>;
  known?(track: Track): string | null;
  /** Previously expired discovery keys, scoped to recent failed searches, not owner-kept files. */
  expiredKeys?(): readonly string[];
  rememberExpired?(key: string, expired: boolean): void;
  /** A hint may be persisted only once native storage confirms a complete file. */
  remember?(track: Track, url: string): void;
  /** Native evictable cache usage in bytes; omit to retain manual-only refill. */
  capacity?(): Promise<{ bytes: number; limit: number }>;
  library: Library;
  configure(gb: number, protectedUrls: string[], wanted: string[], parallel: number): Promise<unknown>;
}
interface Entry {
  track: Track; url?: string; phase: 'waiting' | 'preparing' | 'downloading' | 'ready' | 'failed' | 'expired';
  attempts: number; after: number; space?: number; probedSpace?: boolean;
  /** Links that failed for this song, so the resolver can be asked for a different source. */
  dead?: string[];
  /** When this song was first attempted, so the give-up clock survives list updates. */
  firstTry?: number;
}
/** Beyond the preload target: still listed and playable on demand, just not fetched ahead. */
export interface PreloadLimits { parallel: number; preload: PreloadSetting }
const quotaError = (error: string | null) => /cache.*(limit|size)|protected.*exceed|larger than.*cache/i.test(error ?? '');
/**
 * ROLLING-CACHE-002: the cache is maintained on a steady beat, not only when something happens.
 *
 * Owner: songs must keep loading, missing ones must keep being retried, and listened ones must be
 * unloaded "continuously every 2-3 seconds". The loader used to be purely event-driven - a library
 * notification, or a list change - so with a quiet library nothing reconsidered the cache at all,
 * and the shell only ever pruned as a side effect of an insert. This tick re-pumps the queue and
 * re-states the wanted order (which is what makes the shell unload what the listener has passed).
 */
const MAINTENANCE_INTERVAL = 2500;
/**
 * Deliberately NOT the maintenance interval. A capacity check stats every file in the cache, and
 * refilling after an eviction is gated on watermarks to avoid a fill/evict loop; asking the disk
 * every couple of seconds buys nothing and churns. The beat still runs at MAINTENANCE_INTERVAL -
 * it just finds this probe already satisfied most times round.
 */
const CAPACITY_INTERVAL = 30_000;
const MIN_HEADROOM = 16 * 1024 * 1024;
// First retry is immediate; persistent failures back off briefly, never for minutes.
const RETRY_DELAYS = [0, 2500, 5000, 15_000, 30_000];
const rejectedLink = (error: string | null) => /requested format.*not available|video unavailable|video has been removed|private video|not available in your country/i.test(error ?? '');
/**
 * Failed attempts on one link before the loader asks for a different source (SOURCE-SWAP-001).
 * Two, so a single flaky download does not throw away a good source, but a dead one is not retried
 * for the rest of the session.
 */
const SWAP_SOURCE_AFTER = 2;
/**
 * SEAMLESS-002: how long a song may fail before the list quietly stops showing it.
 *
 * Owner: "the music list should silently remove songs it cant find for more than 10 minutes".
 * Retrying for ever is what left the dashboard at 95 of 97 with a spinner running all day over two
 * songs no source has. The clock starts at the FIRST attempt and survives the queue being
 * re-stated, and a song parked for cache room is exempt — a full cache is not the song's fault.
 */
const GIVE_UP_AFTER = 10 * 60_000;

export class QueuePreloader {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerAt = Infinity;
  private beat: ReturnType<typeof setInterval> | undefined;
  private capacityAfter = 0;
  private checkingCapacity = false;
  private stopped = false;
  private gb = 1;
  private parallel = 2;
  private preload: PreloadSetting = { target: 'all', count: 20 };
  private wantedKeys = new Set<string>();
  private automaticKeys = new Set<string>();
  /** Songs given up on after GIVE_UP_AFTER, so the list can quietly stop showing them. */
  private expired: Set<string>;
  /** One-shot requests survive automatic queue updates, but stop overriding count once ready. */
  private manualKeys = new Set<string>();
  private resolvedUrls = new Map<string, string>();
  private protectedUrls: string[] = [];
  private blocked = false;
  private config: Promise<unknown> = Promise.resolve();
  private unsubscribe: () => void;
  constructor(private readonly backend: Backend) {
    this.expired = new Set(backend.expiredKeys?.() ?? []);
    this.unsubscribe = backend.library.subscribe(() => this.schedule());
  }
  /**
   * One beat: reconsider every entry, then re-state the wanted set so the shell can unload songs
   * the listener has moved past.
   */
  private maintain(): void {
    if (this.stopped || !this.entries.size) return;
    this.pump();
    void this.configure().catch(() => undefined);
  }
  /**
   * The beat only runs while a wanted song is not yet ready - downloading, waiting, retrying after a
   * failure, or parked for space. A loader with nothing left to do holds NO timer at all, which is
   * what keeps an idle app from waking the disk every couple of seconds (and what the
   * "does not retry once removed / outside COUNT" guards assert).
   */
  private syncBeat(): void {
    const work = !this.stopped && [...this.entries].some(([key, e]) =>
      this.wantedKeys.has(key) && e.phase !== 'ready' && e.phase !== 'expired');
    if (work && this.beat === undefined) {
      this.beat = setInterval(() => this.maintain(), MAINTENANCE_INTERVAL);
      // Unref'd where supported so the beat never holds a test or CLI process open.
      (this.beat as unknown as { unref?: () => void }).unref?.();
    } else if (!work && this.beat !== undefined) {
      clearInterval(this.beat);
      this.beat = undefined;
    }
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /**
   * The playable local link for a song, or null when the shell does not hold its bytes.
   *
   * SEAMLESS-001: answered from what the loader already resolved, so starting a song the app has
   * already downloaded costs no network round trip. Readiness is always re-read from the library,
   * never cached, because eviction can take a file away between the question and the answer.
   */
  /** Last native-verified link; a hint for direct on-demand storage checks, NOT proof of readiness. */
  sourceHint(track: Track): string | null {
    const e = this.entries.get(track.key);
    const url = e?.url ?? this.resolvedUrls.get(track.key) ?? this.backend.known?.(track) ?? null;
    return url && !e?.dead?.includes(url) ? url : null;
  }
  readyUrl(track: Track): string | null {
    const url = this.sourceHint(track);
    return url && this.backend.library.status(url) === 'ready' ? url : null;
  }
  private setExpired(key: string, expired: boolean): void {
    const changed = expired ? !this.expired.has(key) : this.expired.has(key);
    if (!changed) return;
    if (expired) this.expired.add(key); else this.expired.delete(key);
    this.backend.rememberExpired?.(key, expired);
  }
  /** Whether this song can start playing from local disk right now. */
  isReady(track: Track): boolean { return this.readyUrl(track) !== null; }
  /** Songs no source could supply within GIVE_UP_AFTER; the list drops these silently. */
  expiredKeys(): ReadonlySet<string> { return this.expired; }
  snapshot(): QueueCacheStatus {
    return this.snapshotFor([...this.entries.values()].map(e => e.track));
  }
  /** Unique songs in this list, not the global queue. Readiness always comes from the library. */
  snapshotFor(tracks: readonly Track[]): QueueCacheStatus {
    const result: QueueCacheStatus = { total: 0, ready: 0, active: 0, failed: 0, blocked: false, queued: 0, parallel: this.parallel, bulkActive: false, retrying: 0 };
    const observe: string[] = [];
    for (const track of new Map(tracks.map(t => [t.key, t])).values()) {
      result.total++;
      const e = this.entries.get(track.key);
      const url = e?.url ?? this.resolvedUrls.get(track.key) ?? this.backend.known?.(track);
      if (url) observe.push(url);
      const state = url ? this.backend.library.status(url) : 'unknown';
      if (!this.blocked && this.manualKeys.has(track.key) && state !== 'ready' && e?.phase !== 'failed') result.bulkActive = true;
      if (state === 'ready') result.ready++;
      else if (state === 'running' || e?.phase === 'preparing' || e?.phase === 'downloading') result.active++;
      // Given up on: it reads as unavailable, and nothing is booked for it, so nothing may spin.
      else if (e?.phase === 'expired') result.failed++;
      else if (e?.phase === 'failed') {
        if (this.blocked && url && quotaError(this.backend.library.error(url))) result.blocked = true;
        else {
          result.failed++;
          // Another attempt is booked for this one: work is pending, not abandoned.
          if (Number.isFinite(e.after)) result.retrying++;
        }
      } else result.queued++;
    }
    // A global quota stop also prevents other requested songs from starting.
    if (this.blocked && result.ready < result.total && tracks.some(t => this.wantedKeys.has(t.key))) result.blocked = true;
    this.backend.library.observe?.(observe);
    return result;
  }
  /** Download once into evictable queue storage; never changes preload settings or keeps a copy. */
  downloadAll(tracks: readonly Track[]): void {
    for (const track of tracks) {
      let e = this.entries.get(track.key);
      if (!e) {
        e = { track, url: this.resolvedUrls.get(track.key) ?? this.backend.known?.(track) ?? undefined, phase: 'waiting', attempts: 0, after: 0 };
        this.entries.set(track.key, e);
      }
      this.manualKeys.add(track.key);
      // An explicit request is a new instruction: a song the list gave up on gets another go.
      if (e.phase === 'expired') { e.phase = 'waiting'; e.attempts = 0; e.after = 0; e.firstTry = undefined; }
      this.setExpired(track.key, false);
      if (e.phase === 'waiting' || (e.phase === 'ready' && e.url && this.backend.library.status(e.url) !== 'ready')) {
        e.phase = 'waiting'; e.after = 0; e.attempts = 0;
      }
      if (e.phase === 'failed' && !quotaError(e.url ? this.backend.library.error(e.url) : null)) {
        e.phase = 'waiting'; e.attempts = Math.max(1, e.attempts); e.after = 0;
      }
    }
    this.recomputeTarget();
    void this.configure().catch(() => undefined);
    this.schedule(); this.emit();
  }
  update(tracks: readonly Track[]): void {
    this.automaticKeys = new Set(tracks.map(t => t.key));
    const next = new Map<string, Entry>();
    for (const track of tracks) if (!next.has(track.key)) next.set(track.key, this.entries.get(track.key) ?? { track, url: this.resolvedUrls.get(track.key) ?? this.backend.known?.(track) ?? undefined, phase: this.expired.has(track.key) ? 'expired' : 'waiting', attempts: 0, after: 0 });
    for (const key of this.manualKeys) {
      const e = this.entries.get(key);
      if (e && !next.has(key)) next.set(key, e);
    }
    // ROLLING-CACHE-001: the shell evicts from the END of `wanted`, so the ORDER is as much a
    // configuration change as the membership. As the listener advances through one list the set is
    // identical and only the order moves; without this the shell keeps evicting the songs about to
    // play in order to hold the ones just finished.
    const before = [...this.entries.keys()];
    const after = [...next.keys()];
    const changed = after.length !== before.length || after.some((k, i) => before[i] !== k);
    this.entries = next;
    this.recomputeTarget();
    if (changed) { if (!this.backend.capacity) this.unblock(); void this.configure().catch(() => undefined); }
    this.schedule(); this.emit();
  }
  /** All cache-config calls go through one serial writer; an old response cannot cancel a newer list. */
  protect(gb: number, urls: string[]): Promise<unknown> {
    if (gb !== this.gb) this.unblock();
    this.gb = gb; this.protectedUrls = [...new Set(urls)].slice(0, 3);
    this.schedule();
    return this.configure();
  }
  /** Parallelism and preload target. A raise starts more work at once; a cut only stops new starts. */
  limits(o: Partial<PreloadLimits>): Promise<unknown> {
    const parallel = o.parallel === undefined ? this.parallel : Math.max(1, Math.floor(o.parallel));
    const changed = parallel !== this.parallel;
    this.parallel = parallel;
    if (o.preload) this.preload = o.preload;
    this.recomputeTarget();
    this.schedule();
    return changed ? this.configure() : Promise.resolve();
  }
  /** What one card should say about its own audio: provenance plus live progress. */
  cardOf(key: string, o: { kept: boolean; percent: number | null }): CardCache {
    const e = this.entries.get(key);
    const url = e?.url;
    return cacheStateOf({
      status: url ? (this.backend.library.status(url) as LocalStatus) : 'unknown',
      kept: o.kept, percent: o.percent, blocked: this.blocked && e?.phase === 'failed',
      inTarget: this.wantedKeys.has(key), error: url ? this.backend.library.error(url) : null,
      givenUp: e?.phase === 'failed' || e?.phase === 'expired',
    });
  }
  private recomputeTarget(): void {
    this.wantedKeys = new Set([...preloadPlan([...this.automaticKeys], this.preload), ...this.manualKeys]);
  }
  retryFailed(): void {
    for (const e of this.entries.values()) if (e.phase === 'failed' && !quotaError(e.url ? this.backend.library.error(e.url) : null)) {
      e.phase = 'waiting'; e.attempts = Math.max(1, e.attempts); e.after = 0;
    }
    this.schedule();
  }
  private unblock(): void {
    this.blocked = false;
    for (const e of this.entries.values()) {
      // A quota failure or a song parked after eviction: both only waited on space, which now exists.
      const parked = e.phase === 'waiting' && !Number.isFinite(e.after);
      if (parked || (e.phase === 'failed' && e.url && quotaError(this.backend.library.error(e.url)))) {
        e.phase = 'waiting'; e.attempts = 0; e.after = 0;
      }
    }
  }
  private configure(): Promise<unknown> {
    // Read at execution time, not enqueue time: collapses stale snapshots during rapid skips.
    // `wanted` is ordered: entry order is listening order (current song, then up next, then the
    // rest of the list), and the shell keeps the head and evicts from the tail.
    const work = this.config.catch(() => undefined).then(() => this.backend.configure(this.gb, this.protectedUrls,
      [...new Set([...this.entries.values()].flatMap(e => e.url ? [e.url] : []))], this.parallel));
    this.config = work;
    return work;
  }
  private emit(): void { for (const f of this.listeners) f(); }
  private schedule(delay = 0): void {
    const at = Date.now() + delay;
    if (this.stopped || (this.timer !== undefined && this.timerAt <= at)) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = undefined; this.timerAt = Infinity; this.pump(); }, delay);
  }
  private fail(e: Entry, error: string | null): void {
    e.phase = 'failed';
    if (quotaError(error)) { this.blocked = true; e.after = Infinity; }
    else {
      // SEAMLESS-002: ten minutes of real failure is enough. Stop, publish the key so the list can
      // drop it, and book nothing — a song still waiting for cache room never reaches here.
      if (e.firstTry !== undefined && Date.now() - e.firstTry >= GIVE_UP_AFTER) {
        e.phase = 'expired'; e.after = Infinity;
        this.setExpired(e.track.key, true);
        return;
      }
      e.after = Date.now() + RETRY_DELAYS[Math.min(RETRY_DELAYS.length - 1, Math.max(0, e.attempts - 1))]!;
      // Explicit rejection skips the link immediately; a transient error gets one quick retry.
      // Remember the failed link so the resolver actually tries a different upload/source.
      if (e.url && (rejectedLink(error) || e.attempts >= SWAP_SOURCE_AFTER)) {
        (e.dead ??= []).push(e.url);
        this.resolvedUrls.delete(e.track.key);
        e.url = undefined;
      }
    }
  }
  private parked(e: Entry): boolean {
    return (e.phase === 'waiting' || e.phase === 'failed') && e.after === Infinity;
  }
  private pollCapacity(): void {
    if (!this.backend.capacity || this.checkingCapacity) return;
    const parked = [...this.entries.values()].filter(e => this.wantedKeys.has(e.track.key) && this.parked(e));
    if (!parked.length) return;
    const now = Date.now();
    if (!this.capacityAfter) this.capacityAfter = now + CAPACITY_INTERVAL;
    if (now < this.capacityAfter) { this.schedule(this.capacityAfter - now); return; }
    this.capacityAfter = now + CAPACITY_INTERVAL;
    this.checkingCapacity = true;
    void (async () => {
      try {
        const { bytes, limit } = await this.backend.capacity!();
        if (this.stopped || !Number.isFinite(bytes) || !Number.isFinite(limit) || bytes < 0 || limit <= 0) return;
        const free = Math.max(0, limit - bytes);
        for (const e of parked) {
          if (this.entries.get(e.track.key) !== e || !this.wantedKeys.has(e.track.key) || !this.parked(e)) continue;
          // Headroom grants one probe. Keep its watermark even after ready/eviction,
          // so identical health reports cannot repeatedly download the same file.
          const room = (!e.probedSpace && free >= Math.max(MIN_HEADROOM, limit * 0.2)) || (e.space !== undefined && free - e.space >= MIN_HEADROOM);
          if (room) { e.phase = 'waiting'; e.after = 0; e.space = free; e.probedSpace = true; }
          else e.space = Math.min(e.space ?? free, free);
        }
        this.blocked = [...this.entries.values()].some(e => this.wantedKeys.has(e.track.key) && e.phase === 'failed' && e.after === Infinity);
      } catch {
        // Unknown capacity is not permission to refill; try health again later.
      } finally {
        this.checkingCapacity = false;
        this.schedule();
      }
    })();
  }
  private pump(): void {
    if (this.stopped) return;
    // A deadline must not wait for another failed attempt: busy download slots can starve a due
    // retry indefinitely. The live APK kept Plant Island failed for 16 minutes with this bug.
    const now = Date.now();
    for (const e of this.entries.values()) {
      if ((e.phase !== 'failed' && !(e.phase === 'waiting' && e.attempts > 0)) ||
          e.firstTry === undefined || now - e.firstTry < GIVE_UP_AFTER ||
          (e.url && ['ready', 'running'].includes(this.backend.library.status(e.url))) ||
          quotaError(e.url ? this.backend.library.error(e.url) : null)) continue;
      e.phase = 'expired'; e.after = Infinity;
      this.setExpired(e.track.key, true);
      this.manualKeys.delete(e.track.key);
    }
    for (const e of this.entries.values()) {
      if (!e.url || e.phase === 'preparing') continue;
      const state = this.backend.library.status(e.url);
      if (state === 'ready') { e.phase = 'ready'; e.attempts = 0; e.after = 0; e.firstTry = undefined; this.manualKeys.delete(e.track.key); this.setExpired(e.track.key, false); this.backend.remember?.(e.track, e.url); }
      else if (e.phase === 'downloading' && state === 'missing') this.fail(e, this.backend.library.error(e.url));
      // Eviction is not a fresh download request: avoid an endless fill/evict loop.
      else if (e.phase === 'ready') { e.phase = 'waiting'; e.attempts = 0; e.after = Infinity; }
    }
    this.recomputeTarget();
    if (this.backend.capacity && this.blocked) {
      this.blocked = [...this.entries.values()].some(e => this.wantedKeys.has(e.track.key) && e.phase === 'failed' && e.after === Infinity);
    }
    let active = this.snapshot().active;
    // A lowered limit never cancels work in flight; it just stops new starts until active drops.
    // Within each priority, fresh songs run before retries so a fast failure cannot monopolise slots.
    const pending = [...this.entries].sort(([a, ea], [b, eb]) =>
      Number(this.manualKeys.has(b)) - Number(this.manualKeys.has(a)) || ea.attempts - eb.attempts);
    if (!this.blocked) for (const [key, e] of pending) {
      if (active >= this.parallel) break;
      if ((e.phase !== 'waiting' && e.phase !== 'failed') || e.after > Date.now() || !this.wantedKeys.has(key)) continue;
      e.phase = 'preparing'; e.attempts++; active++;
      e.firstTry ??= Date.now();
      void this.prepare(e);
    }
    this.emit();
    if (!this.blocked) for (const [key, e] of this.entries) {
      if (this.wantedKeys.has(key) && (e.phase === 'waiting' || e.phase === 'failed') && Number.isFinite(e.after) && e.after > Date.now()) this.schedule(e.after - Date.now());
    }
    this.pollCapacity();
    this.syncBeat();
  }
  private async prepare(e: Entry): Promise<void> {
    const live = () => !this.stopped && this.entries.get(e.track.key) === e;
    const wanted = () => {
      if (!live()) return false;
      if (this.wantedKeys.has(e.track.key)) return true;
      e.phase = 'waiting'; return false;
    };
    try {
      e.url ??= await this.backend.resolve(e.track, e.attempts > 1, e.dead) ?? undefined;
      if (!wanted()) return;
      if (!e.url) { this.fail(e, null); return; }
      this.resolvedUrls.set(e.track.key, e.url);
      await this.configure();
      if (!wanted()) return;
      await this.backend.library.ensure(e.url, `${e.track.title} — ${e.track.artist}`, true, true);
      if (!live()) return;
      const state = this.backend.library.status(e.url);
      if (state === 'ready') { e.phase = 'ready'; e.attempts = 0; e.after = 0; e.firstTry = undefined; this.manualKeys.delete(e.track.key); this.setExpired(e.track.key, false); this.backend.remember?.(e.track, e.url); }
      else if (state === 'running') e.phase = 'downloading';
      else this.fail(e, this.backend.library.error(e.url));
    } catch (error) {
      if (live()) this.fail(e, error instanceof Error ? error.message : String(error));
    } finally { this.schedule(); }
  }
  dispose(): void {
    this.stopped = true; this.unsubscribe(); clearTimeout(this.timer);
    clearInterval(this.beat); this.beat = undefined;
    this.listeners.clear();
  }
}
