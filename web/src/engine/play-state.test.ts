// PLAY-LIVE-001 / ALBUM-PLAY-STATE-001 (owner, 2026-11-21).
import { describe, expect, it } from 'vitest';
import type { CardCache } from './queue-controls';
import { listPlayState, songRing, withJob } from './play-state';

const card = (state: CardCache['state'], progress = 0, indeterminate = false): CardCache => ({ state, glyph: '', text: '', keptText: null, kept: false, progress, indeterminate });

describe('a song’s Play button follows its download (PLAY-LIVE-001)', () => {
  it('turns ready the moment the Download button’s job finishes, with nothing else asked', () => {
    expect(withJob(null, { state: 'done', percent: 100 })?.state).toBe('ready');
    expect(withJob(card('queued'), { state: 'done', percent: 100 })?.state).toBe('ready');
  });
  it('shows a running job’s real percent, or the cache’s when that is further along', () => {
    expect(withJob(null, { state: 'running', percent: 42.4 })).toMatchObject({ state: 'downloading', progress: 42, indeterminate: false });
    expect(withJob(card('downloading', 70), { state: 'running', percent: 10 })?.progress).toBe(70);
    expect(withJob(null, { state: 'queued', percent: null })).toMatchObject({ state: 'downloading', progress: 0, indeterminate: true });
  });
  it('keeps the cache’s word when there is no job, a failed job, or the song is already ready', () => {
    expect(withJob(card('queued'), null)?.state).toBe('queued');
    expect(withJob(card('failed'), { state: 'failed', percent: null })?.state).toBe('failed');
    expect(withJob(card('ready'), { state: 'running', percent: 5 })?.state).toBe('ready');
  });

  // ROW-DL-KEPT-001 (owner, 2026-11-22): the Download icon goes only once the listener's own download has saved the
  // song for good; a song cached for playback is not that.
  it('marks a song kept only when the listener\u2019s own download finished, and says while it is running', () => {
    expect(withJob(card('ready'), null)).toMatchObject({ state: 'ready', kept: false });
    expect(withJob(card('ready'), { state: 'done', percent: 100 })).toMatchObject({ state: 'ready', kept: true, keptText: 'Kept in Music folder' });
    expect(withJob(null, { state: 'done', percent: 100 })).toMatchObject({ state: 'ready', kept: true });
    // Saving a song that is already cached: Play stays blue, the Download icon gets the ring.
    expect(withJob(card('ready'), { state: 'running', percent: 31 })).toMatchObject({ state: 'ready', kept: false, saving: { progress: 31, indeterminate: false } });
    expect(withJob(card('queued'), { state: 'queued', percent: null })).toMatchObject({ state: 'downloading', saving: { progress: 0, indeterminate: true } });
    // A song the queue is caching by itself is not being saved by anyone.
    expect(withJob(card('downloading', 40), null)?.saving ?? null).toBeNull();
    expect(withJob(card('queued'), { state: 'failed', percent: null })?.saving ?? null).toBeNull();
  });
  it('draws a ring only around a song still to download, filled to its progress', () => {
    expect(songRing(card('ready'))).toBeNull();
    expect(songRing(card('queued'), true)).toBeNull();
    expect(songRing(card('downloading', 63.6))).toEqual({ progress: 64, moving: false });
    expect(songRing(card('downloading', 0, true))).toEqual({ progress: 0, moving: true });
    expect(songRing(null)).toEqual({ progress: 0, moving: false });
  });
  // RING-CLOSE-001, measured: a job that had started but reported 0% stopped the breathing outline for 325 ms before
  // the first visible arc, which looked like the outline resetting. Nothing to draw yet is still "started".
  it('keeps breathing while a download reports nothing to draw yet, and stops once there is an arc', () => {
    expect(songRing(card('downloading', 0))).toEqual({ progress: 0, moving: true });
    expect(songRing(card('downloading', 0.4))).toEqual({ progress: 0, moving: true });
    expect(songRing(card('downloading', 1))).toEqual({ progress: 1, moving: false });
  });
});

describe('a list’s Play button is blue only when every song is downloaded (ALBUM-PLAY-STATE-001)', () => {
  const states: Record<string, CardCache> = { a: card('ready'), b: card('downloading', 50), c: card('queued') };
  const of = (k: string) => states[k] ?? null;
  it('counts the songs on hand and the share downloaded so far', () => {
    expect(listPlayState(['a', 'b', 'c', 'd'], of)).toMatchObject({ ready: false, done: 1, total: 4, progress: 38 });
    // PLAY-RING-004: a list with a song downloading right now says so; one with nothing moving does not.
    expect(listPlayState(['a', 'b'], of).moving).toBe(true);
    expect(listPlayState(['a', 'c'], of).moving).toBe(false);
  });
  it('is ready when every song is ready or a local file, and never for an empty list', () => {
    expect(listPlayState(['a', 'a'], of)).toMatchObject({ ready: true, done: 1, total: 1, progress: 100, moving: false });
    expect(listPlayState(['a', 'x'], of, (k) => k === 'x').ready).toBe(true);
    expect(listPlayState([], of).ready).toBe(false);
    expect(listPlayState(['a'], null)).toMatchObject({ ready: false, progress: 0 });
  });
});
