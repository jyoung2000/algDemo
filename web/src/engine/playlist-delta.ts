/**
 * PLAYLIST-DELTA-001 (owner, 2026-11-23): "On android adding songs to playlist doesnt work and the playlist dont
 * load or save the music".
 *
 * Every playlist call used to answer with every list's every song (about 2 KB a song, genres and all). Measured on
 * the Android emulator: 4 lists of 400 songs made one tick of the save menu take 1.7 s; 20 lists of 450 took 8-18 s;
 * and past 8,000,000 characters the page-to-service bridge refused the reply, so the lists never loaded and nothing
 * could be added. The app's own limits (50 lists of 500 songs, plus saved albums) reach that many times over.
 *
 * Now each list's songs travel under a version. The page says which versions it holds; the engine sends the songs
 * only for lists whose version differs, and only up to a bounded size per reply — the page asks again for the rest.
 * A caller that names no versions (an older page, the tests of older behaviour) is answered in full, as before.
 */
import type { PlaylistSummary } from '../api';

/** Characters of songs one reply may carry before the remaining lists are left for the next call. */
export const PLAYLIST_REPLY_BUDGET = 1_500_000;

/** What travels: a list with its songs, or without them when unchanged (`same`) or still to come (`more`). */
export type WireList = Omit<PlaylistSummary, 'items'> & { items?: PlaylistSummary['items']; rev?: string; same?: boolean; more?: boolean };
export interface WireReply { lists: WireList[] }
export type Held = Record<string, string>;

/** FNV-1a over the text, with its length: cheap, and two different song lists do not share it by accident. */
export function revOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/** The caller's versions: null when it sent none at all (answer in full), {} when it holds nothing yet. */
export function parseHeld(v: unknown): Held | null {
  if (v === null || v === undefined) return null;
  let o: unknown = v;
  if (typeof v === 'string') {
    try { o = JSON.parse(v); } catch { return {}; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
  const out: Held = {};
  for (const [k, r] of Object.entries(o as Record<string, unknown>)) if (typeof r === 'string') out[k] = r;
  return out;
}

/**
 * The engine's side: leave out the songs of lists the caller already holds, and of lists that would take the reply
 * past [budget]. At least one list the caller lacks is always sent, so asking again always makes progress.
 */
export function shapeLists<T extends { id: string; items: unknown[] }>(lists: T[], held: Held | null, budget = PLAYLIST_REPLY_BUDGET): (T | (Omit<T, 'items'> & { rev: string; same?: true; more?: true; items?: unknown[] }))[] {
  if (held === null) return lists;
  let used = 0;
  return lists.map((l) => {
    const { rev, size } = measure(l.items);
    const { items, ...rest } = l;
    if (held[l.id] === rev) return { ...rest, rev, same: true as const };
    if (used > 0 && used + size > budget) return { ...rest, rev, more: true as const };
    used += size;
    return { ...rest, rev, items };
  });
}

/** The version and size of one list's songs, worked out once for as long as that very array is kept. */
const measured = new WeakMap<object, { rev: string; size: number }>();
function measure(items: unknown[]): { rev: string; size: number } {
  let m = measured.get(items);
  if (!m) {
    const text = JSON.stringify(items);
    m = { rev: revOf(text), size: text.length };
    measured.set(items, m);
  }
  return m;
}

/** The page's side: what each list held when the engine last sent it. */
export class ListCache {
  private readonly lists = new Map<string, { rev: string; items: PlaylistSummary['items'] }>();

  held(): Held {
    return Object.fromEntries([...this.lists].map(([id, v]) => [id, v.rev]));
  }

  clear(): void { this.lists.clear(); }

  /**
   * One read or edit, then as many follow-up reads as it takes to hold every list. [first] is the call itself (an
   * edit is made once); [more] only reads. Throws rather than return a list without its songs.
   */
  async read(first: (held: Held) => Promise<WireReply>, more: (held: Held) => Promise<WireReply> = first): Promise<{ lists: PlaylistSummary[] }> {
    let reply = await first(this.held());
    for (let round = 0; ; round++) {
      const before = this.lists.size;
      const changed = this.absorb(reply);
      const lacking = (reply.lists ?? []).filter((l) => !Array.isArray(l.items) && this.lists.get(l.id)?.rev !== l.rev);
      if (!lacking.length) break;
      // Nothing new arrived and something is still missing: the engine is not going to send it.
      if (round > 0 && !changed && this.lists.size === before) throw new Error('Your lists could not be loaded. Try again.');
      if (round > 200) throw new Error('Your lists could not be loaded. Try again.');
      reply = await more(this.held());
    }
    return {
      ...reply,
      lists: (reply.lists ?? []).map((l) => {
        const { rev: _rev, same: _same, more: _more, ...rest } = l;
        return { ...rest, items: Array.isArray(l.items) ? l.items : this.lists.get(l.id)!.items };
      }),
    };
  }

  /** Keep what was sent, forget lists that no longer exist. True when any list's songs were taken in. */
  private absorb(reply: WireReply): boolean {
    const ids = new Set((reply.lists ?? []).map((l) => l.id));
    for (const id of [...this.lists.keys()]) if (!ids.has(id)) this.lists.delete(id);
    let took = false;
    for (const l of reply.lists ?? []) {
      if (!Array.isArray(l.items)) {
        // "Same" for a version this page does not hold: drop ours so the next call asks for it outright.
        if (this.lists.has(l.id) && this.lists.get(l.id)!.rev !== l.rev) this.lists.delete(l.id);
        continue;
      }
      if (typeof l.rev === 'string' && l.rev) {
        if (this.lists.get(l.id)?.rev !== l.rev) took = true;
        this.lists.set(l.id, { rev: l.rev, items: l.items });
      }
    }
    return took;
  }
}

/**
 * PLAYLIST-KEEP-001: read something the screen already shows, and on failure try again instead of blanking it.
 * A failed read of the lists used to be shown as "no lists": the save menu then offered only "New list", and the
 * empty set was pushed to the car, which lost its Playlists (and with them the heart's playlist choices).
 * Returns a stop function; a read already under way may still deliver its answer.
 */
export function keepTrying<T>(read: () => Promise<T>, onValue: (v: T) => void, opts: { tries?: number; waitMs?: number; schedule?: (fn: () => void, ms: number) => unknown; cancel?: (h: unknown) => void } = {}): () => void {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const waitMs = opts.waitMs ?? 3000;
  let left = opts.tries ?? 6;
  let stopped = false;
  let timer: unknown = null;
  const go = (): void => {
    read().then(onValue, () => {
      if (stopped || left-- <= 0) return;
      timer = schedule(go, waitMs);
    });
  };
  go();
  return () => {
    stopped = true;
    if (timer !== null) cancel(timer);
  };
}
