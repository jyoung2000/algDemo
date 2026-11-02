import { describe, expect, it } from 'vitest';
import { trackFromSearchItem } from './spotify-anon';

/**
 * searchDesktop nests the cover under albumOfTrack.coverArt.sources, each entry a url with a width.
 * The anonymous search is the path the Android app and the Windows shell prefer, so a track mapped
 * without artwork leaves every row in the list with a placeholder.
 */
const item = (over: Record<string, unknown> = {}) => ({
  uri: 'spotify:track:1pKYYY0dkg23sQQXi0Q5zN',
  name: 'Around the World',
  artists: { items: [{ profile: { name: 'Daft Punk' } }] },
  duration: { totalMilliseconds: 429_000 },
  albumOfTrack: {
    name: 'Homework',
    coverArt: {
      sources: [
        { url: 'https://i.scdn.co/image/small', width: 64, height: 64 },
        { url: 'https://i.scdn.co/image/big', width: 640, height: 640 },
        { url: 'https://i.scdn.co/image/mid', width: 300, height: 300 },
      ],
    },
  },
  ...over,
});

describe('a Spotify search result keeps its album cover', () => {
  it('takes the widest cover source', () => {
    const t = trackFromSearchItem(item());
    expect(t?.artwork).toBe('https://i.scdn.co/image/big');
  });

  it('keeps the album name', () => {
    expect(trackFromSearchItem(item())?.album).toBe('Homework');
  });

  it('still maps the rest of the track', () => {
    const t = trackFromSearchItem(item());
    expect(t?.title).toBe('Around the World');
    expect(t?.artists).toEqual(['Daft Punk']);
    expect(t?.duration).toBe(429);
  });

  it('never invents artwork when the response carries none', () => {
    expect(trackFromSearchItem(item({ albumOfTrack: undefined }))?.artwork).toBeNull();
    expect(trackFromSearchItem(item({ albumOfTrack: { name: 'Homework' } }))?.artwork).toBeNull();
    expect(trackFromSearchItem(item({ albumOfTrack: { coverArt: { sources: [] } } }))?.artwork).toBeNull();
  });

  it('takes a source that has no width rather than showing nothing', () => {
    const t = trackFromSearchItem(item({ albumOfTrack: { coverArt: { sources: [{ url: 'https://i.scdn.co/image/only' }] } } }));
    expect(t?.artwork).toBe('https://i.scdn.co/image/only');
  });

  it('ignores a malformed source entry', () => {
    const t = trackFromSearchItem(item({ albumOfTrack: { coverArt: { sources: [{ width: 640 }, { url: 'https://i.scdn.co/image/ok', width: 300 }] } } }));
    expect(t?.artwork).toBe('https://i.scdn.co/image/ok');
  });
});
