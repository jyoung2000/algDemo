import { describe, expect, it } from 'vitest';
import { parseItunes } from './apple';

// Shape taken from a live response to itunes.apple.com/search?entity=song (2026-10-28).
const live = {
  resultCount: 3,
  results: [
    {
      wrapperType: 'track', kind: 'song', artistId: 5468295, collectionId: 617154241, trackId: 617154366,
      artistName: 'Daft Punk, Pharrell Williams & Nile Rodgers', collectionName: 'Random Access Memories',
      trackName: 'Get Lucky', trackViewUrl: 'https://music.apple.com/us/album/get-lucky/617154241?i=617154366&uo=4',
      previewUrl: 'https://audio-ssl.itunes.apple.com/x.m4a', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/a/100x100bb.jpg',
      trackTimeMillis: 248426, releaseDate: '2013-05-17T07:00:00Z', trackExplicitness: 'notExplicit', primaryGenreName: 'Dance',
    },
    { wrapperType: 'collection', collectionType: 'Album', collectionName: 'Not a song' },
    { wrapperType: 'track', kind: 'music-video', trackId: 9, trackName: 'Clip', artistName: 'X' },
    { wrapperType: 'track', kind: 'song', trackId: 10, trackName: '', artistName: 'Nobody' },
  ],
};

describe('Apple Music search parser (ported from applemusic.py)', () => {
  it('keeps only songs with an id, title and artist, in order', () => {
    const tracks = parseItunes(live);
    expect(tracks.map((t) => t.title)).toEqual(['Get Lucky']);
  });

  it('maps the fields the UI and the ranker use', () => {
    const [t] = parseItunes(live);
    expect(t!.provider).toBe('apple');
    expect(t!.platform_id).toBe('617154366');
    expect(t!.artists).toEqual(['Daft Punk, Pharrell Williams & Nile Rodgers']);
    expect(t!.album).toBe('Random Access Memories');
    expect(t!.duration).toBe(248);
    expect(t!.artwork).toContain('600x600bb');
    expect(t!.url).toContain('music.apple.com');
    expect(t!.explicit).toBe(false);
    expect(t!.preview).toBeNull(); // preview hosts are not on the allowlist
    expect(t!.release?.date).toBe('2013-05-17');
  });

  it('returns nothing for an empty or malformed answer', () => {
    expect(parseItunes({})).toEqual([]);
    expect(parseItunes({ results: null as never })).toEqual([]);
  });
});
