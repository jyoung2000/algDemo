/**
 * ALBUM-SEARCH-002. Owner: "can we add album search for soundcloud and youtubr music". Album search asks
 * YouTube Music and SoundCloud too, beside Deezer and Apple. Bodies are trimmed from live answers
 * recorded 2026-11-10 (golden/ytm-albums-search.json, ytm-album.json, sc-albums-search.json,
 * sc-album.json, sc-tracks-ids.json).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Albums, mergeAlbums, parseScAlbums, parseYtAlbum, parseYtAlbumSearch, rankAlbums, type AlbumSummary } from './albums';
import { Deezer } from './deezer';
import { YouTubeMusic, parseSearchSongs } from './ytmusic';
import { SoundCloud } from './soundcloud';
import { Http, HostPacer, type HttpPort, type HttpRequest } from './net';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const load = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
const YT_SEARCH = load('ytm-albums-search.json');
const YT_ALBUM = load('ytm-album.json');
const SC_SEARCH = load('sc-albums-search.json');
const SC_ALBUM = load('sc-album.json');
const SC_IDS = load('sc-tracks-ids.json');
const enc = (s: string) => new TextEncoder().encode(s);

function world(routes: Record<string, unknown>) {
  const seen: { url: string; body?: string }[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest) {
      const body = req.body === null || req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body as unknown as Uint8Array);
      seen.push({ url: req.url, ...(body ? { body } : {}) });
      const u = new URL(req.url);
      if (u.host === 'soundcloud.com') return { status: 200, headers: {}, body: enc(`var a={client_id:"${'c'.repeat(32)}"}`) };
      const key = Object.keys(routes).find((k) => (u.host + u.pathname + u.search).startsWith(k));
      if (!key) return { status: 404, headers: {}, body: enc('{}') };
      return { status: 200, headers: {}, body: enc(JSON.stringify(routes[key])) };
    },
  };
  const http = new Http(port, new HostPacer({}, 0));
  return { albums: new Albums(http, new Deezer(http), undefined, new YouTubeMusic(http), new SoundCloud(http)), seen };
}

describe('YouTube Music albums', () => {
  it('reads album search rows: title, artist, kind, year and cover', () => {
    const r = parseYtAlbumSearch(YT_SEARCH);
    expect(r.slice(0, 3).map((a) => [a.id, a.title, a.artist, a.kind, a.year])).toEqual([
      ['yt:MPREb_QqGdeeXXgBz', 'A Great Chaos', 'Ken Carson', 'album', '2023'],
      ['yt:MPREb_h61jplJoXNf', 'X', 'Ken Carson', 'album', '2022'],
      ['yt:MPREb_fOvHAaVnbNe', 'More Chaos', 'Ken Carson', 'album', '2025'],
    ]);
    expect(r[3]!.kind).toBe('single');
    expect(r[0]!).toMatchObject({ provider: 'ytmusic', url: 'https://music.youtube.com/browse/MPREb_QqGdeeXXgBz' });
    expect(r[0]!.artwork).toMatch(/^https:\/\/.*=w544-h544/);
  });

  it('skips rows that are not album pages, such as an artist', () => {
    const copy = structuredClone(YT_SEARCH);
    const rows = copy.contents.tabbedSearchResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].musicShelfRenderer.contents;
    rows[0].musicResponsiveListItemRenderer.navigationEndpoint.browseEndpoint.browseId = 'UCaG2V4fBeGjBVuLQu7bCcGg';
    expect(parseYtAlbumSearch(copy).map((a) => a.title)).toEqual(['X', 'More Chaos', 'free type beat']);
  });

  it('skips a row that names no artist (live: an audiobook "Album • 2019")', () => {
    const copy = structuredClone(YT_SEARCH);
    const rows = copy.contents.tabbedSearchResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].musicShelfRenderer.contents;
    rows[1].musicResponsiveListItemRenderer.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs = [{ text: 'Album' }, { text: ' • ' }, { text: '2019' }];
    expect(parseYtAlbumSearch(copy).map((a) => a.title)).toEqual(['A Great Chaos', 'More Chaos', 'free type beat']);
  });

  it('opens an album as full songs in album order, each naming the album it is on', () => {
    const a = parseYtAlbum(YT_ALBUM, 'MPREb_QqGdeeXXgBz', new YouTubeMusic(null as never));
    expect([a.title, a.artist, a.kind, a.year, a.count]).toEqual(['A Great Chaos', 'Ken Carson', 'album', '2023', 18]);
    expect(a.tracks.map((t) => [t.title, t.duration, t.artists[0], t.platform_id])).toEqual([
      ['Green Room', 189, 'Ken Carson', 'AFTkc39TYiQ'],
      ['Jennifer\u2019s Body', 159, 'Ken Carson', 'CSMiPngo4uE'],
      ['Fighting My Demons', 151, 'Ken Carson', 'G3QCk9sD3JY'],
    ]);
    expect(a.tracks[0]).toMatchObject({ provider: 'ytmusic', album: 'A Great Chaos', album_id: 'yt:MPREb_QqGdeeXXgBz', kind: 'song' });
    expect(a.tracks[0]!.artwork).toBe(a.artwork);
  });
});

describe('YouTube Music songs', () => {
  it('name the album page they sit on, so their album button opens that album', () => {
    const y = new YouTubeMusic(null as never);
    const t = y.toTrack(parseSearchSongs(load('ytm-search.json'))[1]!);
    expect([t.album, t['album_id']]).toEqual(['Discovery', 'yt:MPREb_7ltM34kr0mH']);
  });
});

describe('SoundCloud albums', () => {
  it('keeps the artist\u2019s own albums first and drops empty sets', () => {
    const r = parseScAlbums(SC_SEARCH);
    expect(r[0]).toMatchObject({ id: 'sc:1843556490', provider: 'soundcloud', title: 'A Great Chaos (Deluxe)', artist: 'Ken Carson', year: '2024', count: 25, kind: 'album', official: true });
    expect(r[1]).toMatchObject({ id: 'sc:1703868492', title: 'A Great Chaos', official: true, url: 'https://soundcloud.com/kencarson/sets/a-great-chaos' });
    expect(r.every((a) => (a.count ?? 0) > 0)).toBe(true);
    expect(r.find((a) => a.artist === 'Lil Uzi Vert Radio')).toBeUndefined();
  });

  it('names a fan upload titled "Artist - Album" by that artist, not the uploader', () => {
    const r = parseScAlbums(SC_SEARCH);
    const fan = r.find((a) => a.id === 'sc:1715710119');
    expect(fan).toMatchObject({ title: 'A Great Chaos', artist: 'Ken Carson', official: false });
  });

  it('names the artist the set’s songs name when the account goes by another name (live: Frank Ocean as "blonded")', () => {
    const songs = (artist: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: 'track', title: `Song ${i}`, publisher_metadata: { artist } }));
    const own = { kind: 'playlist', id: 9, title: 'Blonde', set_type: 'album', track_count: 17, user: { username: 'blonded', verified: true }, tracks: [...songs('Frank Ocean', 3), { id: 99, kind: 'track' }] };
    expect(parseScAlbums({ collection: [own] })[0]).toMatchObject({ title: 'Blonde', artist: 'Frank Ocean', official: true });
    // Songs by many artists (a mix) keep the uploader's name.
    const mix = { ...own, id: 10, title: 'Summer Mix', tracks: [...songs('A', 1), ...songs('B', 1), ...songs('C', 1)] };
    expect(parseScAlbums({ collection: [mix] })[0]!.artist).toBe('blonded');
  });

  it('keeps an artist’s own set title whole, dash and all', () => {
    const own = { kind: 'playlist', id: 7, title: 'Live - London 2019', set_type: 'album', track_count: 9, user: { username: 'Ken Carson', verified: true } };
    expect(parseScAlbums({ collection: [own] })[0]).toMatchObject({ title: 'Live - London 2019', artist: 'Ken Carson', official: true });
  });
});

describe('merging four services (ALBUM-SEARCH-002)', () => {
  it('asks all four at once, keeps one row per album, and fills a year the first service lacks', async () => {
    const { albums, seen } = world({
      'api.deezer.com/search/album': { data: [{ id: 498395131, title: 'A Great Chaos', nb_tracks: 18, record_type: 'album', artist: { name: 'Ken Carson' }, type: 'album' }] },
      'itunes.apple.com/search': { results: [] },
      'music.youtube.com/youtubei/v1/search': YT_SEARCH,
      'api-v2.soundcloud.com/search/albums': SC_SEARCH,
    });
    const r = await albums.search('ken carson a great chaos');
    expect(r.sources).toMatchObject({ deezer: { state: 'ok' }, apple: { state: 'ok' }, ytmusic: { state: 'ok', count: 4 }, soundcloud: { state: 'ok' } });
    expect(seen.some((s) => s.url.includes('youtubei/v1/search') && s.body?.includes('EgWKAQIYAWoMEA4QChADEAQQCRAF'))).toBe(true);
    const ids = r.albums.map((a) => a.id);
    // Deezer's A Great Chaos, with YouTube Music's year; YouTube Music's own X and More Chaos;
    // SoundCloud's deluxe edition.
    expect(ids[0]).toBe('dz:498395131');
    expect(r.albums[0]!.year).toBe('2023');
    expect(ids).toContain('yt:MPREb_h61jplJoXNf');
    expect(ids).toContain('sc:1843556490');
    expect(ids).not.toContain('yt:MPREb_QqGdeeXXgBz'); // the same album as Deezer's
    expect(ids).not.toContain('sc:1703868492');
    // YouTube Music's "free type beat" single shares no word with the search, so it is not offered.
    expect(ids).not.toContain('yt:MPREb_pwsEYizYyls');
    // A fan's copy of an album already found is not offered again under another uploader.
    expect(r.albums.filter((a) => a.title === 'A Great Chaos')).toHaveLength(1);
    expect(r.albums.find((a) => a.artist === 'Ken fartson')).toBeUndefined();
  });

  it('puts unofficial SoundCloud sets after every official album', () => {
    const m = mergeAlbums(
      [{ id: 'dz:1', provider: 'deezer', title: 'Alpha', artist: 'A', artwork: null, year: null, kind: 'album', count: 9, url: '' }],
      [],
      [],
      [
        { id: 'sc:2', provider: 'soundcloud', title: 'Tape', artist: 'Kid', artwork: null, year: null, kind: 'album', count: 5, url: '', official: false },
        { id: 'sc:3', provider: 'soundcloud', title: 'Beta', artist: 'B', artwork: null, year: null, kind: 'album', count: 5, url: '', official: true },
      ],
    );
    expect(m.map((a) => a.id)).toEqual(['dz:1', 'sc:3', 'sc:2']);
  });

  it('ranks the album the words name above loose matches from an earlier service (live "frank ocean blonde")', () => {
    const a = (id: string, title: string, artist: string, extra: Partial<AlbumSummary> = {}): AlbumSummary => ({ id, provider: 'deezer', title, artist, artwork: null, year: null, kind: 'album', count: 10, url: '', ...extra });
    const merged = [
      a('dz:1', 'Ocean Waves 3 Hours - Relaxing Music for Self Control', 'Frank Blonde'),
      a('dz:2', 'Thursday Warmup, Vol. 1', 'Various Artists'),
      a('ap:3', 'Piano Tribute to Frank Ocean', 'Blond Piano', { provider: 'apple' }),
      a('yt:MPREb_aaaaaaaaaaaa', 'Blonde', 'Frank Ocean', { provider: 'ytmusic' }),
      a('sc:5', 'Blonde (Fan Remaster)', 'frank ocean', { provider: 'soundcloud', official: false }),
      a('yt:MPREb_bbbbbbbbbbbb', 'Blonde', 'Frank Ocean', { provider: 'ytmusic', kind: 'single' }),
    ];
    // The Various Artists warm-up shares no word with the search, so it is not offered at all.
    expect(rankAlbums('frank ocean blonde', merged).map((x) => x.id)).toEqual(['yt:MPREb_aaaaaaaaaaaa', 'dz:1', 'ap:3', 'sc:5', 'yt:MPREb_bbbbbbbbbbbb']);
  });

  it('drops albums that share no word with the search (live: "Freestyling Rap — Type Beat" for "ken carson a great chaos"), unless the words are all unreadable', () => {
    const a = (id: string, title: string, artist: string): AlbumSummary => ({ id, provider: 'ytmusic', title, artist, artwork: null, year: null, kind: 'album', count: null, url: '' });
    expect(rankAlbums('ken carson a great chaos', [a('yt:1', 'Freestyling Rap', 'Type Beat'), a('yt:2', 'X', 'Ken Carson')]).map((x) => x.id)).toEqual(['yt:2']);
    expect(rankAlbums('あ', [a('yt:3', 'Hikari', 'Utada')]).map((x) => x.id)).toEqual(['yt:3']);
  });

  it('puts the album the words name before a longer title, and the artist’s own album before a stranger’s of that name', () => {
    const a = (id: string, title: string, artist: string): AlbumSummary => ({ id, provider: 'ytmusic', title, artist, artwork: null, year: null, kind: 'album', count: 10, url: '' });
    expect(rankAlbums('frank ocean blonde', [a('yt:1', 'Blonde Sessions', 'Frank Ocean'), a('yt:2', 'Blonde', 'Frank Ocean')]).map((x) => x.id)).toEqual(['yt:2', 'yt:1']);
    expect(rankAlbums('frank ocean blonde', [a('yt:3', 'Blonde', 'Guri7'), a('yt:4', 'channel ORANGE', 'Frank Ocean')]).map((x) => x.id)).toEqual(['yt:4', 'yt:3']);
  });

  it('keeps the services’ own order when the words fit every album equally', () => {
    const a = (id: string, title: string): AlbumSummary => ({ id, provider: 'deezer', title, artist: 'Ken Carson', artwork: null, year: null, kind: 'album', count: 10, url: '' });
    const list = [a('dz:1', 'X'), a('dz:2', 'Project X'), a('dz:3', 'Teen X')];
    expect(rankAlbums('ken carson', list).map((x) => x.id)).toEqual(['dz:1', 'dz:2', 'dz:3']);
  });

  it('still answers when YouTube Music and SoundCloud fail', async () => {
    const { albums } = world({ 'api.deezer.com/search/album': { data: [{ id: 1, title: 'Lost Files', nb_tracks: 5, record_type: 'ep', artist: { name: 'Ken Carson' }, type: 'album' }] }, 'itunes.apple.com/search': { results: [] } });
    const r = await albums.search('lost files');
    expect(r.albums.map((a) => a.id)).toEqual(['dz:1']);
    expect(r.sources['ytmusic']!.state).toBe('failed');
    expect(r.sources['soundcloud']!.state).toBe('failed');
  });
});

describe('opening YouTube Music and SoundCloud albums', () => {
  it('opens a YouTube Music album by its id', async () => {
    const { albums, seen } = world({ 'music.youtube.com/youtubei/v1/browse': YT_ALBUM });
    const a = await albums.open('yt:MPREb_QqGdeeXXgBz');
    expect(a.tracks.map((t) => t.title)).toEqual(['Green Room', 'Jennifer\u2019s Body', 'Fighting My Demons']);
    expect(seen.find((s) => s.url.includes('/browse'))!.body).toContain('"browseId":"MPREb_QqGdeeXXgBz"');
  });

  it('opens a SoundCloud album with every song, fetching the ones the set lists only by id, in order', async () => {
    const { albums, seen } = world({ 'api-v2.soundcloud.com/playlists/1843556490': SC_ALBUM, 'api-v2.soundcloud.com/tracks': SC_IDS });
    const a = await albums.open('sc:1843556490');
    expect(a.tracks.map((t) => t.title)).toEqual(['Green Room', 'Jennifer\u2019s Body', 'Hardcore', 'Me N My Kup']);
    expect(seen.find((s) => s.url.includes('/tracks?'))!.url).toMatch(/ids=1858817073%2C1858817109|ids=1858817073,1858817109/);
    expect(a.tracks[0]).toMatchObject({ provider: 'soundcloud', album: 'A Great Chaos (Deluxe)', album_id: 'sc:1843556490', artists: ['Ken Carson'] });
    // The real length, not a 30-second preview's.
    expect(a.tracks[2]!.duration).toBe(125);
    expect([a.title, a.artist, a.count, a.year]).toEqual(['A Great Chaos (Deluxe)', 'Ken Carson', 25, '2024']);
  });

  it('leaves out a song the uploader allows only as a preview, so the album never plays a 30-second clip', async () => {
    const album = structuredClone(SC_ALBUM);
    album.tracks[1].policy = 'SNIP';
    const { albums } = world({ 'api-v2.soundcloud.com/playlists/1843556490': album, 'api-v2.soundcloud.com/tracks': SC_IDS });
    const a = await albums.open('sc:1843556490');
    expect(a.tracks.map((t) => t.title)).toEqual(['Green Room', 'Hardcore', 'Me N My Kup']);
  });

  it('refuses ids it did not make', async () => {
    const { albums } = world({});
    await expect(albums.open('yt:notanalbum')).rejects.toThrow(/album/i);
    await expect(albums.open('sc:abc')).rejects.toThrow(/album/i);
  });

  it('opens a YouTube Music song\u2019s own album from the album it names', async () => {
    const { albums, seen } = world({ 'music.youtube.com/youtubei/v1/browse': YT_ALBUM });
    const a = await albums.openFor({ title: 'Green Room', album: 'A Great Chaos', artists: ['Ken Carson'], provider: 'ytmusic', album_id: 'yt:MPREb_QqGdeeXXgBz' });
    expect(a?.id).toBe('yt:MPREb_QqGdeeXXgBz');
    expect(seen.some((s) => s.url.includes('/search'))).toBe(false);
  });

  it('looks on YouTube Music and SoundCloud when Deezer and Apple have no such album', async () => {
    const { albums } = world({
      'api.deezer.com/search/album': { data: [] }, 'itunes.apple.com/search': { results: [] },
      'music.youtube.com/youtubei/v1/search': YT_SEARCH, 'music.youtube.com/youtubei/v1/browse': YT_ALBUM,
    });
    const a = await albums.openFor({ title: 'Green Room', album: 'A Great Chaos', artists: ['Ken Carson'], provider: 'soundcloud' });
    expect(a?.id).toBe('yt:MPREb_QqGdeeXXgBz');
  });
});
