/**
 * SEAMLESS-NEXT-001: inside the installed shells, automatic playback only ever moves to a song the
 * app already holds as a finished local file.
 *
 * The owner's report: playback stopped or spun on songs that were still being prepared, or that no
 * source ever answered for. A queue entry is not a playable song; only a verified local file is.
 * These cases drive the real selection used by the player's Next, the shuffle and the Up Next rail.
 */
import { describe, expect, it } from 'vitest';
import type { RecItem, Track } from './api';
import { dropExpired, expiredKeysOf, readyFilter, resetShuffleNextForTests, stepQueue } from './util';

/**
 * A row the list can start. In a test environment there is no native downloader, so the row needs a
 * preview for `canPlayHere` to be true at all — without it every case would pass for the wrong
 * reason (an empty list), which is exactly how the first run of these cases went green.
 */
const item = (key: string): RecItem => ({ rank: 1, track: { key, title: key, artist: 'A' }, playback: { open: [], preview: `/api/preview/deezer/${key}`, embed: null } }) as unknown as RecItem;
const list = (...keys: string[]) => keys.map(item);
const ready = (...keys: string[]) => {
  const set = new Set(keys);
  return (t: Track) => set.has(t.key);
};
const opts = (o: Partial<Parameters<typeof stepQueue>[4]> = {}) => ({ shuffle: false, repeat: 'off' as const, heard: new Set<string>(), ...o });

describe('automatic next, in order', () => {
  it('skips songs that are not local yet and plays the next one that is', () => {
    const step = stepQueue(list('a', 'b', 'c', 'd'), 'a', 1, new Set(), opts({ ready: ready('a', 'd') }));
    expect(step?.item.track.key).toBe('d');
  });

  it('keeps the song now playing as the place in the list even when it is not local', () => {
    // The anchor is where the listener is; it must not send traversal back to the top of the list.
    const step = stepQueue(list('a', 'b', 'c', 'd'), 'c', 1, new Set(), opts({ ready: ready('a', 'd') }));
    expect(step?.item.track.key).toBe('d');
  });

  it('has no next song when nothing further is local, instead of offering one that is not', () => {
    expect(stepQueue(list('a', 'b', 'c'), 'a', 1, new Set(), opts({ ready: ready('a') }))).toBeNull();
  });

  it('wraps on repeat all only to a song that is local', () => {
    const step = stepQueue(list('a', 'b', 'c'), 'c', 1, new Set(), opts({ repeat: 'all', ready: ready('b', 'c') }));
    expect(step).toEqual({ item: expect.objectContaining({ track: expect.objectContaining({ key: 'b' }) }), wrapped: true });
  });

  it('steps back to the previous local song', () => {
    const step = stepQueue(list('a', 'b', 'c'), 'c', -1, new Set(), opts({ ready: ready('a', 'c') }));
    expect(step?.item.track.key).toBe('a');
  });
});

describe('shuffle', () => {
  it('only ever picks a song that is already local', () => {
    resetShuffleNextForTests();
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) {
      resetShuffleNextForTests();
      const step = stepQueue(list('a', 'b', 'c', 'd', 'e'), 'a', 1, new Set(), opts({ shuffle: true, ready: ready('a', 'c', 'e'), rand: () => i / 40 }));
      if (step) picks.add(step.item.track.key);
    }
    expect([...picks].sort()).toEqual(['c', 'e']);
  });

  it('plays every local song once before any repeats, and a new round needs repeat all', () => {
    resetShuffleNextForTests();
    const songs = list('a', 'b', 'c', 'd');
    const heard = new Set(['a', 'c']);
    const step = stepQueue(songs, 'a', 1, new Set(), opts({ shuffle: true, heard, ready: ready('a', 'c', 'd'), rand: () => 0 }));
    expect(step?.item.track.key).toBe('d');
    heard.add('d');
    expect(stepQueue(songs, 'd', 1, new Set(), opts({ shuffle: true, heard, ready: ready('a', 'c', 'd'), rand: () => 0 }))).toBeNull();
    const round = stepQueue(songs, 'd', 1, new Set(), opts({ shuffle: true, repeat: 'all', heard, ready: ready('a', 'c', 'd'), rand: () => 0 }));
    expect(round?.wrapped).toBe(true);
    expect(['a', 'c']).toContain(round?.item.track.key);
  });

  it('answers with nothing at all when no other song is local', () => {
    resetShuffleNextForTests();
    expect(stepQueue(list('a', 'b', 'c'), 'a', 1, new Set(), opts({ shuffle: true, ready: ready('a'), rand: () => 0 }))).toBeNull();
  });
});

describe('readiness is only a native-shell question', () => {
  const probe = { isReady: (t: Track) => t.key === 'a', expiredKeys: () => new Set(['gone']) };

  it('filters by the preloader in an installed shell', () => {
    const f = readyFilter(probe, true);
    expect(f).toBeTypeOf('function');
    expect(f!({ key: 'a' } as Track)).toBe(true);
    expect(f!({ key: 'b' } as Track)).toBe(false);
  });

  it('does not filter in a plain browser, where there are no local files at all', () => {
    expect(readyFilter(probe, false)).toBeUndefined();
  });

  it('does not filter against a preloader that cannot answer yet', () => {
    expect(readyFilter({}, true)).toBeUndefined();
    expect(readyFilter(null, true)).toBeUndefined();
  });

  it('reads the expired keys, and treats a silent preloader as nothing expired', () => {
    expect([...expiredKeysOf(probe)]).toEqual(['gone']);
    expect(expiredKeysOf({}).size).toBe(0);
    expect(expiredKeysOf(null).size).toBe(0);
  });
});

describe('songs no source ever answered for leave the discovery list quietly', () => {
  it('drops the expired rows, so the list, its count and the prefetch never mention them', () => {
    const rows = dropExpired(list('a', 'gone', 'b'), new Set(['gone']));
    expect(rows.map((x) => x.track.key)).toEqual(['a', 'b']);
  });

  it('keeps every row when nothing has expired', () => {
    const rows = list('a', 'b');
    expect(dropExpired(rows, new Set())).toBe(rows);
  });
});
