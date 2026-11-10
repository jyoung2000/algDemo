/**
 * LIST-SAVE-FOLDER-001: the run behind "Download to folder", against a fake preloader and shell.
 */
import { expect, it, vi } from 'vitest';
import type { Track } from '../api';
import { FolderSaves, albumFolderName, type SaveDeps } from './list-save';

const t = (k: string, title: string): Track => ({ key: k, title, artists: ['Ken Carson'], artist: 'Ken Carson' }) as unknown as Track;
const tracks = [t('a', 'Green Room'), t('b', 'Jennifer\u2019s Body'), t('c', 'Singapore')];
const url = (k: string) => `https://music.youtube.com/watch?v=${k.repeat(11)}`;

function world() {
  const ready = new Map<string, string>();
  const failed = new Set<string>();
  let listener: (() => void) | null = null;
  const held = new Set<string>();
  const store = new Map<string, string>();
  const deps: SaveDeps = {
    downloadAll: vi.fn(),
    readyUrl: (x) => ready.get(x.key) ?? null,
    snapshot: (xs) => ({ total: xs.length, ready: xs.filter((x) => ready.has(x.key)).length, failed: xs.filter((x) => failed.has(x.key)).length, active: xs.length - ready.size - failed.size, retrying: 0, blocked: false, queued: 0, parallel: 2, bulkActive: true }),
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    save: vi.fn(async (_kind, _name, songs) => { for (const s of songs) held.add(s.url); return { held: held.size, total: 3, folder: 'Music \u203a Airwave Discovery \u203a Albums \u203a Ken Carson - A Great Chaos' }; }),
    open: vi.fn(async () => ({ ok: true, folder: 'x' })),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
  };
  const tick = async () => { listener?.(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
  return { ready, failed, deps, tick, store, listening: () => listener !== null };
}

it('asks for every song, and puts each in the folder as it finishes, numbered by its place', async () => {
  const w = world();
  const saves = new FolderSaves(w.deps);
  const name = albumFolderName('A Great Chaos', 'Ken Carson');
  expect(name).toBe('Ken Carson - A Great Chaos');
  saves.start('album', name, tracks);
  expect(w.deps.downloadAll).toHaveBeenCalledWith(tracks);
  expect(saves.state('album', name, 3)).toMatchObject({ phase: 'running', held: 0, total: 3 });
  w.ready.set('c', url('c'));
  await w.tick();
  expect(w.deps.save).toHaveBeenLastCalledWith('album', name, [{ url: url('c'), title: 'Singapore', artist: 'Ken Carson', n: 3 }], 3);
  expect(saves.state('album', name, 3)).toMatchObject({ phase: 'running', held: 1 });
  // Nothing new: the shell is not asked again.
  await w.tick();
  expect(w.deps.save).toHaveBeenCalledTimes(1);
  w.ready.set('a', url('a'));
  w.ready.set('b', url('b'));
  await w.tick();
  expect(saves.state('album', name, 3)).toMatchObject({ phase: 'done', held: 3, missing: 0, folder: expect.stringContaining('Albums') });
  expect(w.listening()).toBe(false);
  // Remembered: a new app session knows the album is in its folder.
  const later = new FolderSaves(w.deps);
  expect(later.state('album', name, 3)).toMatchObject({ phase: 'done', held: 3 });
  expect(later.state('album', name, 4)).toMatchObject({ phase: 'idle', held: 3 });
});

it('finishes with the songs it could get, and says how many were missing', async () => {
  const w = world();
  const saves = new FolderSaves(w.deps);
  saves.start('list', 'Late night', tracks);
  w.ready.set('a', url('a'));
  w.failed.add('b');
  w.failed.add('c');
  await w.tick();
  expect(saves.state('list', 'Late night', 3)).toMatchObject({ phase: 'done', held: 1, missing: 2 });
});

it('does not end before the downloads have started', async () => {
  const w = world();
  const saves = new FolderSaves(w.deps);
  saves.start('list', 'Late night', tracks);
  await w.tick();
  expect(saves.state('list', 'Late night', 3).phase).toBe('running');
});

it('keeps going when the folder cannot be written, and shows why', async () => {
  const w = world();
  (w.deps.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Disk full'));
  const saves = new FolderSaves(w.deps);
  saves.start('list', 'Late night', tracks);
  w.ready.set('a', url('a'));
  await w.tick();
  expect(saves.state('list', 'Late night', 3)).toMatchObject({ phase: 'running', error: 'Disk full' });
  await w.tick();
  expect(saves.state('list', 'Late night', 3)).toMatchObject({ held: 1, error: null });
});

it('puts in a song that finished while the folder was still being written', async () => {
  const w = world();
  let release: () => void = () => {};
  const real = w.deps.save;
  (w.deps as { save: SaveDeps['save'] }).save = vi.fn((...a: Parameters<SaveDeps['save']>) => new Promise<Awaited<ReturnType<SaveDeps['save']>>>((ok) => { release = () => void real(...a).then(ok); }));
  const saves = new FolderSaves(w.deps);
  saves.start('list', 'Late night', tracks);
  w.ready.set('a', url('a'));
  await w.tick();
  // A second song lands while the first write is still going; its notice arrives during the write.
  w.ready.set('b', url('b'));
  await w.tick();
  release();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  release();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(w.deps.save).toHaveBeenCalledTimes(2);
  expect(saves.state('list', 'Late night', 3).held).toBe(2);
});
