/**
 * SERVICE-API-001: the playback service's engine page answering the Android UI and the car.
 *
 * One LocalApi (the original database), one QueuePreloader, one CarCatalog. The UI page's requests
 * arrive as `{ id, method, path, body }` and go to the same LocalApi routes and guards the page used
 * to run itself; `/_native/queue/*` reaches the one queue cache. Nothing here tunnels arbitrary HTTP.
 *
 * CarSources keeps the car-selected list in charge of the cache while the native player is playing
 * from it: a hidden UI page's automatic prefetch can no longer replace that list, and source patches
 * are only what the queue cache actually holds.
 */
import type { Track } from '../api';
import { QUEUE_PATH, type CacheSnapshot, type ServiceQueue, type TrackCacheDto } from './queue-remote';
import type { ServiceResponse } from './service-client';

export interface LocalHandler { handle(method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> }

export interface NativeRequest { id: string; method: string; path: string; body: unknown }

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_TRACKS = 2000;

/** Raw tracks exactly as sent, or null when any entry lacks a key and title. */
export function parseTracks(v: unknown): Track[] | null {
  if (!Array.isArray(v) || v.length > MAX_TRACKS) return null;
  for (const t of v) {
    const o = t as Partial<Track> | null;
    if (!o || typeof o !== 'object' || typeof o.key !== 'string' || !o.key || o.key.length > 512 || typeof o.title !== 'string') return null;
  }
  return v as Track[];
}

export function cacheSnapshotOf(queue: ServiceQueue, tracks: readonly Track[]): CacheSnapshot {
  const unique = [...new Map(tracks.map(t => [t.key, t])).values()];
  return {
    tracks: unique.map((t): TrackCacheDto => ({ key: t.key, source: queue.sourceHint(t), ready: queue.readyUrl(t), facts: queue.cardFacts(t.key) })),
    expired: [...queue.expiredKeys()],
  };
}

/** EnginePlayer.stateJson (EnginePlayer.kt), the fields the source controller reads. */
export interface EngineSnapshot {
  rev: number;
  id: string | null;
  mediaId: string | null;
  playing: boolean;
  waiting: boolean;
  streaming: boolean;
  ended: boolean;
  error: string | null;
}

export function parseEngineSnapshot(json: unknown): EngineSnapshot | null {
  let o: Record<string, unknown>;
  try {
    o = (typeof json === 'string' ? JSON.parse(json) : json) as Record<string, unknown>;
  } catch { return null; }
  if (!o || typeof o !== 'object' || typeof o.rev !== 'number') return null;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    rev: o.rev, id: s(o.id), mediaId: s(o.mediaId), playing: o.playing === true, waiting: o.waiting === true,
    streaming: o.streaming === true, ended: o.ended === true, error: s(o.error),
  };
}

/** A song and the list it plays in, as the car offered it; ids are the car's media ids for that list. */
export interface CarContext { tracks: Track[]; ids: string[]; index: number }
export interface ContextSource { contextOf(id: string): CarContext | null }

/** The first source that knows the id answers. */
export class ChainedContexts implements ContextSource {
  constructor(private readonly sources: readonly ContextSource[]) {}
  contextOf(id: string): CarContext | null {
    for (const s of this.sources) { const c = s.contextOf(id); if (c) return c; }
    return null;
  }
}

interface LibSong { id: string }
interface LibList { id: string; songs: LibSong[] }
/** `AirwaveNative.library()`: the library the UI page last pushed, and the original Tracks it sent. */
export interface LibrarySnapshot { songs: LibSong[]; playlists: LibList[]; tracks: Track[] }

const MAX_LIB_SONGS = 5000;

/** The snapshot, or an empty one when it is missing or malformed; entries that do not parse are left out. */
export function parseLibrary(json: unknown): LibrarySnapshot {
  const empty: LibrarySnapshot = { songs: [], playlists: [], tracks: [] };
  let o: { library?: { songs?: unknown; playlists?: unknown } | null; tracks?: unknown };
  try { o = (typeof json === 'string' ? JSON.parse(json) : json) as typeof o; } catch { return empty; }
  if (!o || typeof o !== 'object') return empty;
  const songsOf = (v: unknown): LibSong[] => (Array.isArray(v) ? v.slice(0, MAX_LIB_SONGS) : [])
    .flatMap(s => (s && typeof s === 'object' && typeof (s as LibSong).id === 'string' && (s as LibSong).id ? [{ id: (s as LibSong).id }] : []));
  const lib = o.library && typeof o.library === 'object' ? o.library : null;
  const playlists = (Array.isArray(lib?.playlists) ? lib!.playlists as unknown[] : []).slice(0, 500).flatMap((p): LibList[] => {
    const l = p as { id?: unknown; songs?: unknown } | null;
    return l && typeof l.id === 'string' && l.id ? [{ id: l.id, songs: songsOf(l.songs) }] : [];
  });
  const tracks = (Array.isArray(o.tracks) ? o.tracks.slice(0, MAX_TRACKS) : []).filter((t): t is Track => {
    const x = t as Partial<Track> | null;
    return !!x && typeof x === 'object' && typeof x.key === 'string' && !!x.key && x.key.length <= 512 && typeof x.title === 'string';
  });
  return { songs: songsOf(lib?.songs), playlists, tracks };
}

/**
 * SERVICE-API-001: the saved queue and playlists as car contexts, from the original Tracks the UI
 * page sent (by exact key). A song whose original Track is not known is left out, never rebuilt from
 * its title; a tapped song that is not known gives no context at all.
 */
export class LibraryContexts implements ContextSource {
  private readonly byKey: Map<string, Track>;
  constructor(private readonly lib: LibrarySnapshot) { this.byKey = new Map(lib.tracks.map(t => [t.key, t])); }

  contextOf(id: string): CarContext | null {
    const scoped = /^playlist\/([^/]+)\/track\/([^/]+)$/.exec(id);
    if (scoped) {
      let listId: string, key: string;
      try { listId = decodeURIComponent(scoped[1]!); key = decodeURIComponent(scoped[2]!); } catch { return null; }
      const list = this.lib.playlists.find(l => l.id === listId);
      if (!list) return null;
      const tracks = this.known(list.songs);
      const index = tracks.findIndex(t => t.key === key);
      if (index < 0) return null;
      const ids = tracks.map(t => `playlist/${encodeURIComponent(listId)}/track/${encodeURIComponent(t.key)}`);
      ids[index] = id; // the car's own id for the tapped song, exactly
      return { tracks, ids, index };
    }
    if (id.includes('/')) return null;
    const tracks = this.known(this.lib.songs);
    const index = tracks.findIndex(t => t.key === id);
    return index < 0 ? null : { tracks, ids: tracks.map(t => t.key), index };
  }

  private known(songs: readonly LibSong[]): Track[] {
    const seen = new Set<string>();
    return songs.flatMap(s => {
      const t = this.byKey.get(s.id);
      if (!t || seen.has(t.key)) return [];
      seen.add(t.key);
      return [t];
    });
  }
}

export interface SourceUpdate { id: string; key: string; ready: boolean; source: string | null }

export class CarSources {
  private owner: CarContext | null = null;
  private order = '';
  private rev = -1;
  private lastState = '';
  private gb = 1;
  private readonly sent = new Map<string, string>();
  private readonly unsubscribe: () => void;
  /** The UI's last automatic list while the car held the cache; applied once the car lets go. */
  private deferred: Track[] | null = null;

  constructor(private readonly d: { contexts: ContextSource; queue: ServiceQueue; emit: (updates: SourceUpdate[]) => void }) {
    this.unsubscribe = d.queue.subscribe(() => this.flush());
  }

  owned(): boolean { return this.owner !== null; }
  context(id: string): CarContext | null { return this.d.contexts.contextOf(id); }
  setGb(gb: number): void { this.gb = gb; }
  defer(tracks: Track[]): void { this.deferred = tracks; }

  /**
   * One native player state. CAR-STATE-REV-001: EnginePlayer.rev counts only native-made changes, so it
   * repeats across states (a car tap included): only a strictly OLDER revision is stale. A state
   * identical to the last one handled is skipped, except while no car context was found for its song
   * (a cold start's restored song becomes known once the car searches).
   */
  onState(json: unknown): void {
    const snap = parseEngineSnapshot(json);
    if (!snap || snap.rev < this.rev) return;
    this.rev = snap.rev;
    const mediaId = snap.mediaId ?? snap.id;
    if (!mediaId) return;
    const sig = `${snap.rev}\n${mediaId}\n${snap.waiting}\n${snap.playing}`;
    if (sig === this.lastState && this.owner) return;
    this.lastState = sig;
    let index = this.owner ? this.owner.ids.indexOf(mediaId) : -1;
    if (index < 0) {
      const ctx = this.d.contexts.contextOf(mediaId);
      if (!ctx) { this.release(); return; }
      this.owner = ctx;
      this.sent.clear();
      index = ctx.index;
    }
    const ctx = this.owner!;
    // Listening order: the current song, what follows it, then the songs before it.
    const ordered = [...ctx.tracks.slice(index), ...ctx.tracks.slice(0, index)];
    const order = ordered.map(t => t.key).join('\n');
    if (order !== this.order) {
      this.order = order;
      this.d.queue.update(ordered);
    }
    const near = [ctx.tracks[index], ctx.tracks[index - 1], ctx.tracks[index + 1]]
      .flatMap(t => (t ? [this.d.queue.sourceHint(t)] : [])).filter((u): u is string => u !== null);
    void this.d.queue.protect(this.gb, near).catch(() => undefined);
    this.flush();
  }

  private release(): void {
    if (!this.owner) return;
    this.owner = null;
    this.order = '';
    this.sent.clear();
    const pending = this.deferred;
    this.deferred = null;
    if (pending) this.d.queue.update(pending);
  }

  /** Patches only for songs whose held file changed since the last patch. */
  flush(): void {
    const ctx = this.owner;
    if (!ctx) return;
    const updates: SourceUpdate[] = [];
    ctx.tracks.forEach((t, i) => {
      const source = this.d.queue.readyUrl(t);
      const id = ctx.ids[i]!;
      const mark = source ?? '';
      if (this.sent.get(id) === mark || (!this.sent.has(id) && source === null)) return;
      this.sent.set(id, mark);
      updates.push({ id, key: t.key, ready: source !== null, source });
    });
    if (updates.length) this.d.emit(updates);
  }

  dispose(): void { this.unsubscribe(); }
}

export class ServiceActor {
  constructor(private readonly d: { local: LocalHandler; queue: ServiceQueue; cars: CarSources; reply: (id: string, json: string) => void }) {}

  /** `window.__awServiceApi`: always replies to a request that carries an id. */
  async onRequest(json: unknown): Promise<boolean> {
    let req: Partial<NativeRequest>;
    try {
      req = (typeof json === 'string' ? JSON.parse(json) : json) as Partial<NativeRequest>;
    } catch { return false; }
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || !req.id || req.id.length > 128) return false;
    const id = req.id;
    let res: ServiceResponse;
    if (typeof req.method !== 'string' || !METHODS.has(req.method) || typeof req.path !== 'string' || !req.path.startsWith('/') || req.path.length > 4096) {
      res = bad();
    } else {
      try {
        res = await this.route(req.method, req.path, req.body ?? null);
      } catch (e) {
        res = { status: 500, body: { message: e instanceof Error ? e.message : String(e) } };
      }
    }
    let out: string;
    try { out = JSON.stringify(res); } catch { out = JSON.stringify({ status: 500, body: { message: 'Unencodable engine reply.' } }); }
    this.d.reply(id, out);
    return true;
  }

  async route(method: string, path: string, body: unknown): Promise<ServiceResponse> {
    if (path.startsWith('/_native/')) return this.native(method, path, body);
    return this.d.local.handle(method, path, body);
  }

  private async native(method: string, path: string, body: unknown): Promise<ServiceResponse> {
    if (path === '/_native/context') {
      const id = (body as { id?: unknown } | null)?.id;
      if (method !== 'POST' || typeof id !== 'string' || !id || id.length > 2048) return bad();
      const ctx = this.d.cars.context(id);
      return ctx ? { status: 200, body: ctx } : { status: 404, body: { message: 'Unknown car song.', code: 'none' } };
    }
    if (!path.startsWith(QUEUE_PATH) || method !== 'POST') return { status: 404, body: { message: 'Not found.' } };
    const q = this.d.queue;
    const b = (body ?? {}) as Record<string, unknown>;
    const op = path.slice(QUEUE_PATH.length);
    const tracks = parseTracks(b.tracks);
    const reply = (extra: Record<string, unknown>, list: readonly Track[] = []): ServiceResponse =>
      ({ status: 200, body: { ...extra, all: q.snapshot() }, cacheSnapshot: cacheSnapshotOf(q, list) });
    switch (op) {
      case 'snapshot':
        if (!tracks) return bad();
        return reply({ counts: q.snapshotFor(tracks) }, tracks);
      case 'look':
        // SHUFFLE-START-001: what is held of a list the loader was never given. Asks only.
        if (!tracks) return bad();
        await q.look(tracks);
        return reply({}, tracks);
      case 'update':
        if (!tracks) return bad();
        // The car's list holds the cache while the native player plays from it.
        if (this.d.cars.owned()) { this.d.cars.defer(tracks); return reply({ applied: false, reason: 'car' }, tracks); }
        q.update(tracks);
        return reply({ applied: true }, tracks);
      case 'download-all':
        if (!tracks) return bad();
        q.downloadAll(tracks);
        return reply({}, tracks);
      case 'protect': {
        const gb = b.gb, urls = b.urls;
        if (typeof gb !== 'number' || !Number.isFinite(gb) || gb <= 0 || !Array.isArray(urls) || urls.length > 16 || !urls.every(u => typeof u === 'string' && u.length <= 4096)) return bad();
        this.d.cars.setGb(gb);
        // While the car plays, its current/neighbour files stay protected; the UI only sets the size.
        const applied = !this.d.cars.owned();
        if (applied) await q.protect(gb, urls as string[]);
        return reply({ applied });
      }
      case 'limits': {
        const parallel = b.parallel, preload = b.preload as { target?: unknown; count?: unknown } | undefined;
        if (parallel !== undefined && (typeof parallel !== 'number' || !Number.isFinite(parallel) || parallel < 1)) return bad();
        if (preload !== undefined && (!preload || typeof preload !== 'object' || typeof preload.target !== 'string' || typeof preload.count !== 'number')) return bad();
        await q.limits(b as Parameters<ServiceQueue['limits']>[0]);
        return reply({});
      }
      case 'retry':
        q.retryFailed();
        return reply({});
      default:
        return { status: 404, body: { message: 'Not found.' } };
    }
  }
}

const bad = (): ServiceResponse => ({ status: 400, body: { message: 'Bad engine request.' } });
