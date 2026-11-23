/**
 * CAR-SAVE-HIDDEN-001 (owner, 2026-11-23): "on android auto hearting a song doesnt bring up the playlist sub menu
 * like desired" and "the playlist dont load or save the music".
 *
 * Measured on the emulator with Android Auto's head unit: with jPlay's screen not in front (the phone in a pocket,
 * which is how it is in a car) the phone page is frozen — no timer and no task runs in it. The car's star and its
 * playlist choice were handed to that frozen page, so nothing was saved until the app was next opened, and nothing
 * at all if Android closed it first. The engine that keeps running belongs to the playback service; these are the
 * saves it now does itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { carFeedback, carPlaylistAdd, type CarSaveDeps } from './car-saves';
import { CAR_NEW_LIST, CAR_NEW_LIST_NAME } from './media-native';
import type { PlaylistSummary, Track } from '../api';

const track = (key: string): Track => ({ key, title: `Song ${key}`, artists: ['Artist'] }) as unknown as Track;
const list = (id: string, name: string, keys: string[] = [], album = false): PlaylistSummary =>
  ({ id, name, created: 1, count: keys.length, unplayed: 0, discovery_ready: false, items: keys.map((key) => ({ key, track: track(key), played: false })), ...(album ? { album: { id: 'a' } } : {}) }) as unknown as PlaylistSummary;

function deps(known: Track[], lists: PlaylistSummary[]): CarSaveDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    findTrack: async (id) => known.find((t) => t.key === id) ?? null,
    feedback: vi.fn(async (kind, t, extra) => { calls.push(`feedback:${kind}:${t.key}:${extra.event_id}`); }),
    playlists: vi.fn(async () => ({ lists })),
    playlistEdit: vi.fn(async (action, body) => { calls.push(`${action}:${body.ids?.join(',') ?? body.name}:${body.key}:${body.tracks?.[0]?.key}`); return { lists }; }),
    eventId: (kind, key) => `${kind}-${key}-1`,
  };
}

describe('the service engine saves a star the car sends', () => {
  it('records the like against the song it knows', async () => {
    const d = deps([track('a')], []);
    expect(await carFeedback('a', 'like', undefined, d)).toBe(true);
    expect(d.calls).toEqual(['feedback:like:a:like-a-1']);
  });

  it('records a dislike, an unlike and an undislike the same way', async () => {
    const d = deps([track('a')], []);
    for (const kind of ['dislike', 'unlike', 'undislike'] as const) expect(await carFeedback('a', kind, undefined, d)).toBe(true);
    expect(d.calls).toEqual(['feedback:dislike:a:dislike-a-1', 'feedback:unlike:a:unlike-a-1', 'feedback:undislike:a:undislike-a-1']);
  });

  it('uses the song the car sent along when the engine does not know it (a song heard on the radio)', async () => {
    const d = deps([], []);
    expect(await carFeedback('r', 'like', track('r'), d)).toBe(true);
    expect(d.calls).toEqual(['feedback:like:r:like-r-1']);
  });

  it('saves nothing, and says so, for a song nobody can name', async () => {
    const d = deps([], []);
    expect(await carFeedback('ghost', 'like', undefined, d)).toBe(false);
    expect(d.calls).toEqual([]);
  });
});

describe('the service engine saves a playlist choice the car sends', () => {
  it('saves the song and adds it to the playlist the driver picked', async () => {
    const d = deps([track('a')], [list('p1', 'Road trip'), list('p2', 'Gym')]);
    expect(await carPlaylistAdd('a', 'p2', undefined, d)).toEqual({ saved: true, list: 'Gym' });
    expect(d.calls).toEqual(['feedback:save:a:save-a-1', 'add:p2:a:a']);
  });

  it('starts "Car picks" when the driver has no playlist, and uses it again the next time', async () => {
    const none = deps([track('a')], []);
    expect(await carPlaylistAdd('a', CAR_NEW_LIST, undefined, none)).toEqual({ saved: true, list: CAR_NEW_LIST_NAME });
    expect(none.calls).toEqual(['feedback:save:a:save-a-1', `create:${CAR_NEW_LIST_NAME}:a:a`]);

    const again = deps([track('b')], [list('cp', CAR_NEW_LIST_NAME, ['a'])]);
    expect(await carPlaylistAdd('b', CAR_NEW_LIST, undefined, again)).toEqual({ saved: true, list: CAR_NEW_LIST_NAME });
    expect(again.calls).toEqual(['feedback:save:b:save-b-1', 'add:cp:b:b']);
  });

  it('never adds a song to a saved album, even when the car names one', async () => {
    const d = deps([track('a')], [list('alb', 'An album', [], true)]);
    expect(await carPlaylistAdd('a', 'alb', undefined, d)).toEqual({ saved: false });
    expect(d.calls).toEqual([]);
  });

  it('saves nothing for a playlist that no longer exists or a song nobody can name', async () => {
    const d = deps([track('a')], [list('p1', 'Road trip')]);
    expect(await carPlaylistAdd('a', 'gone', undefined, d)).toEqual({ saved: false });
    expect(await carPlaylistAdd('ghost', 'p1', undefined, d)).toEqual({ saved: false });
    expect(d.calls).toEqual([]);
  });

  it('uses the song the car sent along for a radio song', async () => {
    const d = deps([], [list('p1', 'Road trip')]);
    expect(await carPlaylistAdd('r', 'p1', track('r'), d)).toEqual({ saved: true, list: 'Road trip' });
    expect(d.calls).toEqual(['feedback:save:r:save-r-1', 'add:p1:r:r']);
  });
});

describe('a save this engine cannot make is handed back, never dropped', () => {
  it('hands back a star for a song it cannot name, to be kept for the phone app', async () => {
    const d = deps([], []);
    const back: unknown[] = [];
    expect(await carFeedback('ghost', 'like', undefined, { ...d, unsaved: (c) => back.push(c) })).toBe(false);
    expect(back).toEqual([{ type: 'feedback', id: 'ghost', kind: 'like' }]);
  });

  it('hands back a playlist choice for a song it cannot name', async () => {
    const d = deps([], [list('p1', 'Road trip')]);
    const back: unknown[] = [];
    expect(await carPlaylistAdd('ghost', 'p1', undefined, { ...d, unsaved: (c) => back.push(c) })).toEqual({ saved: false });
    expect(back).toEqual([{ type: 'playlistAdd', id: 'ghost', list: 'p1' }]);
  });

  it('hands back a save the engine failed to write, with the song', async () => {
    const d = deps([track('a')], [list('p1', 'Road trip')]);
    const back: unknown[] = [];
    const failing = { ...d, feedback: async () => { throw new Error('disk full'); }, unsaved: (c: unknown) => back.push(c) };
    expect(await carFeedback('a', 'like', undefined, failing)).toBe(false);
    expect(await carPlaylistAdd('a', 'p1', undefined, failing)).toEqual({ saved: false });
    expect(back).toEqual([{ type: 'feedback', id: 'a', kind: 'like', track: track('a') }, { type: 'playlistAdd', id: 'a', list: 'p1', track: track('a') }]);
  });

  it('does not hand back a choice for a playlist that is gone: the phone app has no such playlist either', async () => {
    const d = deps([track('a')], []);
    const back: unknown[] = [];
    expect(await carPlaylistAdd('a', 'gone', undefined, { ...d, unsaved: (c) => back.push(c) })).toEqual({ saved: false });
    expect(back).toEqual([]);
  });
});
