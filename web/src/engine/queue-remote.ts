/**
 * SERVICE-API-001: the queue cache as the Android UI page sees it when the playback service owns the
 * one QueuePreloader. Every answer comes from what the service last reported for that song; nothing
 * here downloads, resolves or guesses readiness. Disposing it never touches the service's cache.
 */
import type { Track } from '../api';
import { cacheStateOf, type CardCache } from './queue-controls';
import type { QueueCacheStatus, QueuePreloader } from './queue-preload';
import type { ServiceClient, ServiceResponse } from './service-client';

/** Everything callers use of the queue singleton; the local QueuePreloader satisfies it structurally. */
export type QueueAudioPort = Pick<QueuePreloader,
  'subscribe' | 'sourceHint' | 'readyUrl' | 'isReady' | 'look' | 'expiredKeys' | 'snapshot' | 'snapshotFor' |
  'downloadAll' | 'update' | 'protect' | 'limits' | 'cardOf' | 'retryFailed' | 'dispose'>;

/** What the service actor needs of its own (local) QueuePreloader. */
export type ServiceQueue = QueueAudioPort & Pick<QueuePreloader, 'cardFacts'>;

export type CardFacts = ReturnType<QueuePreloader['cardFacts']>;

/** One song's cache state as the service saw it: per-track, unlike the counts of `snapshot()`. */
export interface TrackCacheDto { key: string; source: string | null; ready: string | null; facts: CardFacts }

export interface CacheSnapshot { tracks: TrackCacheDto[]; expired: string[] }

export const QUEUE_PATH = '/_native/queue/';

const STATUSES = new Set(['ready', 'running', 'missing', 'unknown', 'queued']);
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function validDto(v: unknown): TrackCacheDto | null {
  const d = v as Partial<TrackCacheDto> | null;
  if (!d || typeof d !== 'object' || !str(d.key, 512)) return null;
  const f = d.facts as Partial<CardFacts> | undefined;
  if (!f || typeof f !== 'object' || typeof f.status !== 'string' || !STATUSES.has(f.status) ||
      typeof f.blocked !== 'boolean' || typeof f.inTarget !== 'boolean' || typeof f.givenUp !== 'boolean' ||
      (f.error !== null && typeof f.error !== 'string')) return null;
  const source = d.source === null || str(d.source) ? d.source ?? null : undefined;
  const ready = d.ready === null || str(d.ready) ? d.ready ?? null : undefined;
  if (source === undefined || ready === undefined) return null;
  return { key: d.key, source, ready, facts: { status: f.status, blocked: f.blocked, inTarget: f.inTarget, givenUp: f.givenUp, error: f.error ?? null } as CardFacts };
}

const COUNT_FIELDS = ['total', 'ready', 'active', 'failed', 'queued', 'parallel', 'retrying'] as const;
function validCounts(v: unknown): QueueCacheStatus | null {
  const c = v as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || typeof c.blocked !== 'boolean' || typeof c.bulkActive !== 'boolean') return null;
  for (const k of COUNT_FIELDS) if (typeof c[k] !== 'number' || !Number.isFinite(c[k]) || (c[k] as number) < 0) return null;
  return c as unknown as QueueCacheStatus;
}

const signature = (tracks: readonly Track[]) => [...new Set(tracks.map(t => t.key))].join('\n');
const REFRESH_MS = 1000;
/**
 * PLAY-PASSIVE-001 (owner, 2026-11-22): "The play button doesnt passively update from black to blue". The service
 * caches the queue by itself, but this view only heard about it when the page asked something, so a song the loader
 * finished stayed black until the listener touched the screen. While a screen is listening, the view now asks the
 * service about the songs it is preparing: often while files are moving, rarely when nothing is.
 */
export const WATCH_BUSY_MS = 1500;
export const WATCH_IDLE_MS = 6000;
const WATCH_MAX = 500;

export interface WatchTimer { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const realTimer: WatchTimer = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export class RemoteQueue implements QueueAudioPort {
  private readonly dtos = new Map<string, TrackCacheDto>();
  private readonly counts = new Map<string, QueueCacheStatus>();
  private readonly refreshedAt = new Map<string, number>();
  private all: QueueCacheStatus | null = null;
  private expired = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;
  /** The songs this page asked the service to prepare (or to look up): the ones a screen can show turning blue. */
  private watched: Track[] = [];
  private watchHandle: unknown = null;
  private watchBusy = false;

  constructor(private readonly client: Pick<ServiceClient, 'request'>, private readonly now: () => number = Date.now,
    private readonly timer: WatchTimer = realTimer) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    this.watch();
    return () => { this.listeners.delete(fn); if (!this.listeners.size) this.unwatch(); };
  }
  sourceHint(track: Track): string | null { return this.dtos.get(track.key)?.source ?? null; }
  readyUrl(track: Track): string | null { return this.dtos.get(track.key)?.ready ?? null; }
  isReady(track: Track): boolean { return this.readyUrl(track) !== null; }
  /** SHUFFLE-START-001: have the service find out what it holds of this list; its answer says. */
  async look(tracks: readonly Track[]): Promise<void> { this.remember(tracks, false); await this.send('look', { tracks }); }
  expiredKeys(): ReadonlySet<string> { return this.expired; }

  snapshot(): QueueCacheStatus {
    return this.all ?? { total: 0, ready: 0, active: 0, failed: 0, blocked: false, queued: 0, parallel: 0, bulkActive: false, retrying: 0 };
  }

  /**
   * The service's counts for this exact list. Until it has answered, every song counts as queued —
   * what the local loader reports for a song it holds no entry for — and a refresh is asked for.
   */
  snapshotFor(tracks: readonly Track[]): QueueCacheStatus {
    const sig = signature(tracks);
    const at = this.refreshedAt.get(sig);
    if (at === undefined || this.now() - at >= REFRESH_MS) {
      this.refreshedAt.set(sig, this.now());
      while (this.refreshedAt.size > 32) this.refreshedAt.delete(this.refreshedAt.keys().next().value!);
      void this.send('snapshot', { tracks }, sig).catch(() => undefined);
    }
    const n = new Set(tracks.map(t => t.key)).size;
    return this.counts.get(sig) ?? { total: n, ready: 0, active: 0, failed: 0, blocked: false, queued: n, parallel: this.all?.parallel ?? 0, bulkActive: false, retrying: 0 };
  }

  downloadAll(tracks: readonly Track[]): void { this.watchBusy = true; this.unwatch(); this.remember(tracks, false); void this.send('download-all', { tracks }).catch(() => undefined); }
  update(tracks: readonly Track[]): void { this.remember(tracks, true); void this.send('update', { tracks }).catch(() => undefined); }
  protect(gb: number, urls: string[]): Promise<unknown> { return this.send('protect', { gb, urls }); }
  limits(o: Parameters<QueuePreloader['limits']>[0]): Promise<unknown> { return this.send('limits', o); }
  retryFailed(): void { void this.send('retry', {}).catch(() => undefined); }

  cardOf(key: string, o: { kept: boolean; percent: number | null }): CardCache {
    const facts = this.dtos.get(key)?.facts ?? { status: 'unknown', blocked: false, inTarget: false, error: null, givenUp: false };
    return cacheStateOf({ ...facts, kept: o.kept, percent: o.percent });
  }

  /** The page's view only: the service keeps playing and caching. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.unwatch();
  }

  /**
   * PLAY-PASSIVE-001: the list to keep asking about. A new prepared list replaces the old one; songs only looked up
   * stay beside it until they are ready. Newest last, within the cap.
   */
  private remember(tracks: readonly Track[], prepared: boolean): void {
    const keep = prepared ? this.watched.filter(t => !this.isReady(t)) : this.watched;
    const seen = new Set<string>();
    const merged: Track[] = [];
    for (const t of prepared ? [...tracks, ...keep] : [...keep, ...tracks]) {
      if (!t?.key || seen.has(t.key)) continue;
      seen.add(t.key); merged.push(t);
    }
    this.watched = merged.slice(0, WATCH_MAX);
    this.watch();
  }

  private watch(): void {
    if (this.disposed || this.watchHandle !== null || !this.listeners.size || !this.watched.length) return;
    this.watchHandle = this.timer.set(() => void this.tick(), this.watchBusy ? WATCH_BUSY_MS : WATCH_IDLE_MS);
  }

  private unwatch(): void {
    if (this.watchHandle !== null) this.timer.clear(this.watchHandle);
    this.watchHandle = null;
  }

  private async tick(): Promise<void> {
    this.watchHandle = null;
    if (this.disposed || !this.listeners.size || !this.watched.length) return;
    const list = this.watched;
    try { await this.send('snapshot', { tracks: list }, signature(list)); } catch { /* the next tick asks again */ }
    const a = this.all;
    this.watchBusy = !!a && (a.active > 0 || a.queued > 0 || a.retrying > 0) && list.some(t => !this.isReady(t));
    this.watch();
  }

  private async send(op: string, body: unknown, sig?: string): Promise<unknown> {
    if (this.disposed) throw new Error('The queue view was disposed.');
    const r = await this.client.request('POST', QUEUE_PATH + op, body);
    if (this.disposed) return r.body;
    if (r.status < 200 || r.status >= 300) {
      const b = r.body as { message?: string } | null;
      throw new Error(b?.message ?? `HTTP ${r.status}`);
    }
    this.absorb(r, sig);
    return r.body;
  }

  private absorb(r: ServiceResponse, sig?: string): void {
    let changed = false;
    const snap = r.cacheSnapshot as Partial<CacheSnapshot> | undefined;
    if (snap && Array.isArray(snap.tracks)) {
      for (const raw of snap.tracks) {
        const d = validDto(raw);
        if (!d) continue;
        const old = this.dtos.get(d.key);
        if (!old || JSON.stringify(old) !== JSON.stringify(d)) { this.dtos.set(d.key, d); changed = true; }
      }
      while (this.dtos.size > 5000) this.dtos.delete(this.dtos.keys().next().value!);
    }
    if (snap && Array.isArray(snap.expired) && snap.expired.every(k => str(k, 512))) {
      const next = new Set(snap.expired);
      if (next.size !== this.expired.size || [...next].some(k => !this.expired.has(k))) { this.expired = next; changed = true; }
    }
    const body = r.body as { counts?: unknown; all?: unknown } | null;
    const counts = validCounts(body?.counts);
    if (counts && sig !== undefined) {
      if (JSON.stringify(this.counts.get(sig)) !== JSON.stringify(counts)) changed = true;
      this.counts.set(sig, counts);
      while (this.counts.size > 32) this.counts.delete(this.counts.keys().next().value!);
    }
    const all = validCounts(body?.all);
    if (all) { if (JSON.stringify(this.all) !== JSON.stringify(all)) changed = true; this.all = all; }
    if (changed) for (const f of this.listeners) f();
  }
}
