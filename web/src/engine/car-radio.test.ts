// @vitest-environment happy-dom
/**
 * CAR-RADIO-CONTROLS-001 (owner, 2026-11-18): on Android Auto the radio works like the song player
 * except Repeat, Find similar and Dislike: shuffle stations, star the song (and add it to a
 * playlist), and see the song's elapsed time and length. The car can only do that if the page tells
 * the native player which song is on air, its Track, and where its clock started.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { broadcastTimeline, carRadioClock, parseBroadcast, radioItemClock, type Broadcast } from './radio';
import { radioNowPlaying } from './radio-client';
import { PHONE_LIST, decodePlaylistMediaId, installMediaCommands, setMediaHandlers } from './media-native';
import type { Track } from '../api';

const station = { id: 'st1', name: 'Test FM', url: 'https://streams.example/st1', image: 'https://img.example/st1.png' } as never;
const song = (over: Partial<Track> = {}): Track =>
  ({ id: 'd1', provider: 'deezer', platform_id: '1', key: 'deezer:1', title: 'Pelicans', artist: 'ALLBLACK', artists: ['ALLBLACK'], duration: 230, artwork: 'https://cdn.example/a.jpg', ...over }) as Track;
const onAir = (over: Partial<Broadcast> = {}): Broadcast => ({ ...parseBroadcast('ALLBLACK - Pelicans', 'Broadcaster'), state: 'current', ...over });

describe('radioItemClock', () => {
  it('uses a start measured from the audio and the identified recording length', () => {
    const c = radioItemClock(onAir(), song(), true, { received: 100, position: 90 }, 1_000_000, 40.25);
    expect(c).toEqual({ start: 40.25, duration: 230 });
  });

  it('turns a published start into the same elapsed time the phone shows', () => {
    const now = 1_000_000_000;
    const b = onAir({ startedAt: now - 75_000, duration: 200 });
    const snap = { received: 50, position: 48, oldest: 0 };
    const c = radioItemClock(b, null, false, snap, now, null);
    expect(c.duration).toBe(200);
    const bufferOffset = (now - b.startedAt!) / 1000 - snap.received;
    const phone = broadcastTimeline(b, null, snap, now, bufferOffset, null);
    expect(snap.position - c.start!).toBeCloseTo(phone.elapsed!, 1);
  });

  it('knows nothing when nothing was published or measured', () => {
    expect(radioItemClock(onAir(), song(), true, { received: 10, position: 9 }, 1_000_000, null)).toEqual({ start: null, duration: 230 });
    expect(radioItemClock(onAir(), song(), false, { received: 10, position: 9 }, 1_000_000, null)).toEqual({ start: null, duration: null });
    expect(radioItemClock(null, null, false, null, 1_000_000, null)).toEqual({ start: null, duration: null });
  });

  it('never uses a catalogue length for a programme', () => {
    const b = onAir({ kind: 'programme' });
    expect(radioItemClock(b, song(), true, { received: 10, position: 9 }, 1_000_000, 2).duration).toBeNull();
  });
});

describe('radioNowPlaying', () => {
  it('names the identified song, its Track and its clock for the car', () => {
    const t = song();
    const u = radioNowPlaying('sess', { broadcast: onAir(), track: t, identified: true }, station, { start: 12.5, duration: 230 });
    expect(u).toMatchObject({ op: 'nowplaying', id: 'sess', title: 'Pelicans', artist: 'ALLBLACK', artwork: 'https://cdn.example/a.jpg', start: 12.5, duration: 230 });
    expect(u.song).toMatchObject({ id: 'deezer:1', title: 'Pelicans', artist: 'ALLBLACK', durationMs: 230000, ready: false });
    expect(u.track).toEqual(t);
  });

  it('offers no song to star while a programme or an unmatched title is on air', () => {
    const programme = radioNowPlaying('sess', { broadcast: onAir({ kind: 'programme', title: 'Morning show', artist: null }), track: null, identified: false }, station, { start: null, duration: null });
    expect(programme.song).toBeNull();
    expect(programme.track).toBeNull();
    expect(programme.title).toBe('Morning show');
    const unmatched = radioNowPlaying('sess', { broadcast: onAir(), track: song(), identified: false }, station, { start: null, duration: null });
    expect(unmatched.song).toBeNull();
  });
});

describe('car commands for a radio song', () => {
  afterEach(() => setMediaHandlers({}));
  const cmd = (o: unknown) => (window as unknown as { __awMediaCmd: (s: string) => void }).__awMediaCmd(JSON.stringify(o));

  it('hands the radio Track to feedback and playlistAdd when it names the same song', () => {
    installMediaCommands();
    const feedback = vi.fn(), playlistAdd = vi.fn();
    setMediaHandlers({ feedback, playlistAdd });
    const t = song();
    cmd({ type: 'feedback', id: 'deezer:1', kind: 'like', track: t });
    cmd({ type: 'playlistAdd', id: 'deezer:1', list: 'road', track: t });
    expect(feedback).toHaveBeenCalledWith('deezer:1', 'like', t);
    expect(playlistAdd).toHaveBeenCalledWith('deezer:1', 'road', t);
  });

  it('ignores a Track that names a different song', () => {
    installMediaCommands();
    const feedback = vi.fn();
    setMediaHandlers({ feedback });
    cmd({ type: 'feedback', id: 'deezer:1', kind: 'like', track: song({ key: 'deezer:2' }) });
    expect(feedback.mock.calls).toEqual([['deezer:1', 'like']]);
  });
});

describe('the car "On this phone" list', () => {
  it('is a playlist id the page can read back, matching MediaHub.PHONE_LIST', () => {
    expect(PHONE_LIST).toBe('airwave:on-this-phone');
    const id = `playlist/${encodeURIComponent(PHONE_LIST)}/track/${encodeURIComponent('deezer:1')}`;
    expect(decodePlaylistMediaId(id)).toEqual({ listId: PHONE_LIST, key: 'deezer:1' });
  });
});

/**
 * CAR-RADIO-CLOCK-002 (owner, 2026-11-20): "on android auto ensure the radio station gives the song, artist, and album
 * information along with a player bar with the song elapsed time and duration". On the head unit Power 92 showed
 * "Let Me Love You · 4:17 / 4:17": the feed had named that song for twelve minutes (it keeps the last title through
 * talk and ads; the stream's own title did too), the phone said "this song has ended", and the car clamped a runaway
 * clock to the song's length. The car now follows the phone's rules.
 */
describe('carRadioClock: the car shows the clock the phone shows, or none', () => {
  const now = 1_000_000_000;
  it('a song with a published start inside its length: start, length, not over', () => {
    const b = onAir({ startedAt: now - 60_000 });
    const c = carRadioClock(b, song(), true, { received: 100, position: 98 }, now, null, 40);
    expect(c).toEqual({ start: 40, duration: 230, over: false });
  });
  it('a published start more than a minute past the whole song: over, no clock (the phone says the song has ended)', () => {
    const b = onAir({ startedAt: now - 12 * 60_000 });
    const snap = { received: 50, position: 48, oldest: 0 };
    const pinned = radioItemClock(b, null, false, snap, now).start;
    const c = carRadioClock(b, song(), true, snap, now, null, pinned);
    expect(c).toEqual({ start: null, duration: null, over: true });
    const phone = broadcastTimeline(b, song(), snap, now, (now - b.startedAt!) / 1000 - snap.received, null);
    expect(phone.over).toBe(true);
  });
  it('a start measured from the audio is never "over" and keeps the recording length', () => {
    expect(carRadioClock(onAir({ startedAt: now - 12 * 60_000 }), song(), true, { received: 500, position: 498 }, now, 300, -400))
      .toEqual({ start: 300, duration: 230, over: false });
  });
  it('a known length but no known start: no bar (a clock counting from zero would be invented)', () => {
    expect(carRadioClock(onAir(), song(), true, { received: 10, position: 9 }, now, null, null)).toEqual({ start: null, duration: null, over: false });
  });
  it('a broadcaster length keeps its clock past a catalogue length (the station edit), clamped by the car', () => {
    const b = onAir({ startedAt: now - 10 * 60_000, duration: 200 });
    expect(carRadioClock(b, song(), true, { received: 50, position: 48 }, now, null, -550)).toEqual({ start: -550, duration: 200, over: false });
  });
});

describe('radioNowPlaying once the song is over', () => {
  it('says the car is waiting for the next song, names the last one, and offers no star or clock', () => {
    const u = radioNowPlaying('sess', { broadcast: onAir(), track: song(), identified: true }, station, { start: null, duration: null, over: true });
    expect(u).toMatchObject({ op: 'nowplaying', id: 'sess', title: 'Waiting for the next song', artist: 'Last song: Pelicans – ALLBLACK', artwork: 'https://img.example/st1.png', start: null, duration: null });
    expect(u.song).toBeNull();
    expect(u.track).toBeNull();
  });
});
