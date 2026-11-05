import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalLibrary, POLL_MS } from './local-audio';
import { QueuePreloader } from './queue-preload';
import type { Track } from '../api';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('revalidates completed files and notifies a list when disk eviction lowers its count', async () => {
  let held = true;
  const start = vi.fn(async () => undefined);
  const library = new LocalLibrary({ local: async () => ({ file: held ? { name: 'song', bytes: 1 } : null, running: false }), start });
  const loader = new QueuePreloader({ library, known: t => t.key, resolve: async t => t.key, configure: async () => undefined });
  const tracks = [{ key: 'one', title: 'One', artist: 'Test' }] as Track[];
  const seen: number[] = [];
  loader.subscribe(() => seen.push(loader.snapshotFor(tracks).ready));
  loader.downloadAll(tracks);
  await vi.advanceTimersByTimeAsync(10);
  expect(loader.snapshotFor(tracks).ready).toBe(1);
  expect(start).not.toHaveBeenCalled();
  held = false;
  await vi.advanceTimersByTimeAsync(POLL_MS + 10);
  expect(loader.snapshotFor(tracks).ready).toBe(0);
  expect(seen.at(-1)).toBe(0);
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(start).not.toHaveBeenCalled();
  loader.dispose();
});

it('bounds and rotates ready-file revalidation without overlapping polling cycles', async () => {
  let slow = false;
  const pending: (() => void)[] = [];
  const checked: string[] = [];
  const library = new LocalLibrary({ local: async url => {
    checked.push(url);
    if (slow) await new Promise<void>(resolve => pending.push(resolve));
    return { file: { name: url, bytes: 1 }, running: false };
  }, start: async () => undefined });
  for (let i = 0; i < 100; i++) await library.refresh(`song:${i}`);
  checked.length = 0;
  const off = library.subscribe(() => undefined);
  slow = true;
  await vi.advanceTimersByTimeAsync(POLL_MS);
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.length).toBeLessThanOrEqual(4);
  await vi.advanceTimersByTimeAsync(POLL_MS * 5);
  expect(checked.length).toBeLessThanOrEqual(4);
  slow = false;
  pending.splice(0).forEach(resolve => resolve());
  await vi.advanceTimersByTimeAsync(POLL_MS * 10);
  // A later batch must reach the end of the library, not keep checking its first files.
  off();
  expect(new Set(checked).size).toBe(100);
  const after = checked.length;
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  expect(checked).toHaveLength(after);
});

it('discovers kept files for an observed list without starting a download', async () => {
  const start = vi.fn(async () => undefined);
  const library = new LocalLibrary({ local: async url => ({ file: url === 'kept' ? { name: 'kept', bytes: 1 } : null, running: false }), start });
  const loader = new QueuePreloader({ library, known: t => t.key, resolve: async t => t.key, configure: async () => undefined });
  const tracks = [{ key: 'kept' }, { key: 'absent' }] as Track[];
  expect(loader.snapshotFor(tracks)).toMatchObject({ total: 2, ready: 0 });
  await vi.advanceTimersByTimeAsync(POLL_MS + 10);
  expect(loader.snapshotFor(tracks)).toMatchObject({ total: 2, ready: 1 });
  expect(start).not.toHaveBeenCalled();
  loader.dispose();
});
