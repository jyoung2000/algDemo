/**
 * ARTIST-PAGE-001. Owner: "can we add artist pages where we can see all of an artist songs and albums".
 * Bodies trimmed from live answers recorded 2026-11-10 (golden/dz-artist*.json, ytm-artist*.json).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Albums } from './albums';
import { Artists, parseDeezerArtists, parseYtArtistPage, parseYtArtistSearch, parseYtSongRows, parseYtDiscography, artistTargetOf, partitionFeatures } from './artists';
import { Deezer } from './deezer';
import { YouTubeMusic } from './ytmusic';
import { Http, HostPacer, type HttpPort, type HttpRequest } from './net';
import type { Track } from './track';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const load = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
const DZ_SEARCH = load('dz-artist-search.json');
const DZ_ARTIST = load('dz-artist.json');
const DZ_TOP = load('dz-artist-top.json');
const DZ_ALBUMS = load('dz-artist-albums.json');
const YT_SEARCH = load('ytm-artist-search.json');
const YT_PAGE = load('ytm-artist.json');
const YT_SONGS = load('ytm-artist-songs.json');
const YT_CONT = load('ytm-artist-songs-cont.json');
const enc = (s: string) => new TextEncoder().encode(s);
const UC = 'UCaG2V4fBeGjBVuLQu7bCcGg';
const SONGS_LIST = 'VLOLAK5uy_m2Pd7qePTcC5QqjTV9ByX4JpejSSWq7n4';

/** Routes: url prefix -> body; a YouTube Music POST is told apart by the browseId / continuation in its body. */
function world(routes: Record<string, unknown>) {
  const seen: { url: string; body?: string }[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest) {
      const body = req.body === null || req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body as unknown as Uint8Array);
      seen.push({ url: req.url, ...(body ? { body } : {}) });
      const u = new URL(req.url);
      let key = u.host + u.pathname + u.search;
      if (u.host === 'music.youtube.com' && body) {
        const b = JSON.parse(body) as Record<string, unknown>;
        key = `${u.host}${u.pathname}#${String(b['browseId'] ?? (b['continuation'] ? 'continuation' : b['params'] ?? ''))}`;
      }
      const hit = Object.keys(routes).find((k) => key.startsWith(k));
      if (!hit) return { status: 404, headers: {}, body: enc('{}') };
      return { status: 200, headers: {}, body: enc(JSON.stringify(routes[hit])) };
    },
  };
  const http = new Http(port, new HostPacer({}, 0));
  const dz = new Deezer(http);
  const yt = new YouTubeMusic(http);
  return { artists: new Artists(http, dz, yt, undefined, new Albums(http, dz, undefined, yt)), seen };
}

const FULL = {
  'api.deezer.com/search/artist': DZ_SEARCH,
  'api.deezer.com/artist/2568121/top': DZ_TOP,
  'api.deezer.com/artist/2568121/albums': DZ_ALBUMS,
  'api.deezer.com/artist/2568121': DZ_ARTIST,
  'music.youtube.com/youtubei/v1/search#': YT_SEARCH,
  [`music.youtube.com/youtubei/v1/browse#${UC}`]: YT_PAGE,
  [`music.youtube.com/youtubei/v1/browse#${SONGS_LIST}`]: YT_SONGS,
  'music.youtube.com/youtubei/v1/browse#continuation': YT_CONT,
};

describe('reading artists', () => {
  it('reads Deezer artist search: name, picture, fans', () => {
    const r = parseDeezerArtists(DZ_SEARCH);
    expect(r[0]).toMatchObject({ id: 'dz:2568121', provider: 'deezer', name: 'Ken Carson' });
    expect(r[0]!.picture).toMatch(/^https:\/\//);
    expect(r[0]!.detail).toMatch(/fans$/);
  });

  it('reads YouTube Music artist search rows', () => {
    const r = parseYtArtistSearch(YT_SEARCH);
    expect(r.map((a) => [a.id, a.name, a.detail])).toEqual([
      [`yt:${UC}`, 'Ken Carson', '4.47M monthly audience'],
      ['yt:UCRB-a6u9flpg0xuBqCf9QlQ', 'Playboi Carti', '58.5M monthly audience'],
    ]);
  });

  it('skips a search row that is not an artist channel (a playlist, a podcast)', () => {
    const copy = JSON.parse(JSON.stringify(YT_SEARCH));
    const rows = copy.contents.tabbedSearchResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].musicShelfRenderer.contents;
    rows[1].musicResponsiveListItemRenderer.navigationEndpoint.browseEndpoint.browseId = 'VLPL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i';
    expect(parseYtArtistSearch(copy).map((a) => a.name)).toEqual(['Ken Carson']);
  });

  it('reads a YouTube Music artist page: header, the full songs list, albums and singles & EPs', () => {
    const p = parseYtArtistPage(YT_PAGE);
    expect([p.name, p.detail, p.songsList]).toEqual(['Ken Carson', '4.47M monthly audience', SONGS_LIST]);
    expect(p.picture).toMatch(/^https:\/\//);
    expect(p.albums.map((a) => [a.id, a.title, a.year, a.kind])).toEqual([
      ['yt:MPREb_RJbhyEeulwV', 'xperiment - cartunez', '2026', 'album'],
      ['yt:MPREb_nR4HIxo9kGW', 'xperiment', '2026', 'album'],
      ['yt:MPREb_fOvHAaVnbNe', 'More Chaos', '2025', 'album'],
      ['yt:MPREb_QqGdeeXXgBz', 'A Great Chaos', '2023', 'album'],
      // From the "Singles & EPs" shelf: an EP is a body of work, so it sits with the albums.
      [expect.stringMatching(/^yt:MPREb_/), 'Teen X : Relapsed', '2021', 'ep'],
    ]);
    expect(p.singles.map((a) => [a.title, a.kind, a.year])).toEqual([
      ['the acronym', 'single', '2025'], ['margiela', 'single', '2025'], ['catastrophe', 'single', '2025'],
    ]);
    expect(p.albums.every((a) => a.artist === 'Ken Carson' && a.provider === 'ytmusic')).toBe(true);
  });

  it('keeps the \u201cmore\u201d link of a shelf YouTube Music only shows a few of, and reads its grid', () => {
    // A live artist page shows about ten albums and offers the rest behind the shelf's own link.
    const copy = JSON.parse(JSON.stringify(YT_PAGE));
    const secs = copy.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents;
    const shelf = secs.find((s: Record<string, unknown>) => s['musicCarouselShelfRenderer']);
    shelf.musicCarouselShelfRenderer.header = {
      musicCarouselShelfBasicHeaderRenderer: {
        title: { runs: [{ text: 'Albums' }] },
        moreContentButton: { buttonRenderer: { navigationEndpoint: { browseEndpoint: { browseId: UC, params: 'ggMIegYIAxoCGAI%3D' } } } },
      },
    };
    expect(parseYtArtistPage(copy).more).toEqual([{ kind: 'albums', params: 'ggMIegYIAxoCGAI%3D' }]);

    const grid = {
      contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ gridRenderer: { items: [
        { musicTwoRowItemRenderer: { title: { runs: [{ text: 'Deep Cut LP' }] }, subtitle: { runs: [{ text: 'Album' }, { text: ' \u2022 ' }, { text: '2019' }] }, navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_deepcut01' } }, thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://art/1' }] } } } } },
        { musicTwoRowItemRenderer: { title: { runs: [{ text: 'Loosie' }] }, subtitle: { runs: [{ text: 'Single' }, { text: ' \u2022 ' }, { text: '2020' }] }, navigationEndpoint: { browseEndpoint: { browseId: 'MPREb_loosie0001' } }, thumbnailRenderer: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://art/2' }] } } } } },
      ] } }] } } } }] } },
    };
    expect(parseYtDiscography(grid, 'Ken Carson').map((a) => [a.id, a.title, a.kind, a.year, a.artist])).toEqual([
      ['yt:MPREb_deepcut01', 'Deep Cut LP', 'album', '2019', 'Ken Carson'],
      ['yt:MPREb_loosie0001', 'Loosie', 'single', '2020', 'Ken Carson'],
    ]);
  });

  it('reads the songs list as full YouTube Music songs, each naming its album, and the next page', () => {
    const yt = new YouTubeMusic(null as never);
    const { tracks, next } = parseYtSongRows(YT_SONGS, yt);
    expect(tracks.map((t) => [t.title, t.duration, t.album, t['album_id'], t.platform_id])).toEqual([
      ['ss', 185, 'A Great Chaos (Deluxe)', 'yt:MPREb_73ixDtiJjmT', 'KavaUJxnNVU'],
      ['Yale', 107, 'Teen X', 'yt:MPREb_m4bV4Ju0Y9u', 'NaEl1gDI124'],
      ['overseas', 142, 'A Great Chaos (Deluxe)', 'yt:MPREb_73ixDtiJjmT', 'uqZGVuLoxlQ'],
    ]);
    expect(tracks[0]).toMatchObject({ provider: 'ytmusic', artists: ['Ken Carson'], kind: 'song' });
    expect(next).toMatch(/^4qmF/);
    expect(parseYtSongRows(YT_CONT, yt).tracks).toHaveLength(2);
    expect(parseYtSongRows(YT_CONT, yt).next).toBeNull();
  });
});

describe('opening an artist (ARTIST-PAGE-001)', () => {
  it('opens on the most played songs, their features apart, without YouTube Music\u2019s costly songs list', async () => {
    const { artists, seen } = world(FULL);
    const a = await artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect([a.name, a.id, a.detail]).toEqual(['Ken Carson', 'dz:2568121', '4.47M monthly audience']);
    expect(a.songs.map((t) => t.title)).toEqual(['overseas', 'Fighting My Demons', 'gynecologist', 'ss']);
    // ARTIST-FEATURES-001: Lil Tecca's song, with Ken Carson on it, belongs under features.
    expect(a.features.map((t) => t.title)).toEqual(['Fell In Love']);
    expect(a.features[0]!.artists).toEqual(['Lil Tecca', 'Ken Carson']);
    expect(a.features[0]!['artist_ids']).toMatchObject({ deezer: '14492701' });
    expect(a.sources).toMatchObject({ deezer: { state: 'ok' }, ytmusic: { state: 'ok' } });
    expect(seen.some((s) => s.body?.includes(SONGS_LIST) || s.body?.includes('continuation'))).toBe(false);
  });

  it('reads YouTube Music\u2019s songs list, every page, for an artist Deezer does not have', async () => {
    const { artists } = world({ ...FULL, 'api.deezer.com/search/artist': { data: [] } });
    const a = await artists.open({ id: `yt:${UC}`, name: 'Ken Carson' });
    const yt = new YouTubeMusic(null as never);
    expect(a.songs.map((t) => t.title)).toEqual(['ss', 'Yale', 'overseas', ...parseYtSongRows(YT_CONT, yt).tracks.map((t) => t.title)]);
    expect(a.sources['deezer']!.state).toBe('none');
  });

  it('lists every album, EP and single once, newest first, singles apart', async () => {
    const { artists } = world(FULL);
    const a = await artists.open({ id: `yt:${UC}`, name: 'Ken Carson' });
    const titles = a.albums.map((x) => x.title);
    expect(titles.filter((t) => t === 'xperiment')).toHaveLength(1);
    expect(titles).toContain('A Great Chaos');
    expect(titles).toContain('Teen X : Relapsed');
    expect(a.albums.every((x) => x.kind !== 'single')).toBe(true);
    const years = a.albums.map((x) => Number(x.year ?? 0));
    expect([...years].sort((p, q) => q - p)).toEqual(years);
    expect(a.singles.map((x) => x.title)).toEqual(expect.arrayContaining(['Possession', 'the acronym', 'margiela']));
    expect(a.singles.filter((x) => x.title === 'the acronym')).toHaveLength(1);
    expect(a.singles.every((x) => x.kind === 'single')).toBe(true);
  });

  it('follows Deezer\u2019s discography to its last page, however many there are', async () => {
    // Six pages of releases: past the four an earlier bound allowed, so "all" means all of them.
    const rel = (id: number, kind: string) => ({ id, title: `Release ${id}`, record_type: kind, release_date: `20${10 + (id % 10)}-01-01`, nb_tracks: kind === 'single' ? 1 : 10, cover_medium: null, link: `https://www.deezer.com/album/${id}`, artist: { name: 'Ken Carson' } });
    const dzPage = (p: number) => ({ data: [rel(100 + p, p % 2 ? 'single' : 'album')], ...(p < 5 ? { next: `https://api.deezer.com/artist/2568121/albums?limit=100&index=${(p + 1) * 100}` } : {}) });
    // Routes are matched by prefix in insertion order, so the longest paths come first.
    const routes: Record<string, unknown> = {};
    for (let p = 5; p >= 1; p--) routes[`api.deezer.com/artist/2568121/albums?limit=100&index=${p * 100}`] = dzPage(p);
    routes['api.deezer.com/artist/2568121/albums?limit=100'] = dzPage(0);
    routes['api.deezer.com/artist/2568121/top'] = DZ_TOP;
    routes['api.deezer.com/artist/2568121'] = DZ_ARTIST;
    routes['api.deezer.com/search/track'] = { data: [] };
    const w = world(routes);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const titles = [...a.albums, ...a.singles].map((x) => x.title);
    expect(titles).toHaveLength(6);
    expect(titles).toEqual(expect.arrayContaining(['Release 100', 'Release 101', 'Release 102', 'Release 103', 'Release 104', 'Release 105']));
  });

  it('finds the other service\u2019s page by the artist\u2019s exact name', async () => {
    const { artists, seen } = world(FULL);
    await artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect(seen.some((s) => s.body?.includes(`"browseId":"${UC}"`))).toBe(true);
    const b = world(FULL);
    await b.artists.open({ id: `yt:${UC}`, name: 'Ken Carson' });
    expect(b.seen.some((s) => s.url.includes('/artist/2568121/top'))).toBe(true);
  });

  it('never borrows a different artist whose name only resembles it', async () => {
    const { artists, seen } = world({ ...FULL, 'api.deezer.com/search/artist': { data: [{ id: 5, name: 'Ken Carson Band', nb_fan: 3, link: '' }] } });
    const a = await artists.open({ id: `yt:${UC}`, name: 'Ken Carson' });
    expect(seen.some((s) => s.url.includes('/artist/5/'))).toBe(false);
    expect(a.sources['deezer']!.state).toBe('none');
    expect(a.songs.length).toBeGreaterThan(0);
  });

  it('trusts the id over a name that does not match it, and looks the other service up by the id\u2019s artist', async () => {
    const { artists, seen } = world(FULL);
    const a = await artists.open({ id: 'dz:2568121', name: 'Lil Tecca' });
    expect(a.name).toBe('Ken Carson');
    expect(a.sources['ytmusic']!.state).toBe('ok');
    expect(seen.some((s) => s.body?.includes(`"browseId":"${UC}"`))).toBe(true);
  });

  it('still opens when one service fails', async () => {
    const { artists } = world({ 'api.deezer.com/artist/2568121/top': DZ_TOP, 'api.deezer.com/artist/2568121/albums': DZ_ALBUMS, 'api.deezer.com/artist/2568121': DZ_ARTIST });
    const a = await artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect(a.songs.map((t) => t.title)).toContain('overseas');
    expect(a.albums.length).toBeGreaterThan(0);
    expect(a.sources['ytmusic']!.state).not.toBe('ok');
  });

  it('refuses ids it did not make', async () => {
    const { artists } = world({});
    // Even with a good name beside it, a bad id is refused rather than quietly searched by name.
    await expect(artists.open({ id: 'xx:1', name: 'Ken Carson' })).rejects.toThrow(/not an artist/i);
    await expect(artists.open({ id: 'yt:notachannel', name: 'Ken Carson' })).rejects.toThrow(/not an artist/i);
    await expect(artists.open({ id: 'dz:12a', name: 'Ken Carson' })).rejects.toThrow(/not an artist/i);
  });

  it('searches both services, one row per artist, the one the words name first', async () => {
    const { artists } = world(FULL);
    const r = await artists.search('ken carson');
    expect(r[0]).toMatchObject({ name: 'Ken Carson', id: 'dz:2568121' });
    expect(r.filter((x) => x.name === 'Ken Carson')).toHaveLength(1);
    expect(r[0]!.alt).toBe(`yt:${UC}`);
    // Words naming a later row exactly bring that row to the top.
    const b = await world(FULL).artists.search('ai ken carson');
    expect(b[0]!.name).toBe('Ai Ken Carson');
  });
});

describe('which of several same-named artists a name opens (ARTIST-NAME-PICK-001)', () => {
  // Deezer answers its own order, which can put a 42-fan namesake above the artist the words mean;
  // opening that one shows a near-empty page: a song or two, and no features to partition.
  const tiny = { id: 777001, type: 'artist', name: 'Nova Vale', nb_fan: 42, picture_big: null, link: 'https://www.deezer.com/artist/777001' };
  const real = { id: 777002, type: 'artist', name: 'Nova Vale', nb_fan: 1200000, picture_big: null, link: 'https://www.deezer.com/artist/777002' };
  const song = (id: number, title: string, lead: { id: number; name: string }, guests: { id: number; name: string }[] = []) => ({
    id, title, duration: 200, artist: lead, album: { id: 5, title: 'A record' }, contributors: [lead, ...guests],
  });
  const routes = {
    'api.deezer.com/search/artist': { data: [tiny, real] },
    'api.deezer.com/artist/777001/top': { data: [song(1, 'Namesake demo', { id: 777001, name: 'Nova Vale' })] },
    'api.deezer.com/artist/777001/albums': { data: [] },
    'api.deezer.com/artist/777001': tiny,
    'api.deezer.com/artist/777002/top': {
      data: [
        song(2, 'Their own song', { id: 777002, name: 'Nova Vale' }),
        song(3, 'Guest spot', { id: 900, name: 'Other Lead' }, [{ id: 777002, name: 'Nova Vale' }]),
      ],
    },
    'api.deezer.com/artist/777002/albums': { data: [] },
    'api.deezer.com/artist/777002': real,
  };

  it('opens the artist the words mean, so their features are there to see', async () => {
    const { artists } = world(routes);
    const v = await artists.open({ name: 'Nova Vale' });
    expect(v.links.deezer).toContain('777002');
    expect(v.songs.map((t) => t.title)).toEqual(['Their own song']);
    expect(v.features.map((t) => t.title)).toEqual(['Guest spot']);
  });

  it('offers that artist as the search row for the name, once', async () => {
    const { artists } = world(routes);
    const rows = await artists.search('Nova Vale');
    expect(rows.map((a) => a.id)).toEqual(['dz:777002']);
  });
});

describe('every song the artist has released (ARTIST-PAGE-001)', () => {
  const row = (title: string, id: number) => ({ ...DZ_TOP.data[0], id, title, title_short: title });
  const ALBUM = (id: number, title: string, rows: unknown[]) => ({ id, title, nb_tracks: rows.length, release_date: '2026-07-03', tracks: { data: rows } });
  const withAlbums = {
    ...FULL,
    'api.deezer.com/album/1020068251': ALBUM(1020068251, 'xperiment', [row('gynecologist', 1), row('lord of chaos', 2), row('overseas', 3)]),
    'api.deezer.com/album/1022450471': ALBUM(1022450471, 'Possession', [row('Possession', 4)]),
  };

  it('adds each song from the albums and singles that is not already listed, once', async () => {
    const { artists } = world(withAlbums);
    const a = await artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await artists.everySong(a);
    const titles = all.songs.map((t) => t.title);
    expect(titles.slice(0, a.songs.length)).toEqual(a.songs.map((t) => t.title));
    expect(titles).toEqual(expect.arrayContaining(['lord of chaos', 'Possession']));
    expect(new Set(titles).size).toBe(titles.length);
    expect(all.opened).toBe(a.albums.length + a.singles.length);
    // Pages this test world has no answer for are counted, not hidden.
    expect(all.failed).toBe(all.opened - 2);
  });

  it('still lists the most played songs when no album opens', async () => {
    const { artists } = world(FULL);
    const a = await artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await artists.everySong(a);
    expect(all.songs.map((t) => t.title)).toEqual(a.songs.map((t) => t.title));
    expect(all.failed).toBe(all.opened);
  });

  it('adds more of the songs other artists have them on, each confirmed by Deezer\u2019s contributors', async () => {
    const KC = { id: 2568121, name: 'Ken Carson' };
    const guest = (id: number, title: string, lead: { id: number; name: string }, contributors: { id: number; name: string }[]) =>
      ({ id, title, title_short: title, artist: lead, contributors, album: { id: 77, title: 'Guest LP' }, duration: 100, link: `https://www.deezer.com/track/${id}`, readable: true, rank: 1 });
    const w = world({
      ...withAlbums,
      // A name search offers rows without saying who is on them: the known feature, a real one, and a
      // song that merely has the words in its title.
      'api.deezer.com/search/track': { data: [DZ_TOP.data[4], guest(9001, 'VETERAN', { id: 7, name: 'Destroy Lonely' }, []), guest(9002, 'Ken Carson Tribute', { id: 8, name: 'Somebody Else' }, [])] },
      'api.deezer.com/track/9001': guest(9001, 'VETERAN', { id: 7, name: 'Destroy Lonely' }, [{ id: 7, name: 'Destroy Lonely' }, KC]),
      'api.deezer.com/track/9002': guest(9002, 'Ken Carson Tribute', { id: 8, name: 'Somebody Else' }, [{ id: 8, name: 'Somebody Else' }]),
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await w.artists.everySong(a);
    // Only the row Deezer's own contributors confirm, and only once: the known one is not repeated.
    expect(all.features.map((t) => t.title)).toEqual(['VETERAN']);
    expect(all.songs.map((t) => t.title)).not.toContain('VETERAN');
    expect(w.seen.filter((s) => s.url.includes('/track/2456173235'))).toHaveLength(0);
  });

  it('asks for no extra features when the artist has no Deezer page', async () => {
    const w = world({ ...FULL, 'api.deezer.com/search/artist': { data: [] } });
    const a = await w.artists.open({ id: `yt:${UC}`, name: 'Ken Carson' });
    const all = await w.artists.everySong(a);
    expect(all.features).toEqual([]);
    expect(w.seen.some((s) => s.url.includes('/search/track'))).toBe(false);
  });

  it('reads every page of the search, and confirms every candidate it finds', async () => {
    const KC = { id: 2568121, name: 'Ken Carson' };
    const guest = (id: number, lead: number, on: boolean) =>
      ({ id, title: `Guest ${id}`, title_short: `Guest ${id}`, artist: { id: lead, name: `Artist ${lead}` }, contributors: on ? [{ id: lead, name: `Artist ${lead}` }, KC] : [{ id: lead, name: `Artist ${lead}` }], album: { id: 77, title: 'Guest LP' }, duration: 100, link: `https://www.deezer.com/track/${id}`, readable: true, rank: 1 });
    // 60 candidates over three pages: more than one page, and more than a handful to confirm.
    const page = (from: number) => ({ data: Array.from({ length: 20 }, (_, i) => guest(from + i, 900 + from + i, true)), total: 60, next: from + 20 < 9061 ? `https://api.deezer.com/search/track?index=${from + 20}` : undefined });
    const tracks: Record<string, unknown> = {};
    for (let id = 9001; id < 9061; id++) tracks[`api.deezer.com/track/${id}`] = guest(id, 900 + id, id !== 9060);
    const w = world({
      ...FULL,
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=40': page(9041),
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=20': page(9021),
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100': page(9001),
      ...tracks,
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await w.artists.everySong(a);
    // Every page was asked for, every candidate read, and only the confirmed ones kept.
    expect(all.features).toHaveLength(59);
    expect(all.features.map((t) => t.title)).not.toContain('Guest 9060');
    expect(w.seen.filter((s) => s.url.includes('/search/track')).length).toBeGreaterThanOrEqual(3);
    expect(w.seen.filter((s) => /\/track\/90\d\d/.test(s.url))).toHaveLength(60);
  });
});

describe('features: the songs other artists have them on (ARTIST-FEATURES-001)', () => {
  const t = (title: string, artists: string[]) => ({ key: `k:${title}`, title, artist: artists.join(', '), artists }) as unknown as Track;

  it('takes a song whose first artist is someone else and which still names them', () => {
    const r = partitionFeatures(
      [t('overseas', ['Ken Carson']), t('Fell In Love', ['Lil Tecca', 'Ken Carson']), t('deaf note', ['KEN CARSON', 'Destroy Lonely'])],
      'Ken Carson',
    );
    expect(r.songs.map((x) => x.title)).toEqual(['overseas', 'deaf note']);
    expect(r.features.map((x) => x.title)).toEqual(['Fell In Love']);
  });

  it('leaves a row it cannot confirm in the most played, and keeps each list in its own order', () => {
    // Their top list can hold a song that names neither spelling of them; it is not called a feature.
    const r = partitionFeatures([t('Timeless', ['The Weeknd', 'Playboi Carti']), t('ss', ['Ken Carson']), t('Off The Meter', ['Playboi Carti', 'Ken Carson'])], 'ken carson');
    expect(r.songs.map((x) => x.title)).toEqual(['Timeless', 'ss']);
    expect(r.features.map((x) => x.title)).toEqual(['Off The Meter']);
    expect(partitionFeatures([t('x', [])], 'Ken Carson')).toEqual({ songs: [expect.objectContaining({ title: 'x' })], features: [] });
  });
});

describe('which artist a song opens', () => {
  it('uses the song\u2019s own artist id, and its first artist\u2019s name', () => {
    expect(artistTargetOf({ artists: ['Ken Carson', 'Destroy Lonely'], provider: 'deezer', artist_ids: { deezer: '2568121' } })).toEqual({ id: 'dz:2568121', name: 'Ken Carson' });
    expect(artistTargetOf({ artists: ['Ken Carson'], provider: 'ytmusic', artist_ids: { ytmusic: UC } })).toEqual({ id: `yt:${UC}`, name: 'Ken Carson' });
    expect(artistTargetOf({ artists: ['Ken Carson'], provider: 'soundcloud' })).toEqual({ name: 'Ken Carson' });
    expect(artistTargetOf({ artists: ['Unknown artist'], provider: 'soundcloud' })).toBeNull();
    expect(artistTargetOf({ artists: [], provider: 'soundcloud' })).toBeNull();
  });

  it('opens an artist named only by a song (SoundCloud) through an exact-name search', async () => {
    const { artists } = world(FULL);
    const a = await artists.open({ name: 'Ken Carson' });
    expect(a.id).toBe('dz:2568121');
    expect(a.songs.map((t) => t.title)).toContain('Fighting My Demons');
  });
});
