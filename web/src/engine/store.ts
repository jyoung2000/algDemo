/**
 * Persistence (port of server/airwave_discovery/store.py). Tables live in memory and every write goes
 * through to a Backend (IndexedDB in the WebView, a Map in tests), so reads are synchronous-fast and a
 * restart loses nothing. User data (kv, seeds, feedback, impressions) is protected; cache and vectors are
 * recomputable and LRU-evicted against `cacheBudget`.
 */
export type Table = 'kv' | 'seeds' | 'feedback' | 'impressions' | 'cache' | 'vectors' | 'transfer';
const TABLES: Table[] = ['kv', 'seeds', 'feedback', 'impressions', 'cache', 'vectors', 'transfer'];

export interface Backend {
  load(): Promise<Partial<Record<Table, [string, unknown][]>>>;
  put(table: Table, key: string, value: unknown): Promise<void>;
  del(table: Table, key: string): Promise<void>;
  clear(table: Table): Promise<void>;
}

export class MemoryBackend implements Backend {
  data: Record<Table, Map<string, unknown>> = Object.fromEntries(TABLES.map((t) => [t, new Map()])) as never;
  async load() {
    return Object.fromEntries(TABLES.map((t) => [t, [...this.data[t]]])) as Partial<Record<Table, [string, unknown][]>>;
  }
  async put(t: Table, k: string, v: unknown) {
    this.data[t].set(k, structuredClone(v));
  }
  async del(t: Table, k: string) {
    this.data[t].delete(k);
  }
  async clear(t: Table) {
    this.data[t].clear();
  }
}

export class DiskFull extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiskFull';
  }
}

export interface FeedbackRow {
  event_id: string;
  key: string;
  kind: string;
  artist: string;
  track: Record<string, unknown> | null;
  listened: number | null;
  ts: number;
  /** v2 (schema version 2) — optional; rows written by v1 lack them. */
  schema?: number;
  duration?: number | null;
  coverage?: number | null;
  medium?: string | null;
  session?: string | null;
  origin?: string | null;
  confidence?: number | null;
}

/** Optional v2 telemetry accepted alongside a feedback event. */
export interface FeedbackMeta {
  duration?: number | null;
  coverage?: number | null;
  medium?: string | null;
  session?: string | null;
  origin?: string | null;
  confidence?: number | null;
}
interface SeedRow {
  pos: number;
  key: string;
  track: Record<string, unknown>;
  emphasis: number;
  added: number;
}
interface CacheRow {
  kind: string;
  v: unknown;
  size: number;
  created: number;
  expires: number;
  accessed: number;
}
interface VectorRow {
  dim: number;
  v: number[];
  source: string;
  created: number;
  accessed: number;
}

const vkey = (rec: string, model: string, pre: string) => `${rec}\u0000${model}\u0000${pre}`;
const day = () => new Date().toISOString().slice(0, 10);

export interface StoreOptions {
  /** Bytes of recomputable data (cache + vectors) kept; the server's STORAGE.database default is 1 GB. */
  cacheBudget?: number;
  /** Refuses writes when the device reports less free space than this (bytes). */
  freeFloor?: number;
  freeBytes?: () => Promise<number | null>;
  now?: () => number;
}

export class Store {
  private kv = new Map<string, unknown>();
  private seedRows: SeedRow[] = [];
  private fb: (FeedbackRow & { id: number })[] = [];
  private fbIds = new Set<string>();
  private nextFb = 1;
  private imp: { id: number; key: string; ts: number }[] = [];
  private nextImp = 1;
  private cache = new Map<string, CacheRow>();
  private vectors = new Map<string, VectorRow>();
  private transfer = new Map<string, number>();
  cacheHits = 0;
  cacheMisses = 0;
  private readonly cacheBudget: number;
  private readonly freeFloor: number;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly be: Backend,
    private readonly opts: StoreOptions,
  ) {
    this.cacheBudget = opts.cacheBudget ?? 1_000_000_000;
    this.freeFloor = opts.freeFloor ?? 0;
    this.now = opts.now ?? (() => Date.now() / 1000);
  }

  static async open(backend: Backend, opts: StoreOptions = {}): Promise<Store> {
    const s = new Store(backend, opts);
    const d = await backend.load();
    for (const [k, v] of d.kv ?? []) s.kv.set(k, v);
    s.seedRows = (d.seeds ?? []).map(([, v]) => v as SeedRow).sort((a, b) => a.pos - b.pos);
    for (const [, v] of d.feedback ?? []) {
      const r = v as FeedbackRow & { id: number };
      s.fb.push(r);
      s.fbIds.add(r.event_id);
      s.nextFb = Math.max(s.nextFb, r.id + 1);
    }
    s.fb.sort((a, b) => a.id - b.id);
    for (const [, v] of d.impressions ?? []) {
      const r = v as { id: number; key: string; ts: number };
      s.imp.push(r);
      s.nextImp = Math.max(s.nextImp, r.id + 1);
    }
    for (const [k, v] of d.cache ?? []) s.cache.set(k, v as CacheRow);
    for (const [k, v] of d.vectors ?? []) s.vectors.set(k, v as VectorRow);
    for (const [k, v] of d.transfer ?? []) s.transfer.set(k, v as number);
    return s;
  }

  /** Writes reach the backend in order; a failed write surfaces on the next flush(). */
  private write(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn);
  }
  flush(): Promise<void> {
    const q = this.queue;
    this.queue = Promise.resolve();
    return q.then(() => undefined);
  }

  private async guard(incoming = 0): Promise<void> {
    if (!this.freeFloor || !this.opts.freeBytes) return;
    const free = await this.opts.freeBytes();
    if (free !== null && free - incoming < this.freeFloor) {
      throw new DiskFull(`only ${Math.floor(free / 1_000_000)} MB free; refusing to write`);
    }
  }

  // ---- settings ----
  get<T = unknown>(k: string, dflt?: T): T | undefined {
    return this.kv.has(k) ? (structuredClone(this.kv.get(k)) as T) : dflt;
  }
  async put(k: string, v: unknown): Promise<void> {
    await this.guard();
    const c = structuredClone(v);
    this.kv.set(k, c);
    this.write(() => this.be.put('kv', k, c));
  }

  // ---- seeds ----
  seeds(): Record<string, unknown>[] {
    return this.seedRows.map((r) => ({ ...structuredClone(r.track), emphasis: r.emphasis }));
  }
  async setSeeds(seeds: Record<string, unknown>[]): Promise<void> {
    await this.guard();
    const t = this.now();
    const rows = seeds.map((s, i) => {
      const { emphasis, ...body } = s;
      return { pos: i, key: String(s.key), track: structuredClone(body), emphasis: emphasis === undefined ? 1 : Number(emphasis), added: t };
    });
    this.seedRows = rows;
    this.write(async () => {
      await this.be.clear('seeds');
      for (const r of rows) await this.be.put('seeds', r.key, r);
    });
  }

  // ---- feedback ----
  /** False when the event id was already recorded (deduplicated). */
  async addFeedback(eventId: string, key: string, kind: string, artist: string, track: Record<string, unknown> | null, listened: number | null, ts?: number, meta?: FeedbackMeta): Promise<boolean> {
    await this.guard();
    if (this.fbIds.has(eventId)) return false;
    const row = { id: this.nextFb++, event_id: eventId, key, kind, artist, track: track ? structuredClone(track) : null, listened, ts: ts || this.now(), ...(meta ? { schema: 2, ...meta } : {}) };
    this.fb.push(row);
    this.fbIds.add(eventId);
    this.write(() => this.be.put('feedback', String(row.id), row));
    return true;
  }
  feedback(): FeedbackRow[] {
    return this.fb.map(({ id: _id, ...r }) => structuredClone(r));
  }
  removeFeedback(key: string, kinds: string[]): number {
    const gone = this.fb.filter((r) => r.key === key && kinds.includes(r.kind));
    if (!gone.length) return 0;
    this.fb = this.fb.filter((r) => !gone.includes(r));
    for (const r of gone) {
      this.fbIds.delete(r.event_id);
      this.write(() => this.be.del('feedback', String(r.id)));
    }
    return gone.length;
  }

  // ---- impressions ----
  async addImpressions(keys: string[], ts?: number): Promise<void> {
    await this.guard();
    const t = ts || this.now();
    for (const key of keys) {
      const row = { id: this.nextImp++, key, ts: t };
      this.imp.push(row);
      this.write(() => this.be.put('impressions', String(row.id), row));
    }
  }
  impressions(since: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.imp) if (r.ts >= since) out[r.key] = (out[r.key] ?? 0) + 1;
    return out;
  }
  expireImpressions(before: number): number {
    const gone = this.imp.filter((r) => r.ts < before);
    this.imp = this.imp.filter((r) => r.ts >= before);
    for (const r of gone) this.write(() => this.be.del('impressions', String(r.id)));
    return gone.length;
  }

  // ---- cache ----
  cacheGet(k: string, allowStale = false): { value: unknown; created: number; stale: boolean } | null {
    const row = this.cache.get(k);
    if (!row) {
      this.cacheMisses++;
      return null;
    }
    const now = this.now();
    if (typeof row.expires !== 'number') {
      // A malformed row is a miss, never a crash.
      this.cache.delete(k);
      this.write(() => this.be.del('cache', k));
      this.cacheMisses++;
      return null;
    }
    if (row.expires < now && !allowStale) {
      this.cacheMisses++;
      return null;
    }
    row.accessed = now;
    this.cacheHits++;
    return { value: structuredClone(row.v), created: row.created, stale: row.expires < now };
  }
  async cachePut(k: string, kind: string, value: unknown, ttl: number): Promise<void> {
    const size = JSON.stringify(value).length;
    await this.guard(size);
    const now = this.now();
    const row: CacheRow = { kind, v: structuredClone(value), size, created: now, expires: now + ttl, accessed: now };
    this.cache.set(k, row);
    this.write(() => this.be.put('cache', k, row));
    this.evict();
  }
  cacheBytes(): number {
    let n = 0;
    for (const r of this.cache.values()) n += r.size;
    for (const r of this.vectors.values()) n += r.v.length * 4;
    return n;
  }
  /** LRU-evict cache rows, then vectors, until recomputable data fits the budget. */
  evict(budget = this.cacheBudget): number {
    let total = this.cacheBytes();
    if (total <= budget) return 0;
    let removed = 0;
    const byAccess = <T extends { accessed: number }>(m: Map<string, T>) => [...m.entries()].sort((a, b) => a[1].accessed - b[1].accessed);
    for (const [k, r] of byAccess(this.cache)) {
      if (total <= budget) return removed;
      this.cache.delete(k);
      this.write(() => this.be.del('cache', k));
      total -= r.size;
      removed++;
    }
    for (const [k, r] of byAccess(this.vectors)) {
      if (total <= budget) return removed;
      this.vectors.delete(k);
      this.write(() => this.be.del('vectors', k));
      total -= r.v.length * 4;
      removed++;
    }
    return removed;
  }
  clearCache(): void {
    this.cache.clear();
    this.write(() => this.be.clear('cache'));
  }

  // ---- vectors ----
  vectorGet(rec: string, model: string, pre: string): Float32Array | null {
    const k = vkey(rec, model, pre);
    const row = this.vectors.get(k);
    if (!row) return null;
    row.accessed = this.now();
    return Float32Array.from(row.v.slice(0, row.dim));
  }
  async vectorPut(rec: string, model: string, pre: string, v: ArrayLike<number>, source: string): Promise<void> {
    await this.guard(v.length * 4);
    const t = this.now();
    const row: VectorRow = { dim: v.length, v: Array.from(v), source, created: t, accessed: t };
    const k = vkey(rec, model, pre);
    this.vectors.set(k, row);
    this.write(() => this.be.put('vectors', k, row));
    this.evict();
  }
  vectorCount(): number {
    return this.vectors.size;
  }

  // ---- transfer accounting ----
  addTransfer(category: string, n: number, d: string = day()): void {
    if (n <= 0) return;
    const k = `${d}\u0000${category}`;
    const total = (this.transfer.get(k) ?? 0) + n;
    this.transfer.set(k, total);
    this.write(() => this.be.put('transfer', k, total));
  }
  transferToday(d: string = day()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, n] of this.transfer) {
      const [dd, cat] = k.split('\u0000');
      if (dd === d) out[cat!] = n;
    }
    return out;
  }

  // ---- export / reset ----
  export(): Record<string, unknown> {
    return {
      format: 'airwave-discovery-export/1',
      exported: new Date(this.now() * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      seeds: this.seeds(),
      settings: this.get('settings', {}),
      feedback: this.feedback(),
    };
  }
  reset(keepCache = true): void {
    this.seedRows = [];
    this.fb = [];
    this.fbIds.clear();
    this.imp = [];
    this.kv.clear();
    const clear: Table[] = ['seeds', 'feedback', 'impressions', 'kv'];
    if (!keepCache) {
      this.cache.clear();
      this.vectors.clear();
      clear.push('cache', 'vectors');
    }
    for (const t of clear) this.write(() => this.be.clear(t));
  }
}
