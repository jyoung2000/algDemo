// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  carAlbumTrackId,
  decodeCarAlbumId,
  decodePlaylistMediaId,
  installMediaCommands,
  mediaNativeAvailable,
  pushMediaLibrary,
  pushMediaState,
  setMediaHandlers,
  songFromTrack,
} from './media-native';
import type { Track } from '../api';

type Win = Record<string, unknown>;
const win = () => window as unknown as Win;

const track = (over: Partial<Track> = {}): Track =>
  ({ id: 'i', provider: 'deezer', platform_id: 'p', key: 'k1', title: 'Plant Island', artist: 'My Singing Monsters', duration: 219, artwork: 'https://cdn/art.jpg', ...over }) as Track;

describe('car albums (ALBUM-CAR-001)', () => {
  beforeEach(() => { installMediaCommands(); });
  afterEach(() => { delete win().AirwaveNative; });

  it('passes the album request on, and answers with the albums and the song to play', async () => {
    const media = vi.fn();
    win().AirwaveNative = { media };
    const song = songFromTrack(track(), false);
    const ask = vi.fn(async () => ({ songs: [song], albums: [{ id: 'dz:1', title: 'A', artist: 'B', artwork: null, songs: [song] }], play: 'calbum/dz%3A1/track/k1' }));
    setMediaHandlers({ catalogSearch: ask });
    (win().__awMediaCmd as (s: string) => void)(JSON.stringify({ type: 'catalogSearch', requestId: 'r', query: 'a', album: true }));
    await vi.waitFor(() => expect(media).toHaveBeenCalled());
    expect(ask).toHaveBeenCalledWith('a', { album: true });
    expect(JSON.parse(media.mock.calls.at(-1)![0]).search).toEqual({ requestId: 'r', query: 'a', songs: [song], albums: [{ id: 'dz:1', title: 'A', artist: 'B', artwork: null, songs: [song] }], play: 'calbum/dz%3A1/track/k1' });
  });

  it('names an album\u2019s song by the album and the song, and reads that back', () => {
    const id = carAlbumTrackId('dz:1', 'ken carson|green room|');
    expect(id).toBe('calbum/dz%3A1/track/ken%20carson%7Cgreen%20room%7C');
    expect(decodeCarAlbumId(id)).toEqual({ albumId: 'dz:1', key: 'ken carson|green room|' });
    expect(decodeCarAlbumId('playlist/a/track/b')).toBeNull();
    expect(decodeCarAlbumId('calbum/a%2Fb/track/c')).toEqual({ albumId: 'a/b', key: 'c' });
  });

  it('marks saved albums in the library so the car lists them under Albums', () => {
    const media = vi.fn();
    win().AirwaveNative = { media };
    pushMediaLibrary([], [{ id: 'A1', title: 'Lost Files', songs: [], album: true, artist: 'Ken Carson', artwork: 'https://cdn/l.jpg' }]);
    expect(JSON.parse(media.mock.calls.at(-1)![0]).library.playlists[0]).toEqual({ id: 'A1', title: 'Lost Files', songs: [], album: true, artist: 'Ken Carson', artwork: 'https://cdn/l.jpg' });
  });
});

describe('media-native bridge', () => {
  let media: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    media = vi.fn();
    win().AirwaveNative = { media };
    installMediaCommands();
    setMediaHandlers({}); // reset by overwriting known keys below in each test
  });
  afterEach(() => {
    delete win().AirwaveNative;
    delete win().__awMediaCmd;
    vi.restoreAllMocks();
  });

  it('reports available only when the Android media bridge is present', () => {
    expect(mediaNativeAvailable()).toBe(true);
    delete win().AirwaveNative;
    expect(mediaNativeAvailable()).toBe(false);
  });

  it('pushes now-playing state as JSON to the native bridge', () => {
    pushMediaState({ playing: true, hasTrack: true, mediaId: 'k1', title: 'Plant Island', positionMs: 1000, durationMs: 219000 });
    expect(media).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(media.mock.calls[0]![0]);
    expect(sent.state).toMatchObject({ playing: true, hasTrack: true, mediaId: 'k1', title: 'Plant Island', positionMs: 1000, durationMs: 219000 });
    expect(sent.library).toBeUndefined();
  });

  it('merges partial state pushes so Player and App can each own a slice', () => {
    pushMediaState({ playing: false, mediaId: 'k1', title: 'Plant Island' });
    pushMediaState({ positionMs: 5000 }); // Player updates only the playhead
    const sent = JSON.parse(media.mock.calls.at(-1)![0]);
    expect(sent.state).toMatchObject({ mediaId: 'k1', title: 'Plant Island', positionMs: 5000 });
  });

  it('pushes the browsable library (song list + playlists) with the state', () => {
    pushMediaLibrary(
      [songFromTrack(track(), true)],
      [{ id: 'p1', title: 'Chill', songs: [songFromTrack(track({ key: 'k2', title: 'B' }), false)] }],
    );
    const sent = JSON.parse(media.mock.calls.at(-1)![0]);
    expect(sent.library.songs).toHaveLength(1);
    expect(sent.library.songs[0]).toMatchObject({ id: 'k1', title: 'Plant Island', durationMs: 219000, ready: true });
    expect(sent.library.playlists[0]).toMatchObject({ id: 'p1', title: 'Chill' });
    expect(sent.library.playlists[0].songs[0]).toMatchObject({ id: 'k2', ready: false });
  });

  it('maps a Track to a native song, seconds to milliseconds, missing duration to -1', () => {
    expect(songFromTrack(track(), true).durationMs).toBe(219000);
    expect(songFromTrack(track({ duration: undefined }), false).durationMs).toBe(-1);
    expect(songFromTrack(track({ artist: undefined, artists: ['A', 'B'] }), true).artist).toBe('A, B');
  });

  it('names the exact local file only for a ready song, so the native engine never plays a guess', () => {
    const url = 'https://www.youtube.com/watch?v=abc';
    expect(songFromTrack(track(), true, url).source).toBe(url);
    expect(songFromTrack(track(), false, url).source).toBeNull();
    expect(songFromTrack(track(), true).source).toBeNull();
  });

  it('decodes a playlist-scoped car item without confusing it with a discovery song', () => {
    expect(decodePlaylistMediaId('playlist/p1/track/deezer%3A123')).toEqual({ listId: 'p1', key: 'deezer:123' });
    expect(decodePlaylistMediaId('playlist/my%2Fmix/track/a%2Fb')).toEqual({ listId: 'my/mix', key: 'a/b' });
    expect(decodePlaylistMediaId('deezer:123')).toBeNull();
    expect(decodePlaylistMediaId('playlist/p1/track/%ZZ')).toBeNull();
  });

  it('routes native transport commands to the registered handlers', () => {
    const h = {
      play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(),
      seek: vi.fn(), playId: vi.fn(), playIndex: vi.fn(), search: vi.fn(), shuffle: vi.fn(), repeat: vi.fn(),
    };
    setMediaHandlers(h);
    const cmd = (o: unknown) => (win().__awMediaCmd as (json: string) => void)(JSON.stringify(o));
    cmd({ type: 'play' }); cmd({ type: 'pause' }); cmd({ type: 'next' }); cmd({ type: 'prev' });
    cmd({ type: 'seek', positionMs: 4200 });
    cmd({ type: 'playId', id: 'k9' });
    cmd({ type: 'playIndex', index: 3 });
    cmd({ type: 'search', query: 'plant island' });
    cmd({ type: 'shuffle', on: true });
    cmd({ type: 'repeat', mode: 2 });
    expect(h.play).toHaveBeenCalledOnce();
    expect(h.pause).toHaveBeenCalledOnce();
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.prev).toHaveBeenCalledOnce();
    expect(h.seek).toHaveBeenCalledWith(4200);
    expect(h.playId).toHaveBeenCalledWith('k9');
    expect(h.playIndex).toHaveBeenCalledWith(3);
    expect(h.search).toHaveBeenCalledWith('plant island');
    expect(h.shuffle).toHaveBeenCalledWith(true);
    expect(h.repeat).toHaveBeenCalledWith(2);
  });

  it('ignores malformed command JSON without throwing', () => {
    const play = vi.fn();
    setMediaHandlers({ play });
    expect(() => (win().__awMediaCmd as (json: string) => void)('not json')).not.toThrow();
    expect(play).not.toHaveBeenCalled();
  });

  it('does nothing when the native bridge is absent', () => {
    delete win().AirwaveNative;
    expect(() => pushMediaState({ playing: true })).not.toThrow();
    expect(() => pushMediaLibrary([], [])).not.toThrow();
  });
});
