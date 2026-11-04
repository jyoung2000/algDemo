import type { Track } from '../api';
import { cacheStateOf, preloadPlan, type CardCache, type PreloadSetting } from './queue-controls';
import type { LocalStatus } from './local-audio';

/** WHOLE-QUEUE-001: disk prefetch, NOT a second bank of audio elements/Blobs. */
export interface QueueCacheStatus { total: number; ready: number; active: number; failed: number; blocked: boolean; queued: number; parallel: number }
interface Library {
  status(url: string): string;
  error(url: string): string | null;
  ensure(url: string, label: string, retry: boolean, background: boolean): Promise<void>;
  subscribe(fn: () => void): () => void;
}
interface Backend {
  resolve(track: Track): Promise<string | null>;
  known?(track: Track): string | null;
  library: Library;
  configure(gb: number, protectedUrls: string[], wanted: string[], parallel: number): Promise<unknown>;
}
interface Entry { track: Track; url?: string; phase: 'waiting' | 'preparing' | 'downloading' | 'ready' | 'failed'; attempts: number; after: number }
/** Beyond the preload target: still listed and playable on demand, just not fetched ahead. */
export interface PreloadLimits { parallel: number; preload: PreloadSetting }
const quotaError = (error: string | null) => /cache.*(limit|size)|protected.*exceed|larger than.*cache/i.test(error ?? '');

export class QueuePreloader {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private gb = 1;
  private parallel = 2;
  private preload: PreloadSetting = { target: 'all', count: 20 };
  private wantedKeys = new Set<string>();
  private protectedUrls: string[] = [];
  private blocked = false;
  private config: Promise<unknown> = Promise.resolve();
  private unsubscribe: () => void;
  constructor(private readonly backend: Backend) {
    this.unsubscribe = backend.library.subscribe(() => this.schedule());
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  snapshot(): QueueCacheStatus {
    const all = [...this.entries.values()];
    return { total: all.length, ready: all.filter(e => e.phase === 'ready').length,
      active: all.filter(e => e.phase === 'preparing' || e.phase === 'downloading').length,
      failed: all.filter(e => e.phase === 'failed').length, blocked: this.blocked,
      queued: all.filter(e => e.phase === 'waiting').length, parallel: this.parallel };
  }
  update(tracks: readonly Track[]): void {
    const next = new Map<string, Entry>();
    for (const track of tracks) if (!next.has(track.key)) next.set(track.key, this.entries.get(track.key) ?? { track, url: this.backend.known?.(track) ?? undefined, phase: 'waiting', attempts: 0, after: 0 });
    const changed = next.size !== this.entries.size || [...next.keys()].some(k => !this.entries.has(k));
    this.entries = next;
    this.recomputeTarget();
    if (changed) { this.unblock(); void this.configure().catch(() => undefined); }
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
      status: e?.phase === 'ready' ? 'ready' : url ? (this.backend.library.status(url) as LocalStatus) : 'unknown',
      kept: o.kept, percent: o.percent, blocked: this.blocked && e?.phase === 'failed',
      inTarget: this.wantedKeys.has(key), error: url ? this.backend.library.error(url) : null,
    });
  }
  private recomputeTarget(): void {
    this.wantedKeys = new Set(preloadPlan([...this.entries.keys()], this.preload));
  }
  retryFailed(): void {
    for (const e of this.entries.values()) if (e.phase === 'failed' && !quotaError(e.url ? this.backend.library.error(e.url) : null)) {
      e.phase = 'waiting'; e.attempts = 0; e.after = 0;
    }
    this.schedule();
  }
  private unblock(): void {
    this.blocked = false;
    for (const e of this.entries.values()) if (e.phase === 'failed' && e.url && quotaError(this.backend.library.error(e.url))) {
      e.phase = 'waiting'; e.attempts = 0; e.after = 0;
    }
  }
  private configure(): Promise<unknown> {
    // Read at execution time, not enqueue time: collapses stale snapshots during rapid skips.
    const work = this.config.catch(() => undefined).then(() => this.backend.configure(this.gb, this.protectedUrls,
      [...new Set([...this.entries.values()].flatMap(e => e.url ? [e.url] : []))], this.parallel));
    this.config = work;
    return work;
  }
  private emit(): void { for (const f of this.listeners) f(); }
  private schedule(delay = 0): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, delay);
  }
  private fail(e: Entry, error: string | null): void {
    if (quotaError(error)) { this.blocked = true; e.phase = 'failed'; }
    else if (e.attempts < 3) { e.phase = 'waiting'; e.after = Date.now() + (e.attempts === 1 ? 5000 : 30000); }
    else e.phase = 'failed';
  }
  private pump(): void {
    if (this.stopped) return;
    for (const e of this.entries.values()) {
      if (!e.url || e.phase === 'preparing') continue;
      const state = this.backend.library.status(e.url);
      if (state === 'ready') e.phase = 'ready';
      else if (e.phase === 'downloading' && state === 'missing') this.fail(e, this.backend.library.error(e.url));
      else if (e.phase === 'ready' && state === 'missing') { e.phase = 'waiting'; e.attempts = 0; e.after = 0; }
    }
    let active = this.snapshot().active;
    // A lowered limit never cancels work in flight; it just stops new starts until active drops.
    if (!this.blocked) for (const [key, e] of this.entries) {
      if (active >= this.parallel) break;
      if (e.phase !== 'waiting' || e.after > Date.now() || !this.wantedKeys.has(key)) continue;
      e.phase = 'preparing'; e.attempts++; active++;
      void this.prepare(e);
    }
    this.emit();
    if (!this.blocked && [...this.entries.values()].some(e => e.phase === 'waiting' && e.after > Date.now())) this.schedule(1000);
  }
  private async prepare(e: Entry): Promise<void> {
    const live = () => !this.stopped && this.entries.get(e.track.key) === e;
    try {
      e.url ??= await this.backend.resolve(e.track) ?? undefined;
      if (!live()) return;
      if (!e.url) { e.phase = 'failed'; return; }
      await this.configure();
      if (!live()) return;
      await this.backend.library.ensure(e.url, `${e.track.title} — ${e.track.artist}`, true, true);
      if (!live()) return;
      const state = this.backend.library.status(e.url);
      if (state === 'ready') e.phase = 'ready';
      else if (state === 'running') e.phase = 'downloading';
      else this.fail(e, this.backend.library.error(e.url));
    } catch (error) {
      if (live()) this.fail(e, error instanceof Error ? error.message : String(error));
    } finally { this.schedule(); }
  }
  dispose(): void { this.stopped = true; this.unsubscribe(); clearTimeout(this.timer); this.listeners.clear(); }
}
