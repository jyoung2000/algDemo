import { describe, expect, it } from 'vitest';
import { parseSpotdlSaved, searchSpotify } from './spotify-search';

const rec = (over: Record<string, unknown> = {}) => ({
  name: 'Around the World',
  artists: ['Daft Punk'],
  album_name: 'Homework',
  duration: 428.4,
  url: 'https://open.spotify.com/track/1pKYYY0dkg23sQQXi0Q5zN?si=abc',
  cover_url: 'https://i.scdn.co/image/x',
  year: 1997,
  isrc: 'FRX079700001',
  ...over,
});

describe('parseSpotdlSaved', () => {
  it('maps a spotDL saved song to a Spotify track', () => {
    const [t] = parseSpotdlSaved([rec()], 5);
    expect(t?.provider).toBe('spotify');
    expect(t?.platform_id).toBe('1pKYYY0dkg23sQQXi0Q5zN');
    expect(t?.url).toBe('https://open.spotify.com/track/1pKYYY0dkg23sQQXi0Q5zN');
    expect(t?.title).toBe('Around the World');
    expect(t?.artists).toEqual(['Daft Punk']);
    expect(t?.album).toBe('Homework');
    expect(t?.isrc).toBe('FRX079700001');
  });

  it('drops records that have no Spotify track URL or no title', () => {
    const out = parseSpotdlSaved(
      [rec({ url: 'https://www.youtube.com/watch?v=x' }), rec({ name: '  ' }), rec({ url: 'https://open.spotify.com/album/x' })],
      5,
    );
    expect(out).toEqual([]);
  });

  it('honours the limit and tolerates a non-array answer', () => {
    expect(parseSpotdlSaved([rec(), rec(), rec()], 2)).toHaveLength(2);
    expect(parseSpotdlSaved({ nope: true }, 5)).toEqual([]);
  });
});

describe('searchSpotify', () => {
  it('refuses without a spotDL runner (Android has none)', async () => {
    await expect(searchSpotify(null, 'daft punk', 5)).rejects.toThrow(/Windows app/);
  });

  it('returns no tracks for an empty query without calling spotDL', async () => {
    let called = false;
    const out = await searchSpotify(async () => ((called = true), []), '   ', 5);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
