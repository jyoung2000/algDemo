/**
 * ALBUM-SEARCH-001 / ALBUM-OPEN-001. Owner: "search albums and open albums like i would playlist or
 * song list ... a button on the individual song listing that lets you see / open the full album if the
 * song is from an album, ep, mixtape or long body of work". Bodies are trimmed from live answers
 * (Deezer /search/album, /album/{id}; iTunes search entity=album, lookup entity=song), 2026-11-10.
 */
import { describe, expect, it } from 'vitest';
import { Albums, albumKeyOf, albumKind, cleanAlbumTitle, isBodyOfWork, mergeAlbums, parseDeezerAlbums, parseItunesAlbums } from './albums';
import { Deezer } from './deezer';
import { Http, HostPacer, type HttpPort, type HttpRequest } from './net';

const enc = (s: string) => new TextEncoder().encode(s);

const DZ_SEARCH = {
  data: [
    {
      id: 498395131, title: 'A Great Chaos', link: 'https://www.deezer.com/album/498395131',
      cover_medium: 'https://cdn-images.dzcdn.net/images/cover/78da/250x250-000000-80-0-0.jpg', nb_tracks: 18, record_type: 'album',
      artist: { id: 2568121, name: 'Ken Carson' }, type: 'album',
    },
    {
      id: 1, title: 'Lost Files', link: 'https://www.deezer.com/album/1', cover_medium: null, nb_tracks: 5, record_type: 'ep',
      artist: { id: 2568121, name: 'Ken Carson' }, type: 'album',
    },
    { id: 2, title: 'Rock N Roll', link: 'https://www.deezer.com/album/2', nb_tracks: 1, record_type: 'single', artist: { id: 2568121, name: 'Ken Carson' }, type: 'album' },
  ],
  total: 3,
};

const AP_SEARCH = {
  resultCount: 2,
  results: [
    {
      wrapperType: 'collection', collectionType: 'Album', collectionId: 1711245729, artistName: 'Ken Carson', collectionName: 'A Great Chaos',
      collectionViewUrl: 'https://music.apple.com/us/album/a-great-chaos/1711245729?uo=4',
      artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg', trackCount: 18, releaseDate: '2023-10-13T07:00:00Z',
    },
    {
      wrapperType: 'collection', collectionType: 'Album', collectionId: 99, artistName: 'Ken Carson', collectionName: 'Teen X - EP',
      collectionViewUrl: 'https://music.apple.com/us/album/teen-x/99', artworkUrl100: null, trackCount: 6, releaseDate: '2018-04-01T07:00:00Z',
    },
  ],
};

const DZ_ALBUM = {
  id: 498395131, title: 'A Great Chaos', link: 'https://www.deezer.com/album/498395131',
  cover_medium: 'https://cdn-images.dzcdn.net/images/cover/78da/250x250-000000-80-0-0.jpg',
  genres: { data: [{ id: 116, name: 'Rap/Hip Hop' }] }, nb_tracks: 3, duration: 520, release_date: '2023-10-13', record_type: 'album',
  artist: { id: 2568121, name: 'Ken Carson' },
  tracks: {
    data: [
      { id: 2492328911, readable: true, title: 'Green Room', title_short: 'Green Room', title_version: '', link: 'https://www.deezer.com/track/2492328911', duration: 188, rank: 406747, explicit_lyrics: true, preview: '', artist: { id: 2568121, name: 'Ken Carson' }, type: 'track' },
      { id: 2492328921, readable: true, title: 'Jennifer\u2019s Body', title_short: 'Jennifer\u2019s Body', title_version: '', link: 'https://www.deezer.com/track/2492328921', duration: 150, artist: { id: 2568121, name: 'Ken Carson' }, type: 'track' },
      { id: 2492328931, readable: false, title: 'Fighting My Demons', title_short: 'Fighting My Demons', title_version: '', link: 'https://www.deezer.com/track/2492328931', duration: 182, artist: { id: 2568121, name: 'Ken Carson' }, type: 'track' },
    ],
  },
};

const AP_LOOKUP = {
  resultCount: 3,
  results: [
    { wrapperType: 'collection', collectionType: 'Album', collectionId: 99, artistName: 'Ken Carson', collectionName: 'Teen X - EP', collectionViewUrl: 'https://music.apple.com/us/album/teen-x/99', artworkUrl100: 'https://is1/100x100bb.jpg', trackCount: 2, releaseDate: '2018-04-01T07:00:00Z' },
    { wrapperType: 'track', kind: 'song', trackId: 12, trackName: 'Second', artistName: 'Ken Carson', collectionName: 'Teen X - EP', trackNumber: 2, discNumber: 1, trackTimeMillis: 120000, releaseDate: '2018-04-01T07:00:00Z' },
    { wrapperType: 'track', kind: 'song', trackId: 11, trackName: 'First', artistName: 'Ken Carson', collectionName: 'Teen X - EP', trackNumber: 1, discNumber: 1, trackTimeMillis: 100000, releaseDate: '2018-04-01T07:00:00Z' },
  ],
};

function albumsWith(routes: Record<string, unknown>) {
  const seen: string[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest) {
      seen.push(req.url);
      const u = new URL(req.url);
      const key = Object.keys(routes).find((k) => (u.host + u.pathname + u.search).startsWith(k));
      if (!key) return { status: 404, headers: {}, body: enc('{}') };
      return { status: 200, headers: {}, body: enc(JSON.stringify(routes[key])) };
    },
  };
  const http = new Http(port, new HostPacer({}, 0));
  return { albums: new Albums(http, new Deezer(http)), seen };
}

describe('what counts as a body of work (ALBUM-OPEN-001)', () => {
  it('names the kind from the platform, the title or the size', () => {
    expect(albumKind('album', 'A Great Chaos', 18)).toBe('album');
    expect(albumKind('ep', 'Lost Files', 5)).toBe('ep');
    expect(albumKind('single', 'Rock N Roll', 1)).toBe('single');
    expect(albumKind('compile', 'Rap Hits', 40)).toBe('compilation');
    expect(albumKind('Album', 'Teen X - EP', 6)).toBe('ep');
    expect(albumKind('Album', 'Hit - Single', 1)).toBe('single');
    expect(albumKind('album', 'Dedication 2 (Mixtape)', 20)).toBe('mixtape');
    expect(albumKind('album', 'So Much Fun', 1)).toBe('single');
  });

  it('strips the platform suffixes from a title', () => {
    expect(cleanAlbumTitle('Teen X - EP')).toBe('Teen X');
    expect(cleanAlbumTitle('Hit - Single')).toBe('Hit');
    expect(cleanAlbumTitle('A Great Chaos')).toBe('A Great Chaos');
  });

  it('offers the album button only for a song that sits on an album, EP or mixtape', () => {
    expect(isBodyOfWork({ title: 'Green Room', album: 'A Great Chaos', artists: ['Ken Carson'] })).toBe(true);
    expect(isBodyOfWork({ title: 'Rock N Roll', album: 'Rock N Roll', artists: ['Ken Carson'] })).toBe(false); // a single named after itself
    expect(isBodyOfWork({ title: 'Hit', album: 'Hit - Single', artists: ['X'] })).toBe(false);
    expect(isBodyOfWork({ title: 'Song', album: 'Other - Single', artists: ['X'] })).toBe(false);
    expect(isBodyOfWork({ title: 'Green Room', artists: ['Ken Carson'] })).toBe(false);
    expect(isBodyOfWork({ title: 'Green Room', album: '', artists: ['Ken Carson'] })).toBe(false);
  });

  it('keys an album by its artist and title, so the same album from two services is one album', () => {
    const a = albumKeyOf({ title: 'Green Room', album: 'A Great Chaos', artists: ['Ken Carson', 'Destroy Lonely'] });
    const b = albumKeyOf({ title: 'Jennifer\u2019s Body', album: 'A GREAT CHAOS', artist: 'Ken Carson' });
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    expect(albumKeyOf({ title: 'Rock N Roll', album: 'Rock N Roll', artists: ['Ken Carson'] })).toBeNull();
  });
});

describe('album search (ALBUM-SEARCH-001)', () => {
  it('reads Deezer albums', () => {
    const a = parseDeezerAlbums(DZ_SEARCH);
    expect(a.map((x) => [x.id, x.title, x.artist, x.kind, x.count])).toEqual([
      ['dz:498395131', 'A Great Chaos', 'Ken Carson', 'album', 18],
      ['dz:1', 'Lost Files', 'Ken Carson', 'ep', 5],
      ['dz:2', 'Rock N Roll', 'Ken Carson', 'single', 1],
    ]);
  });

  it('reads Apple albums, dropping the " - EP" from the title but keeping it as the kind', () => {
    const a = parseItunesAlbums(AP_SEARCH);
    expect(a.map((x) => [x.id, x.title, x.kind, x.year, x.count])).toEqual([
      ['ap:1711245729', 'A Great Chaos', 'album', '2023', 18],
      ['ap:99', 'Teen X', 'ep', '2018', 6],
    ]);
    expect(a[0]!.artwork).toBe('https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg');
  });

  it('merges the two services without repeating an album, Deezer first, singles last', () => {
    const m = mergeAlbums(parseDeezerAlbums(DZ_SEARCH), parseItunesAlbums(AP_SEARCH));
    expect(m.map((x) => x.id)).toEqual(['dz:498395131', 'dz:1', 'ap:99', 'dz:2']);
    // Apple's year fills in what Deezer's search answer leaves out.
    expect(m[0]!.year).toBe('2023');
  });

  it('searches both services and reports each one', async () => {
    const { albums, seen } = albumsWith({ 'api.deezer.com/search/album': DZ_SEARCH, 'itunes.apple.com/search': AP_SEARCH });
    const r = await albums.search('ken carson');
    expect(r.albums.map((x) => x.id)).toEqual(['dz:498395131', 'dz:1', 'ap:99', 'dz:2']);
    expect(r.sources).toMatchObject({ deezer: { state: 'ok', count: 3 }, apple: { state: 'ok', count: 2 } });
    expect(seen.some((u) => u.includes('entity=album'))).toBe(true);
  });

  it('still answers when one service fails', async () => {
    const { albums } = albumsWith({ 'itunes.apple.com/search': AP_SEARCH });
    const r = await albums.search('ken carson');
    expect(r.albums.map((x) => x.id)).toEqual(['ap:1711245729', 'ap:99']);
    expect(r.sources['deezer']!.state).toBe('failed');
  });
});

describe('opening an album (ALBUM-OPEN-001)', () => {
  it('opens a Deezer album as playable songs in album order, each carrying the album', async () => {
    const { albums } = albumsWith({ 'api.deezer.com/album/498395131': DZ_ALBUM });
    const a = await albums.open('dz:498395131');
    expect([a.title, a.artist, a.kind, a.year, a.count]).toEqual(['A Great Chaos', 'Ken Carson', 'album', '2023', 3]);
    // The unreadable song is left out: no service here can play it.
    expect(a.tracks.map((t) => t.title)).toEqual(['Green Room', 'Jennifer\u2019s Body']);
    expect(a.tracks[0]).toMatchObject({ album: 'A Great Chaos', album_id: '498395131', artists: ['Ken Carson'], provider: 'deezer' });
    expect(a.tracks[0]!.tags.map((t) => t.name)).not.toHaveLength(0);
    expect(a.duration).toBe(338);
  });

  it('opens an Apple album in disc and track order', async () => {
    const { albums } = albumsWith({ 'itunes.apple.com/lookup': AP_LOOKUP });
    const a = await albums.open('ap:99');
    expect([a.title, a.kind, a.count]).toEqual(['Teen X', 'ep', 2]);
    expect(a.tracks.map((t) => t.title)).toEqual(['First', 'Second']);
  });

  it('refuses an id it did not make', async () => {
    const { albums } = albumsWith({});
    await expect(albums.open('zz:1')).rejects.toThrow(/album/i);
  });

  it("finds a Deezer song's album straight from the id it carries", async () => {
    const { albums, seen } = albumsWith({ 'api.deezer.com/album/498395131': DZ_ALBUM });
    const a = await albums.openFor({ title: 'Green Room', album: 'A Great Chaos', artists: ['Ken Carson'], album_id: '498395131' });
    expect(a?.id).toBe('dz:498395131');
    expect(seen.some((u) => u.includes('/search'))).toBe(false);
  });

  it("finds any other song's album by searching its album title and artist", async () => {
    const { albums, seen } = albumsWith({ 'api.deezer.com/search/album': DZ_SEARCH, 'api.deezer.com/album/498395131': DZ_ALBUM });
    const a = await albums.openFor({ title: 'Green Room', album: 'A Great Chaos', artists: ['Ken Carson'], provider: 'ytmusic' });
    expect(a?.id).toBe('dz:498395131');
    expect(seen.find((u) => u.includes('/search/album'))).toMatch(/Ken%20Carson%20A%20Great%20Chaos/);
  });

  it('falls back to Apple, and says nothing was found rather than open the wrong album', async () => {
    const { albums } = albumsWith({ 'api.deezer.com/search/album': { data: [] }, 'itunes.apple.com/search': AP_SEARCH, 'itunes.apple.com/lookup': AP_LOOKUP });
    const a = await albums.openFor({ title: 'First', album: 'Teen X - EP', artists: ['Ken Carson'], provider: 'apple' });
    expect(a?.id).toBe('ap:99');
    const none = await albums.openFor({ title: 'X', album: 'An Album Nobody Has', artists: ['Ken Carson'] });
    expect(none).toBeNull();
  });
});
