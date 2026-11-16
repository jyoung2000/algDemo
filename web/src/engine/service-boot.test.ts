import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../api';
import { pickCarContext, pushMediaTracks, resetRememberedTracksForTest } from './media-native';
import { SwitchingQueue } from './queue-audio';
import type { QueueAudioPort } from './queue-remote';
import { ChainedContexts, LibraryContexts, parseLibrary } from './service-actor';
import { nativeApiBridge, onSwitchToLocal, resetServiceClientForTest, serviceClient, switchToLocal } from './service-client';

const track = (key: string): Track => ({ key, title: `T ${key}`, artist: 'A', provider: 'deezer', platform_id: key } as unknown as Track);

type W = { AirwaveNative?: Record<string, unknown>; __awApi?: unknown };
const w: W = {};

beforeEach(() => {
  vi.stubGlobal('window', w);
  resetServiceClientForTest();
});

afterEach(() => {
  delete w.AirwaveNative;
  delete w.__awApi;
  vi.unstubAllGlobals();
  resetServiceClientForTest();
  resetRememberedTracksForTest();
});

describe('UI engine choice (SERVICE-API-001, EngineOwner)', () => {
  it('stays the service client unless native says local AND the local claim succeeds', () => {
    const api = vi.fn();
    expect(nativeApiBridge({ AirwaveNative: { api, apiMode: () => 'service', claimLocal: () => true } })).not.toBeNull();
    // Local allowed but the claim lost (the service claimed meanwhile): still the client, never a second writer.
    expect(nativeApiBridge({ AirwaveNative: { api, apiMode: () => 'local', claimLocal: () => false } })).not.toBeNull();
    expect(nativeApiBridge({ AirwaveNative: { api, apiMode: () => 'local' } })).not.toBeNull();
    expect(nativeApiBridge({ AirwaveNative: { api, apiMode: () => { throw new Error('x'); } } })).not.toBeNull();
    expect(nativeApiBridge({ AirwaveNative: { api, apiMode: () => 'local', claimLocal: () => true } })).toBeNull();
  });

  it('switches to its own engine once, only after claiming, and tells the queue', () => {
    let claim = false;
    w.AirwaveNative = { api: vi.fn(), apiMode: () => 'service', claimLocal: () => claim };
    expect(serviceClient()).not.toBeNull();
    const told = vi.fn();
    onSwitchToLocal(told);
    expect(switchToLocal()).toBe(false);
    expect(serviceClient()).not.toBeNull();
    claim = true;
    expect(switchToLocal()).toBe(true);
    expect(serviceClient()).toBeNull();
    expect(switchToLocal()).toBe(true);
    expect(told).toHaveBeenCalledTimes(1);
  });
});

describe('SwitchingQueue', () => {
  const port = (ready: string | null): QueueAudioPort & { fire: () => void; disposed: boolean } => {
    const ls = new Set<() => void>();
    const p = {
      disposed: false,
      fire: () => ls.forEach(f => f()),
      subscribe: (f: () => void) => { ls.add(f); return () => { ls.delete(f); }; },
      sourceHint: () => null, readyUrl: () => ready, isReady: () => ready !== null, expiredKeys: () => new Set<string>(),
      snapshot: () => ({ total: 0, ready: 0, active: 0, failed: 0, blocked: false, queued: 0, parallel: 0, bulkActive: false, retrying: 0 }),
      snapshotFor: () => ({ total: 0, ready: 0, active: 0, failed: 0, blocked: false, queued: 0, parallel: 0, bulkActive: false, retrying: 0 }),
      downloadAll: vi.fn(), update: vi.fn(), protect: vi.fn(async () => undefined), limits: vi.fn(async () => undefined),
      cardOf: vi.fn(), retryFailed: vi.fn(), dispose: () => { p.disposed = true; },
    };
    return p as unknown as QueueAudioPort & { fire: () => void; disposed: boolean };
  };

  it('carries listeners over to the local loader and disposes the remote view', () => {
    const remote = port(null), local = port('https://x/a');
    const q = new SwitchingQueue(remote);
    const heard = vi.fn();
    q.subscribe(heard);
    remote.fire();
    expect(heard).toHaveBeenCalledTimes(1);
    q.switchTo(local);
    expect(remote.disposed).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2); // told about the switch
    remote.fire();
    expect(heard).toHaveBeenCalledTimes(2); // the old view is silent
    local.fire();
    expect(heard).toHaveBeenCalledTimes(3);
    expect(q.readyUrl(track('a'))).toBe('https://x/a');
    q.update([track('a')]);
    expect(local.update).toHaveBeenCalled();
    expect(remote.update).not.toHaveBeenCalled();
  });
});

describe('library contexts from AirwaveNative.library()', () => {
  const lib = JSON.stringify({
    library: {
      songs: [{ id: 'q1' }, { id: 'q2' }, { id: 'nope' }],
      playlists: [{ id: 'road trip', songs: [{ id: 'p1' }, { id: 'unknown' }, { id: 'p/2' }] }, { id: 7 }],
    },
    tracks: [track('q1'), track('q2'), track('p1'), track('p/2'), { title: 'no key' }],
  });

  it('builds the saved lists from original Tracks only, never from titles', () => {
    const snap = parseLibrary(lib);
    expect(snap.playlists.map(p => p.id)).toEqual(['road trip']);
    expect(snap.tracks.map(t => t.key)).toEqual(['q1', 'q2', 'p1', 'p/2']);
    const c = new LibraryContexts(snap);
    const tapped = `playlist/${encodeURIComponent('road trip')}/track/${encodeURIComponent('p/2')}`;
    const ctx = c.contextOf(tapped)!;
    expect(ctx.tracks.map(t => t.key)).toEqual(['p1', 'p/2']); // 'unknown' has no original Track: left out
    expect(ctx.ids[ctx.index]).toBe(tapped);
    expect(ctx.ids[0]).toBe('playlist/road%20trip/track/p1');
    expect(c.contextOf('q2')).toMatchObject({ ids: ['q1', 'q2'], index: 1 });
    expect(c.contextOf('nope')).toBeNull();
    expect(c.contextOf('playlist/other/track/p1')).toBeNull();
    expect(c.contextOf('calbum/x/track/q1')).toBeNull();
  });

  it('is empty, not broken, for a missing or corrupt library', () => {
    expect(parseLibrary('{nope')).toEqual({ songs: [], playlists: [], tracks: [] });
    expect(parseLibrary(null)).toEqual({ songs: [], playlists: [], tracks: [] });
    expect(new LibraryContexts(parseLibrary(JSON.stringify({ library: null, tracks: [] }))).contextOf('q1')).toBeNull();
  });

  it('lets car-found songs answer first', () => {
    const car = { contextOf: (id: string) => (id === 'q1' ? { tracks: [track('q1')], ids: ['q1'], index: 0 } : null) };
    const chain = new ChainedContexts([car, new LibraryContexts(parseLibrary(lib))]);
    expect(chain.contextOf('q1')!.tracks).toHaveLength(1);
    expect(chain.contextOf('q2')!.tracks).toHaveLength(2);
    expect(chain.contextOf('zz')).toBeNull();
  });
});

describe('pickCarContext (App.playById fallback)', () => {
  const ctx = { tracks: [track('a'), track('b'), track('c')], ids: ['a', 'b', 'c'], index: 1 };

  it('plays the exact song with its whole list', () => {
    expect(pickCarContext(ctx, 'b')).toEqual({ track: ctx.tracks[1], tracks: ctx.tracks });
    const album = { tracks: [track('x'), track('y')], ids: ['calbum/al/track/x', 'calbum/al/track/y'], index: 1 };
    expect(pickCarContext(album, 'calbum/al/track/y')!.track.key).toBe('y');
  });

  it('plays nothing for a stale, mismatched or malformed answer', () => {
    expect(pickCarContext(ctx, 'a')).toBeNull();
    expect(pickCarContext({ ...ctx, index: 3 }, 'b')).toBeNull();
    expect(pickCarContext({ ...ctx, ids: ['a', 'b'] }, 'b')).toBeNull();
    expect(pickCarContext({ ...ctx, tracks: [track('a'), { title: 'x' }, track('c')] }, 'b')).toBeNull();
    expect(pickCarContext(null, 'b')).toBeNull();
    expect(pickCarContext(ctx, 'other/b')).toBeNull();
  });
});

describe('pushMediaTracks', () => {
  it('sends new or changed original Tracks in bounded chunks, once', () => {
    const media = vi.fn();
    w.AirwaveNative = { media };
    const many = Array.from({ length: 250 }, (_, i) => track(`k${i}`));
    pushMediaTracks(many);
    expect(media).toHaveBeenCalledTimes(3);
    expect(JSON.parse(media.mock.calls[0]![0] as string).rememberTracks).toHaveLength(100);
    media.mockClear();
    pushMediaTracks(many);
    expect(media).not.toHaveBeenCalled();
    pushMediaTracks([{ ...track('k1'), title: 'Renamed' } as Track, { key: 'big', title: 'x'.repeat(20_000) } as unknown as Track]);
    expect(media).toHaveBeenCalledTimes(1);
    expect(JSON.parse(media.mock.calls[0]![0] as string).rememberTracks.map((t: Track) => t.key)).toEqual(['k1']);
  });
});
