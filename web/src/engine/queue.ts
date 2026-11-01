/**
 * The one listening queue (port of server/airwave_discovery/queue.py).
 *
 * Searched songs and discovered songs share one ordered list. `current` and `history` drive
 * Next/Previous: Previous returns to the song that was actually played, not to the list position.
 * Every change bumps `version` and calls the subscribers, which is how the UI gets live updates
 * (the server version did this with Server-Sent Events).
 */
import type { Playback, RecItem, Track } from '../api';

export type QueueSource = 'searched' | 'discovered';

export interface QueueEntry {
  id: string;
  source: QueueSource;
  track: Track;
  playback: Playback;
  rec: RecItem | null;
  added_at: number;
}

export interface QueueState {
  entries: QueueEntry[];
  current: string | null;
  history: string[];
  discovering: boolean;
  discover_note: string;
  saved_at: number | null;
  version: number;
}

export type QueueSnapshot = Pick<QueueState, 'entries' | 'current' | 'history'>;

export const MAX_ENTRIES = 500;

export class QueueError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

const newId = (): string => {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID().replace(/-/g, '').slice(0, 12);
  return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
};

export class ListeningQueue {
  entries: QueueEntry[] = [];
  current: string | null = null;
  history: string[] = [];
  discovering = false;
  discoverNote = '';
  savedAt: number | null = null;
  version = 0;
  private listeners = new Set<(s: QueueState) => void>();

  constructor(saved?: Partial<QueueSnapshot> | null, private readonly now: () => number = () => Date.now() / 1000) {
    if (saved) this.restore(saved);
  }

  private restore(saved: Partial<QueueSnapshot>): void {
    for (const raw of saved.entries ?? []) {
      if (!raw || typeof raw !== 'object' || !raw.id) continue;
      if (raw.source !== 'searched' && raw.source !== 'discovered') continue;
      if (!raw.track || typeof raw.track !== 'object') continue;
      this.entries.push({
        id: String(raw.id),
        source: raw.source,
        track: raw.track,
        playback: raw.playback ?? ({ open: [], preview: null, embed: null } as Playback),
        rec: raw.rec ?? null,
        added_at: Number(raw.added_at) || this.now(),
      });
    }
    const ids = new Set(this.entries.map((e) => e.id));
    this.current = saved.current && ids.has(saved.current) ? saved.current : null;
    this.history = (saved.history ?? []).filter((i) => ids.has(i));
    this.savedAt = this.now();
  }

  subscribe(fn: (s: QueueState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state());
    return () => this.listeners.delete(fn);
  }

  private touch(): void {
    this.version += 1;
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  state(): QueueState {
    return {
      entries: this.entries.map((e) => ({ ...e })),
      current: this.current,
      history: [...this.history],
      discovering: this.discovering,
      discover_note: this.discoverNote,
      saved_at: this.savedAt,
      version: this.version,
    };
  }

  snapshotForStore(): QueueSnapshot {
    return { entries: this.entries.map((e) => ({ ...e })), current: this.current, history: [...this.history] };
  }

  find(id: string): QueueEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  searched(): QueueEntry[] {
    return this.entries.filter((e) => e.source === 'searched');
  }

  private hasKey(key: string | undefined): boolean {
    return !!key && this.entries.some((e) => e.track.key === key);
  }

  addSearched(track: Track, playback: Playback): QueueEntry {
    if (this.hasKey(track.key)) throw new QueueError('That song is already in the queue.', 409);
    const e: QueueEntry = { id: newId(), source: 'searched', track, playback, rec: null, added_at: this.now() };
    // After the last searched song: the listener's own order is kept and discovery's songs stay below.
    let last = -1;
    this.entries.forEach((x, i) => {
      if (x.source === 'searched') last = i;
    });
    this.entries.splice(last + 1, 0, e);
    this.touch();
    return e;
  }

  appendDiscovered(track: Track, playback: Playback, rec: RecItem): QueueEntry | null {
    if (this.hasKey(track.key) || this.entries.length >= MAX_ENTRIES) return null;
    const e: QueueEntry = { id: newId(), source: 'discovered', track, playback, rec, added_at: this.now() };
    this.entries.push(e);
    this.touch();
    return e;
  }

  remove(id: string): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new QueueError('That song is no longer in the queue.', 404);
    this.entries.splice(idx, 1);
    this.history = this.history.filter((i) => i !== id);
    // Removing the playing song moves to the one after it, as if it had finished.
    if (this.current === id) this.current = idx < this.entries.length ? this.entries[idx]!.id : null;
    this.touch();
  }

  play(id: string): void {
    if (!this.find(id)) throw new QueueError('That song is no longer in the queue.', 404);
    if (this.current && this.current !== id) this.history.push(this.current);
    this.current = id;
    this.touch();
  }

  next(): void {
    if (this.current === null) {
      if (!this.entries.length) throw new QueueError('The queue is empty.', 409);
      this.current = this.entries[0]!.id;
      this.touch();
      return;
    }
    const idx = this.entries.findIndex((e) => e.id === this.current);
    if (idx < 0) {
      this.current = null;
    } else if (idx + 1 < this.entries.length) {
      this.history.push(this.current);
      this.current = this.entries[idx + 1]!.id;
    } else {
      // The end of the queue: nothing after it; the song stays in history as played.
      this.history.push(this.current);
      this.current = null;
    }
    this.touch();
  }

  previous(): void {
    // Skip history entries whose songs were removed since they played.
    while (this.history.length && !this.find(this.history[this.history.length - 1]!)) this.history.pop();
    if (!this.history.length) throw new QueueError('There is no earlier song to go back to.', 409);
    // The song now playing is dropped, not pushed back: Previous steps backwards once.
    this.current = this.history.pop()!;
    this.touch();
  }

  setDiscovering(value: boolean, note = ''): void {
    this.discovering = value;
    this.discoverNote = note;
    this.touch();
  }
}
