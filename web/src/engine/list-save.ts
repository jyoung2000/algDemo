/**
 * LIST-SAVE-FOLDER-001. Owner: "add an option to quick download entire saved playlist / album and
 * download into seperated folder for just those tracks". One press asks for every song of a saved list
 * or album; as each finishes it is put in that list's own folder (the shell numbers it by its place in
 * the list), so the folder fills while the rest download and nothing depends on the evictable cache.
 * The run ends when every song is in, or every song still missing has been given up on; the count and
 * the folder are remembered so the button still knows after a restart.
 */
import type { Track } from '../api';
import type { QueueCacheStatus } from './queue-preload';

export type SaveKind = 'album' | 'list';
export interface SaveSong { url: string; title: string; artist: string; n: number }
export interface SaveDeps {
  downloadAll(tracks: readonly Track[]): void;
  readyUrl(t: Track): string | null;
  snapshot(tracks: readonly Track[]): QueueCacheStatus;
  subscribe(fn: () => void): () => void;
  save(kind: SaveKind, name: string, songs: SaveSong[], total: number): Promise<{ held: number; total: number; folder: string }>;
  open(kind: SaveKind, name: string): Promise<{ ok: boolean; folder: string }>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined;
}
export interface SaveState {
  phase: 'idle' | 'running' | 'done';
  held: number;
  total: number;
  folder: string | null;
  /** Songs the run gave up on (no full version found, or the downloader failed). */
  missing: number;
  error: string | null;
}

const STORE = 'airwave.folder-saves.v1';
const idOf = (kind: SaveKind, name: string) => `${kind}:${name}`;

interface Run {
  kind: SaveKind;
  name: string;
  tracks: readonly Track[];
  sent: Set<string>;
  busy: boolean;
  again: boolean;
  state: SaveState;
  stop: () => void;
}

export class FolderSaves {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<() => void>();
  private remembered: Record<string, { held: number; total: number; folder: string }>;

  constructor(private readonly deps: SaveDeps) {
    try { this.remembered = JSON.parse(deps.storage?.getItem(STORE) ?? '{}') ?? {}; } catch { this.remembered = {}; }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** What the button shows for this list: a run in progress, or what is already in its folder. */
  state(kind: SaveKind, name: string, total: number): SaveState {
    const run = this.runs.get(idOf(kind, name));
    if (run) return run.state;
    const r = this.remembered[idOf(kind, name)];
    return { phase: r && r.held >= total && total > 0 ? 'done' : 'idle', held: r?.held ?? 0, total, folder: r?.folder ?? null, missing: 0, error: null };
  }

  start(kind: SaveKind, name: string, tracks: readonly Track[]): void {
    const id = idOf(kind, name);
    if (this.runs.get(id)?.state.phase === 'running' || !tracks.length) return;
    this.runs.get(id)?.stop();
    const before = this.remembered[id];
    const run: Run = {
      kind, name, tracks, sent: new Set(), busy: false, again: false, stop: () => {},
      state: { phase: 'running', held: before?.held ?? 0, total: tracks.length, folder: before?.folder ?? null, missing: 0, error: null },
    };
    this.runs.set(id, run);
    run.stop = this.deps.subscribe(() => void this.step(run));
    this.deps.downloadAll(tracks);
    this.emit();
    void this.step(run);
  }

  async open(kind: SaveKind, name: string): Promise<{ ok: boolean; folder: string }> {
    return this.deps.open(kind, name);
  }

  private async step(run: Run): Promise<void> {
    if (run.state.phase !== 'running') return;
    if (run.busy) { run.again = true; return; }
    const songs = run.tracks.flatMap((t, i) => {
      const url = this.deps.readyUrl(t);
      return url ? [{ url, title: t.title, artist: t.artists?.[0] ?? t.artist ?? '', n: i + 1 }] : [];
    });
    const fresh = songs.some((s) => !run.sent.has(s.url));
    if (fresh) {
      run.busy = true;
      try {
        const r = await this.deps.save(run.kind, run.name, songs, run.tracks.length);
        for (const s of songs) run.sent.add(s.url);
        run.state = { ...run.state, held: r.held, folder: r.folder, error: null };
        this.remember(run);
      } catch (e) {
        run.state = { ...run.state, error: e instanceof Error ? e.message : 'The folder could not be written.' };
      } finally {
        run.busy = false;
      }
      this.emit();
      if (run.again) { run.again = false; return this.step(run); }
    }
    // Over when every song is in the folder, or every song not in it has been given up on.
    const snap = this.deps.snapshot(run.tracks);
    const settled = snap.ready + snap.failed >= snap.total && snap.retrying === 0 && snap.active === 0;
    if (run.state.held >= run.tracks.length || (settled && run.sent.size >= snap.ready) || snap.blocked) {
      run.stop();
      run.state = { ...run.state, phase: 'done', missing: Math.max(0, run.tracks.length - run.state.held) };
      this.emit();
    }
  }

  private remember(run: Run): void {
    if (!run.state.folder) return;
    this.remembered[idOf(run.kind, run.name)] = { held: run.state.held, total: run.tracks.length, folder: run.state.folder };
    try { this.deps.storage?.setItem(STORE, JSON.stringify(this.remembered)); } catch { /* storage full: the run still works */ }
  }

  private emit(): void { for (const f of this.listeners) f(); }
}

/** An album's folder is named "artist - album", so two albums with one title never share a folder. */
export const albumFolderName = (title: string, artist: string): string => (artist ? `${artist} - ${title}` : title);
