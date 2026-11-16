/**
 * SERVICE-API-001: the Android UI page's client for the ONE engine the playback service owns.
 *
 * When the native UI bridge exposes `AirwaveNative.api(id, json)`, every `api` call is sent to the
 * service engine instead of opening a second LocalApi (and a second writer on the same Store) inside
 * the page. The service answers through `window.__awApi(id, json)` with `{ status, body, ... }`.
 *
 * Old APKs, Windows and the browser have no `api` method, so `serviceClient()` is null there and the
 * existing in-page engine is used unchanged. The service's own page never exposes `api()` (its bridge
 * carries `serviceApiVersion` instead), so routing can never recurse into itself.
 */

export interface ApiBridge { api(id: number, json: string): void }

export interface ServiceResponse { status: number; body: unknown; [extra: string]: unknown }

/** Timers for the deadline; injectable so tests and native-backed clocks need no global patching. */
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const timerScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class ServiceError extends Error {
  constructor(message: string, readonly reason: 'timeout' | 'aborted' | 'bridge' | 'busy' | 'malformed') {
    super(message);
  }
}

interface Pending {
  resolve: (r: ServiceResponse) => void;
  reject: (e: unknown) => void;
  done: () => void;
}

export interface ServiceClientOptions { timeoutMs?: number; maxPending?: number }

/** 2 MB, the same order as the native media envelope; a larger request is refused, not truncated. */
const MAX_REQUEST_CHARS = 2_000_000;

export class ServiceClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(private readonly bridge: ApiBridge, private readonly scheduler: Scheduler = timerScheduler, opts: ServiceClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxPending = opts.maxPending ?? 64;
  }

  get pendingCount(): number { return this.pending.size; }

  request(method: string, path: string, body: unknown = null, signal?: AbortSignal | null): Promise<ServiceResponse> {
    if (signal?.aborted) return Promise.reject(new ServiceError('The request was cancelled.', 'aborted'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new ServiceError('Too many requests are waiting for the engine.', 'busy'));
    const id = this.nextId++;
    if (this.nextId > Number.MAX_SAFE_INTEGER) this.nextId = 1;
    let json: string;
    try {
      json = JSON.stringify({ method, path, body });
    } catch {
      return Promise.reject(new ServiceError('The request could not be encoded.', 'malformed'));
    }
    if (json.length > MAX_REQUEST_CHARS) return Promise.reject(new ServiceError('The request is too large.', 'malformed'));
    return new Promise<ServiceResponse>((resolve, reject) => {
      const timer = this.scheduler.set(() => {
        if (!this.pending.has(id)) return;
        done();
        reject(new ServiceError('The engine did not answer in time.', 'timeout'));
      }, this.timeoutMs);
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        done();
        reject(new ServiceError('The request was cancelled.', 'aborted'));
      };
      const done = () => {
        this.pending.delete(id);
        this.scheduler.clear(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, done });
      try {
        this.bridge.api(id, json);
      } catch (e) {
        done();
        reject(new ServiceError(`The engine bridge failed: ${e instanceof Error ? e.message : String(e)}`, 'bridge'));
      }
    });
  }

  /**
   * One reply from native. Returns false (and changes nothing) for an unknown, stale, timed-out or
   * cancelled id; a malformed reply to a live id rejects that request rather than hanging it.
   */
  receive(id: unknown, json: unknown): boolean {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return false;
    const p = this.pending.get(id);
    if (!p) return false;
    p.done();
    let parsed: unknown;
    try {
      parsed = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
      p.reject(new ServiceError('The engine sent an unreadable reply.', 'malformed'));
      return true;
    }
    const r = parsed as Partial<ServiceResponse> | null;
    if (!r || typeof r !== 'object' || typeof r.status !== 'number' || !Number.isInteger(r.status) || !('body' in r)) {
      p.reject(new ServiceError('The engine sent an unreadable reply.', 'malformed'));
      return true;
    }
    p.resolve(r as ServiceResponse);
    return true;
  }
}

type BridgeWindow = {
  AirwaveNative?: { api?: unknown; apiMode?: unknown; claimLocal?: unknown; serviceApiVersion?: unknown };
  __awApi?: (id: unknown, json: unknown) => boolean;
};

const win = (): BridgeWindow | undefined => (typeof window === 'undefined' ? undefined : (window as unknown as BridgeWindow));

/**
 * The UI bridge's api method, or null on old APKs, other platforms and the service's own page — and
 * when native says this page may open the original database itself (`apiMode() === 'local'`: the
 * service engine never opened it, MainActivity's EngineOwner) and the claim succeeds.
 */
export function nativeApiBridge(w: BridgeWindow | undefined = win()): ApiBridge | null {
  const n = w?.AirwaveNative;
  if (!n || typeof n.api !== 'function' || 'serviceApiVersion' in n) return null;
  if (typeof n.apiMode === 'function') {
    let mode: unknown;
    try { mode = (n.apiMode as () => unknown).call(n); } catch { mode = 'service'; }
    // Only an explicit, successful local claim lets this page open the database (see claimLocal).
    if (mode === 'local' && claimLocalOn(n)) return null;
  }
  return { api: (id, json) => (n.api as (id: number, json: string) => void).call(n, id, json) };
}

function claimLocalOn(n: NonNullable<BridgeWindow['AirwaveNative']>): boolean {
  if (typeof n.claimLocal !== 'function') return false;
  try { return (n.claimLocal as () => unknown).call(n) === true; } catch { return false; }
}

let client: ServiceClient | null | undefined;
const localListeners = new Set<() => void>();

/** The page's one client, installing `window.__awApi` on first use; null when there is no bridge. */
export function serviceClient(): ServiceClient | null {
  if (client !== undefined) return client;
  const bridge = nativeApiBridge();
  client = bridge ? new ServiceClient(bridge) : null;
  if (client) {
    const c = client;
    win()!.__awApi = (id, json) => c.receive(id, json);
  }
  return client;
}

/**
 * The service answered `local: true`: its engine never opened the original database. Claim it for
 * this page; on success every later request (and the queue cache) runs here. False keeps the client.
 */
export function switchToLocal(w: BridgeWindow | undefined = win()): boolean {
  if (client === null) return true;
  const n = w?.AirwaveNative;
  if (!n || !claimLocalOn(n)) return false;
  client = null;
  for (const f of localListeners) { try { f(); } catch { /* a listener must not stop the switch */ } }
  return true;
}

/** Told once when this page switches from the service to its own engine. */
export function onSwitchToLocal(fn: () => void): () => void { localListeners.add(fn); return () => { localListeners.delete(fn); }; }

/** For tests: forget the page's client decision. */
export function resetServiceClientForTest(): void { client = undefined; localListeners.clear(); }
