/**
 * ARTIST-PAGE-001. Owner: "can we add artist pages where we can see all of an artist songs and albums".
 * Bodies trimmed from live answers recorded 2026-11-10 (golden/dz-artist*.json, ytm-artist*.json).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Albums } from './albums';
import { Artists, parseDeezerArtists, parseYtArtistPage, parseYtArtistSearch, parseYtSongRows, parseYtDiscography, artistTargetOf, partitionFeatures, nextSearchIndex } from './artists';
import { Deezer } from './deezer';
import { YouTubeMusic, parseSearchSongsPage } from './ytmusic';
import { Http, HostPacer, Meter, type HttpPort, type HttpRequest } from './net';
import type { Track } from './track';
import type { Store } from './store';

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
// A real cache: a store that always misses could never show an incomplete answer being kept.
function mapStore() {
  const m = new Map<string, unknown>();
  return { m, store: { cacheGet: (k: string) => (m.has(k) ? { value: m.get(k), created: 0, stale: false } : null), cachePut: async (k: string, _kind: string, v: unknown) => void m.set(k, v) } as unknown as Store };
}

function world(routes: Record<string, unknown>, store?: Store, tap?: (req: HttpRequest) => unknown) {
  const seen: { url: string; body?: string }[] = [];
  const port: HttpPort = {
    // Waits between retries are not what these tests are about: they end at once.
    async delay() {},
    async request(req: HttpRequest) {
      // A tap may take its time: a promise is waited for, as a slow service would be.
      const tapped = await tap?.(req);
      // `{ __status: 403 }` from a tap is the service answering with that status.
      if (tapped && typeof tapped === 'object' && '__status' in tapped) return { status: Number((tapped as { __status: number }).__status), headers: {}, body: enc('{}') };
      if (tapped !== undefined) return { status: 200, headers: {}, body: enc(JSON.stringify(tapped)) };
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
  return { artists: new Artists(http, dz, yt, store, new Albums(http, dz, undefined, yt)), seen };
}

/** The requests of the name search itself; FEATURES-ALL-001 asks two more searches beside it. */
const named = (seen: { url: string }[]) => seen.filter((x) => x.url.includes('/search/track') && new URL(x.url).searchParams.get('q') === 'Ken Carson');

const FULL = {
  // FEATURES-ALL-001: the two extra feature searches find nothing unless a test gives them rows.
  'api.deezer.com/search/track?q=feat%20Ken%20Carson': { data: [] },
  'api.deezer.com/search/track?q=track%3A%22Ken%20Carson%22': { data: [] },
  'api.deezer.com/search/artist': DZ_SEARCH,
  'api.deezer.com/artist/2568121/top': DZ_TOP,
  'api.deezer.com/artist/2568121/albums': DZ_ALBUMS,
  'api.deezer.com/artist/2568121': DZ_ARTIST,
  // FEATURES-ALL-002: the songs search (asked for features) finds nothing unless a test gives it rows.
  'music.youtube.com/youtubei/v1/search#EgWKAQIIAWoMEA4QChADEAQQCRAF': {},
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
    expect(parseYtArtistPage(copy).more).toEqual([{ kind: 'albums', browseId: UC, params: 'ggMIegYIAxoCGAI%3D' }]);

    // DISCOGRAPHY-MORE-001. Measured 2026-11-16: the link now names the list by its own id, "MPAD" and
    // the artist's channel. Asked for under the channel id alone, YouTube Music answers the artist
    // page again, so the singles past the first ten were never listed.
    const link = shelf.musicCarouselShelfRenderer.header.musicCarouselShelfBasicHeaderRenderer.moreContentButton.buttonRenderer.navigationEndpoint.browseEndpoint;
    link.browseId = `MPAD${UC}`;
    expect(parseYtArtistPage(copy).more).toEqual([{ kind: 'albums', browseId: `MPAD${UC}`, params: 'ggMIegYIAxoCGAI%3D' }]);
    // A link to anything that is not this artist's own list is not followed.
    link.browseId = 'MPADUCbbbbbbbbbbbbbbbbbbbbbb';
    expect(parseYtArtistPage(copy, UC).more).toEqual([]);
    link.browseId = 'VLOLAK5uy_ndKAxiDLpQ_SjzkCc7BP09MEEIhDl9NRc';
    expect(parseYtArtistPage(copy, UC).more).toEqual([]);

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

describe('a leading "The" does not hide an artist (ARTIST-ARTICLE-001)', () => {
  // Owner report 2026-11-17: "The Jackson 5" opened a page saying neither Deezer nor YouTube Music
  // has one. Measured: Deezer's artist search answers "Jackson 5" (1,622,220 fans), "The Jackson
  // 5ive", "The Jacksons", "The Jackson Five"... and song credits say "The Jackson 5". Exact
  // folding rejected all of them. An exact name still wins; only without one may the article go.
  const j5 = { id: 75332, type: 'artist', name: 'Jackson 5', nb_fan: 1622220, picture_big: null, link: 'https://www.deezer.com/artist/75332' };
  const ive = { id: 7012135, type: 'artist', name: 'The Jackson 5ive', nb_fan: 5306, picture_big: null, link: 'https://www.deezer.com/artist/7012135' };
  const jacksons = { id: 980, type: 'artist', name: 'The Jacksons', nb_fan: 907383, picture_big: null, link: 'https://www.deezer.com/artist/980' };
  const song = { id: 1, title: 'ABC', duration: 180, artist: { id: 75332, name: 'Jackson 5' }, album: { id: 5, title: 'ABC' }, contributors: [{ id: 75332, name: 'Jackson 5' }] };
  const routes = {
    'api.deezer.com/search/artist': { data: [j5, ive, jacksons] },
    'api.deezer.com/artist/75332/top': { data: [song] },
    'api.deezer.com/artist/75332/albums': { data: [] },
    'api.deezer.com/artist/75332': j5,
  };
  it('opens "Jackson 5" for "The Jackson 5", not a lookalike', async () => {
    const { artists } = world(routes);
    const v = await artists.open({ name: 'The Jackson 5' });
    expect(v.links.deezer).toContain('75332');
    expect(v.songs.map((t) => t.title)).toEqual(['ABC']);
  });
  it('also reads "Jackson 5, The" as the same name', async () => {
    const { artists } = world(routes);
    const v = await artists.open({ name: 'Jackson 5, The' });
    expect(v.links.deezer).toContain('75332');
  });
  it('still prefers an exact name over an article-only match', async () => {
    const exactThe = { ...j5, id: 4242, name: 'The Jackson 5', nb_fan: 10, link: 'https://www.deezer.com/artist/4242' };
    const { artists } = world({ ...routes, 'api.deezer.com/search/artist': { data: [j5, exactThe] }, 'api.deezer.com/artist/4242/top': { data: [] }, 'api.deezer.com/artist/4242/albums': { data: [] }, 'api.deezer.com/artist/4242': exactThe });
    const v = await artists.open({ name: 'The Jackson 5' });
    expect(v.links.deezer).toContain('4242');
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
    // Deezer's own next link is followed, whatever page size it answers (here 20 rows, not the 100 asked).
    const page = (from: number) => ({ data: Array.from({ length: 20 }, (_, i) => guest(from + i, 900 + from + i, true)), total: 60, ...(from + 20 < 9061 ? { next: `https://api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=${from + 20 - 9001}` } : {}) });
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
    expect(named(w.seen).map((s) => new URL(s.url).searchParams.get('index'))).toEqual([null, '20', '40']);
    expect(w.seen.filter((s) => /\/track\/90\d\d/.test(s.url))).toHaveLength(60);
    expect(all.featuresComplete).toBe(true);
  });

  it('asks Deezer as the app, so a provider that ranks by client identity answers every shell the same (DEEZER-UA-001)', async () => {
    // A FAKE provider, standing in for the observed behaviour (not a claim about Deezer itself): page two
    // carries one more confirmed guest only for the app's own User-Agent.
    const KC = { id: 2568121, name: 'Ken Carson' };
    const g = (id: number) => ({ id, title: `Guest ${id}`, title_short: `Guest ${id}`, artist: { id: 7, name: 'Lead' }, contributors: [{ id: 7, name: 'Lead' }, KC], album: { id: 77, title: 'Guest LP' }, duration: 100, link: `https://www.deezer.com/track/${id}`, readable: true, rank: 1 });
    const uas: (string | undefined)[] = [];
    const w = world({ ...FULL, 'api.deezer.com/track/9501': g(9501), 'api.deezer.com/track/9502': g(9502) }, undefined, (req) => {
      const u = new URL(req.url);
      if (u.pathname !== '/search/track') return undefined;
      if (u.searchParams.get('q') !== 'Ken Carson') return { data: [] };
      const agent = Object.entries(req.headers ?? {}).find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
      uas.push(agent);
      if (u.searchParams.get('index') === '1') return { data: agent === 'AirwaveDiscovery/0.18.13' ? [g(9502)] : [] };
      return { data: [g(9501)], next: 'https://api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=1' };
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await w.artists.everySong(a);
    expect(all.features.map((t) => t.title)).toEqual(['Guest 9501', 'Guest 9502']);
    expect(all.featuresComplete).toBe(true);
    expect(uas).toEqual(['AirwaveDiscovery/0.18.13', 'AirwaveDiscovery/0.18.13']);
  });

  it('versions the artist caches so an answer kept under an older request identity is not served (DEEZER-UA-001)', async () => {
    const KC = { id: 2568121, name: 'Ken Carson' };
    const g = (id: number) => ({ id, title: `Guest ${id}`, title_short: `Guest ${id}`, artist: { id: 7, name: 'Lead' }, contributors: [{ id: 7, name: 'Lead' }, KC], album: { id: 77, title: 'Guest LP' }, duration: 100, link: `https://www.deezer.com/track/${id}`, readable: true, rank: 1 });
    const kept = mapStore();
    // What an earlier build kept: a fresh, "complete" songs answer and an artist view, both under the old keys.
    const old = { songs: [], features: [], opened: 0, failed: 0, featuresComplete: true };
    for (let n = 0; n < 40; n++) kept.m.set(`artistsongs3:dz:2568121:${n}`, old);
    kept.m.set('artistview:2568121::ken carson', { id: 'dz:2568121', name: 'Old', songs: [], features: [], albums: [], singles: [], links: {} });
    const w = world({ ...FULL, 'api.deezer.com/search/track': { data: [g(9601)] }, 'api.deezer.com/track/9601': g(9601) }, kept.store);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect(a.name).toBe('Ken Carson');
    const all = await w.artists.everySong(a);
    expect(all.features.map((t) => t.title)).toEqual(['Guest 9601']);
    expect([...kept.m.keys()].some((k) => k.startsWith('artistsongs4:dz:2568121:'))).toBe(true);
    // artistview3: the view also says what each service gave (ARTIST-SOURCES-001). artistview4: its
    // YouTube Music shelves are read whole, by the list's own id (DISCOGRAPHY-MORE-001).
    expect([...kept.m.keys()].some((k) => k.startsWith('artistview4:2568121:'))).toBe(true);
    // Only the artist namespaces moved: the old rows are left for the store's own expiry, not wiped.
    expect(kept.m.get('artistsongs3:dz:2568121:21')).toBe(old);
  });

  it('keeps the features already confirmed when a later search page fails, and says the list is incomplete', async () => {
    const KC = { id: 2568121, name: 'Ken Carson' };
    const OTHER_KC = { id: 555, name: 'Ken Carson' };
    const t = (id: number, lead: { id: number; name: string }, contributors: { id: number; name: string }[], title = `Guest ${id}`) =>
      ({ id, title, title_short: title, artist: lead, contributors, album: { id: 77, title: 'Guest LP' }, duration: 100 + (id % 50), link: `https://www.deezer.com/track/${id}`, readable: true, rank: 1 });
    // Page one: 25 rows led by others with Ken Carson credited (more than ten, more than one fold).
    const p1 = Array.from({ length: 25 }, (_, i) => t(9100 + i, { id: 100 + i, name: `Lead ${i}` }, [{ id: 100 + i, name: `Lead ${i}` }, KC]));
    // Page two: a second lead artist crediting him; a namesake who is not him; a title that only names him;
    // and a row already seen on page one.
    const p2 = [
      t(9200, { id: 7, name: 'Destroy Lonely' }, [{ id: 7, name: 'Destroy Lonely' }, { id: 8, name: 'Homixide Gang' }, KC]),
      t(9201, OTHER_KC, [OTHER_KC]),
      t(9202, { id: 9, name: 'Somebody' }, [{ id: 9, name: 'Somebody' }], 'Ken Carson Type Beat'),
      p1[0]!,
    ];
    const tracks: Record<string, unknown> = {};
    for (const r of [...p1, ...p2]) tracks[`api.deezer.com/track/${r.id}`] = r;
    const w = world({
      ...FULL,
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=29': { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } },
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=25': { data: p2, total: 40, next: 'https://api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=29' },
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100': { data: p1, total: 40, next: 'https://api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=25' },
      ...tracks,
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await w.artists.everySong(a);
    const titles = all.features.map((x) => x.title);
    expect(titles).toHaveLength(26);
    expect(titles).toContain('Guest 9200');
    expect(titles).not.toContain('Guest 9201');
    expect(titles).not.toContain('Ken Carson Type Beat');
    expect(new Set(all.features.map((x) => x.key)).size).toBe(26);
    const f = all.features.find((x) => x.title === 'Guest 9200')!;
    // The exact recording: its lead, its full credits as Deezer lists them, and its own length.
    expect([f.artists[0], f.artist, f.duration]).toEqual(['Destroy Lonely', 'Destroy Lonely, Homixide Gang, Ken Carson', 100 + (9200 % 50)]);
    expect(all.featuresComplete).toBe(false);
  });

  it('never fetches a next link that is not a later page of the same Deezer search, and keeps an incomplete answer out of the cache', async () => {
    const KC = { id: 2568121, name: 'Ken Carson' };
    const g = (id: number) => ({ id, title: `Guest ${id}`, title_short: `Guest ${id}`, artist: { id: 7, name: 'Lead' }, contributors: [{ id: 7, name: 'Lead' }, KC], album: { id: 77, title: 'Guest LP' }, duration: 100, link: `https://www.deezer.com/track/${id}`, readable: true, rank: 1 });
    const evil = 'https://evil.example/search/track?q=Ken%20Carson&index=20';
    const inc = mapStore();
    const m = inc.m;
    const kept = mapStore();
    const w = world({
      ...FULL,
      // Page two points back at itself: a repeated cursor ends the walk instead of looping.
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=20': { data: [g(9302)], next: 'https://api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=20' },
      'api.deezer.com/search/track?q=Ken%20Carson&limit=100': { data: [g(9301)], next: 'https://api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=20' },
      'evil.example': { data: [g(9399)] },
      'api.deezer.com/track/9301': g(9301),
      'api.deezer.com/track/9302': g(9302),
      'api.deezer.com/track/9399': g(9399),
    }, inc.store);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const first = await w.artists.everySong(a);
    expect(first.features.map((t) => t.title)).toEqual(['Guest 9301', 'Guest 9302']);
    expect(first.featuresComplete).toBe(false);
    expect(named(w.seen)).toHaveLength(2);
    expect(w.seen.some((s) => s.url.includes('evil.example'))).toBe(false);
    // Incomplete, so not kept: the next look asks Deezer again.
    await w.artists.everySong(a);
    expect(named(w.seen)).toHaveLength(4);
    expect([...m.keys()].some((k) => k.startsWith('artistsongs'))).toBe(false);
    // Positive control: a complete answer (one page, no next link) is kept, and the second look is served from it.
    const w2 = world({ ...FULL, 'api.deezer.com/search/track': { data: [g(9301)] }, 'api.deezer.com/track/9301': g(9301) }, kept.store);
    const b = await w2.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect((await w2.artists.everySong(b)).featuresComplete).toBe(true);
    await w2.artists.everySong(b);
    expect(named(w2.seen)).toHaveLength(1);
    expect([...kept.m.keys()].some((k) => k.startsWith('artistsongs4:'))).toBe(true);
    // Only Deezer's own search, on this query, with a plain index, is a page of it.
    expect(nextSearchIndex(evil, 'Ken Carson')).toBeNull();
    expect(nextSearchIndex('http://api.deezer.com/search/track?q=Ken%20Carson&index=20', 'Ken Carson')).toBeNull();
    expect(nextSearchIndex('https://api.deezer.com/search/track?q=Somebody&index=20', 'Ken Carson')).toBeNull();
    expect(nextSearchIndex('https://api.deezer.com/track/1?q=Ken%20Carson&index=20', 'Ken Carson')).toBeNull();
    expect(nextSearchIndex('https://api.deezer.com/search/track?q=Ken%20Carson&index=20x', 'Ken Carson')).toBeNull();
    expect(nextSearchIndex('https://api.deezer.com/search/track?q=Ken%20Carson&limit=100&index=20', 'Ken Carson')).toBe(20);
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

/**
 * ARTIST-SOURCES-001. Owner: "when opening an artist page dont just list deezer, list all the different
 * platforms / sources the artist information is coming from". The page says what each service gave,
 * and a service that was not read says why, so the engine has to carry both.
 */
describe('what each service gave, and why one was not read (ARTIST-SOURCES-001)', () => {
  it('says which service the picture and the audience figure came from', async () => {
    const a = await world(FULL).artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect(a.picture).toBeTruthy();
    expect(a.sources['deezer']!.gave).toEqual(['picture']);
    expect(a.sources['ytmusic']!.gave).toEqual(['audience']);
  });
  it('says one service could not be reached while the other still answers', async () => {
    const yt = Object.fromEntries(Object.entries(FULL).filter(([k]) => k.startsWith('music.youtube.com')));
    const { artists } = world(yt, undefined, (req) => { if (req.url.includes('api.deezer.com')) throw new Error('getaddrinfo ENOTFOUND api.deezer.com'); return undefined; });
    const a = await artists.open({ name: 'Ken Carson' });
    expect(a.sources['deezer']).toMatchObject({ state: 'failed', why: 'offline' });
    expect(a.sources['ytmusic']).toMatchObject({ state: 'ok', gave: ['picture', 'audience'] });
  });
  it('says the allowance is used up when that is why neither service was read', async () => {
    const { artists } = world(FULL);
    const spent = new Meter(6_000_000, 0);
    await expect(artists.open({ name: 'Ken Carson' }, { meter: spent })).rejects.toMatchObject({
      sources: { deezer: { state: 'failed', why: 'allowance' }, ytmusic: { state: 'failed', why: 'allowance' } },
    });
  });
  it('says neither has a page only when both answered and had none', async () => {
    const { artists } = world({ 'api.deezer.com/search/artist': { data: [] }, 'music.youtube.com/youtubei/v1/search#': {} });
    await expect(artists.open({ name: 'jackiegalama' })).rejects.toMatchObject({ sources: { deezer: { state: 'none' }, ytmusic: { state: 'none' } } });
  });
});

describe('every feature Deezer can be asked for (FEATURES-ALL-001)', () => {
  const KC = { id: 2568121, name: 'Ken Carson' };
  const g = (id: number, title = `Guest ${id}`, on = true) =>
    ({ id, title, title_short: title, artist: { id: 7, name: 'Lead' }, contributors: on ? [{ id: 7, name: 'Lead' }, KC] : [{ id: 7, name: 'Lead' }], album: { id: 77, title: 'Guest LP' }, duration: 100, link: `https://www.deezer.com/track/${id}`, readable: true, rank: 1 });
  const FEAT = 'api.deezer.com/search/track?q=feat%20Ken%20Carson';
  const TITLED = 'api.deezer.com/search/track?q=track%3A%22Ken%20Carson%22';
  const PLAIN = 'api.deezer.com/search/track?q=Ken%20Carson';

  it('rechecks displayed songs against official track contributor IDs rather than skipping them', async () => {
    const w = world({ ...FULL, [PLAIN]: { data: [g(9781)] }, 'api.deezer.com/track/9781': g(9781) });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const displayed = new Deezer({} as Http).toTrack(g(9781));
    const found = await w.artists.everyFeature({ ...a, songs: [...a.songs, displayed] });
    expect(found.features.some(t => t.platform_id === '9781')).toBe(true);
  });

  it('does not cache missing contributor data as proof the artist is absent', async () => {
    const kept = mapStore(); const partial = { ...g(9782), contributors: undefined };
    const w = world({ ...FULL, [PLAIN]: { data: [g(9782)] }, 'api.deezer.com/track/9782': partial }, kept.store);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect((await w.artists.everyFeature(a)).complete).toBe(false);
    const w2 = world({ ...FULL, [PLAIN]: { data: [g(9782)] }, 'api.deezer.com/track/9782': g(9782) }, kept.store);
    expect((await w2.artists.everyFeature(a)).features.some(t => t.platform_id === '9782')).toBe(true);
  });

  it('rejects a misleading search lead when the official track identifies the target as lead artist', async () => {
    const full = { ...g(9783), artist: KC };
    const w = world({ ...FULL, [PLAIN]: { data: [g(9783)] }, 'api.deezer.com/track/9783': full });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect((await w.artists.everyFeature(a)).features.some(t => t.platform_id === '9783')).toBe(false);
  });

  it('asks three ways, because the name search alone leaves features out', async () => {
    // Measured on Deezer for one artist: the name search confirmed 54 features, and asking for
    // "feat <name>" and for the name in a song's title confirmed 35 more.
    const w = world({
      ...FULL,
      [FEAT]: { data: [g(9701), g(9702, 'On the feat search')] },
      [TITLED]: { data: [g(9702, 'On the feat search'), g(9703, 'Song (feat. Ken Carson)'), g(9704, 'Ken Carson Type Beat', false)] },
      [PLAIN]: { data: [g(9701)] },
      'api.deezer.com/track/9701': g(9701),
      'api.deezer.com/track/9702': g(9702, 'On the feat search'),
      'api.deezer.com/track/9703': g(9703, 'Song (feat. Ken Carson)'),
      'api.deezer.com/track/9704': g(9704, 'Ken Carson Type Beat', false),
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    // Each once, the name search's first, and never the row that only has the words in its title.
    expect(found.features.map((t) => t.title)).toEqual(['Guest 9701', 'On the feat search', 'Song (feat. Ken Carson)']);
    expect(found.complete).toBe(true);
    expect(w.seen.filter((x) => x.url.includes('/search/track')).map((x) => new URL(x.url).searchParams.get('q'))).toEqual(['Ken Carson', 'feat Ken Carson', 'track:"Ken Carson"']);
    // One read each, however many of the searches offered the row.
    expect(w.seen.filter((x) => /\/track\/970\d/.test(x.url))).toHaveLength(4);
  });

  it('says the list is incomplete when one of the three cannot be asked, and keeps what the others found', async () => {
    const kept = mapStore();
    const routes: Record<string, unknown> = { ...FULL, [PLAIN]: { data: [g(9711)] }, 'api.deezer.com/track/9711': g(9711) };
    delete routes[TITLED];
    const w = world(routes, kept.store);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(found.features.map((t) => t.title)).toEqual(['Guest 9711']);
    expect(found.complete).toBe(false);
    // Not kept, so the next look asks again; a complete answer is kept.
    expect([...kept.m.keys()].some((k) => k.startsWith('artistfeats'))).toBe(false);
    const w2 = world({ ...FULL, [PLAIN]: { data: [g(9711)] }, 'api.deezer.com/track/9711': g(9711) }, kept.store);
    expect((await w2.artists.everyFeature(a)).complete).toBe(true);
    const asked = w2.seen.length;
    await w2.artists.everyFeature(a);
    expect(w2.seen.length).toBe(asked);
  });

  it('lists the songs without waiting for the features when asked to', async () => {
    const w = world({ ...FULL, [PLAIN]: { data: [g(9721)] }, 'api.deezer.com/track/9721': g(9721) });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await w.artists.everySong(a, {}, { features: false });
    expect(all.songs.length).toBeGreaterThan(0);
    expect(all.features).toEqual([]);
    expect(w.seen.some((x) => x.url.includes('/search/track'))).toBe(false);
    expect(w.seen.some((x) => x.url.includes('/track/9721'))).toBe(false);
  });

  it('asks for nothing when the artist has no Deezer page', async () => {
    const w = world({ ...FULL, 'api.deezer.com/search/artist': { data: [] } });
    const a = await w.artists.open({ id: `yt:${UC}`, name: 'Ken Carson' });
    expect(await w.artists.everyFeature(a)).toEqual({ features: [], complete: true });
    expect(w.seen.some((x) => x.url.includes('/search/track'))).toBe(false);
  });

  it('never puts a quote from a name into the title search', async () => {
    const w = world({ ...FULL, 'api.deezer.com/search/track': { data: [] } });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    await w.artists.everyFeature({ ...a, name: 'Ken "KC" Carson' });
    const qs = w.seen.filter((x) => x.url.includes('/search/track')).map((x) => new URL(x.url).searchParams.get('q'));
    expect(qs[2]).toBe('track:"Ken KC Carson"');
  });
});

/**
 * FEATURES-ALL-002. Owner: "the artist page only loads like 8 features, ensure it loads all pages".
 *
 * Measured 2026-11-16 through the app's own engine. Deezer confirmed 5 features for Guri Lahoria; a
 * YouTube Music songs search for the same name, read to its end, held 9 songs other artists lead that
 * link this artist's own channel. The app never asked YouTube Music for features at all, and its
 * search answers 20 rows a page: features were found as far down as page 12.
 */
describe('features from YouTube Music too, every page (FEATURES-ALL-002)', () => {
  const OTHER = 'UCbbbbbbbbbbbbbbbbbbbbbb';
  const link = (name: string, id: string) => ({ text: name, navigationEndpoint: { browseEndpoint: { browseId: id } } });
  /** A search row as YouTube Music sends it: title with its video, then the linked artists. */
  const yrow = (vid: string, title: string, artists: [string, string][]) => ({
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title, navigationEndpoint: { watchEndpoint: { videoId: vid } } }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [...artists.flatMap(([n, id], i) => [...(i ? [{ text: ' & ' }] : []), link(n, id)]), { text: ' \u2022 ' }, { text: '3:01' }] } } },
      ],
    },
  });
  const own = (n: number) => yrow(`own${String(n).padStart(8, '0')}`, `Own ${n}`, [['Ken Carson', UC]]);
  const guest = (vid: string, title: string, lead = 'Lead') => yrow(vid, title, [[lead, OTHER], ['Ken Carson', UC]]);
  const stranger = (n: number) => yrow(`str${String(n).padStart(8, '0')}`, `Ken Carson type beat ${n}`, [['Someone', OTHER]]);
  const TOKEN = (q: string, p: number) => `tok${p}${'x'.repeat(24)}${q.startsWith('feat') ? 'F' : 'N'}`;
  const first = (rows: unknown[], next: string | null) => ({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: rows, ...(next ? { continuations: [{ nextContinuationData: { continuation: next } }] } : {}) } }] } } } }] } } });
  const later = (rows: unknown[], next: string | null) => ({ continuationContents: { musicShelfContinuation: { contents: rows, ...(next ? { continuations: [{ nextContinuationData: { continuation: next } }] } : {}) } } });

  /** A world whose YouTube Music songs search answers `pages[query][n]`; everything else as FULL. */
  function ytWorld(pages: Record<string, unknown[][]>, routes: Record<string, unknown> = {}, fail: (q: string, page: number) => boolean = () => false, refuse: (url: string) => boolean = () => false, slow: (q: string, page: number) => boolean = () => false) {
    const asked: string[] = [];
    const count = { plain: 0 };
    let urls: string[] | null = null;
    const kept = mapStore();
    const w = world({ ...FULL, 'api.deezer.com/search/track?q=Ken%20Carson': { data: [] }, ...routes }, kept.store, (req) => {
      if (!req.url.includes('/youtubei/v1/search')) return undefined;
      const b = JSON.parse(typeof req.body === 'string' ? req.body : new TextDecoder().decode(req.body as unknown as Uint8Array)) as Record<string, unknown>;
      // The artists tab of a search is not the songs search: left to the routes.
      if (typeof b['query'] === 'string' && b['params'] !== 'EgWKAQIIAWoMEA4QChADEAQQCRAF') return undefined;
      urls?.push(req.url);
      if (refuse(req.url)) throw new Error('400');
      const token = typeof b['continuation'] === 'string' ? b['continuation'] : null;
      const q = token ? (token.endsWith('F') ? 'feat Ken Carson' : 'Ken Carson') : String(b['query']);
      const n = token ? Number(/^tok(\d+)/.exec(token)![1]) : 0;
      if (!new URL(req.url).searchParams.has('fields')) count.plain += 1;
      if (slow(q, n)) return { __status: 403 };
      asked.push(`${q}#${n}`);
      if (fail(q, n)) throw new Error('YouTube Music is down');
      const list = pages[q] ?? [[]];
      const rows = list[n] ?? [];
      const next = n + 1 < list.length ? TOKEN(q, n + 1) : null;
      return n === 0 ? first(rows, next) : later(rows, next);
    });
    return { ...w, asked, m: kept.m, tapUrls: (into: string[]) => { urls = into; }, get plain() { return count.plain; } };
  }

  it('reads a songs search row by row, first page or a later one, with every linked artist', () => {
    const a = parseSearchSongsPage(first([guest('gst00000001', 'On the first page'), own(1)], 'tok1' + 'x'.repeat(24)));
    expect(a.items.map((x) => [x.title, x.artists.map((y) => y.id)])).toEqual([['On the first page', [OTHER, UC]], ['Own 1', [UC]]]);
    expect(a.next).toBe('tok1' + 'x'.repeat(24));
    const b = parseSearchSongsPage(later([guest('gst00000002', 'On a later page')], null));
    expect(b.items.map((x) => x.videoId)).toEqual(['gst00000002']);
    expect(b.next).toBeNull();
    expect(parseSearchSongsPage({})).toEqual({ items: [], next: null });
  });

  it('adds the songs other artists lead that link this artist\u2019s own channel, from every page', async () => {
    const w = ytWorld({
      'Ken Carson': [[own(1), own(2)], [guest('gst00000001', 'Second page guest'), own(3)], [own(4)], [guest('gst00000002', 'Fourth page guest', 'Another')]],
      'feat Ken Carson': [[guest('gst00000001', 'Second page guest'), guest('gst00000003', 'Only on the feat search')]],
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(found.features.filter((t) => t.provider === 'ytmusic').map((t) => t.title)).toEqual(['Second page guest', 'Fourth page guest', 'Only on the feat search']);
    expect(found.features.find((t) => t.title === 'Fourth page guest')!.artists).toEqual(['Another', 'Ken Carson']);
    expect(found.complete).toBe(true);
    expect(w.asked.filter((x) => x.startsWith('Ken Carson#'))).toEqual(['Ken Carson#0', 'Ken Carson#1', 'Ken Carson#2', 'Ken Carson#3']);
  });

  it('never claims a row that only has the name in its words, or one this artist leads', async () => {
    const w = ytWorld({ 'Ken Carson': [[stranger(1), own(1), yrow('nam00000001', 'By a namesake', [['Lead', OTHER], ['Ken Carson', 'UCcccccccccccccccccccccc']])]], 'feat Ken Carson': [[]] });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    expect((await w.artists.everyFeature(a)).features.filter((t) => t.provider === 'ytmusic')).toEqual([]);
  });

  it('lists a song once when Deezer and YouTube Music both have it', async () => {
    const dzGuest = { id: 9801, title: 'Both Have It (feat. Ken Carson)', title_short: 'Both Have It', artist: { id: 7, name: 'Lead' }, contributors: [{ id: 7, name: 'Lead' }, { id: 2568121, name: 'Ken Carson' }], album: { id: 77, title: 'LP' }, duration: 100, link: 'https://www.deezer.com/track/9801' };
    const w = ytWorld(
      { 'Ken Carson': [[guest('gst00000001', 'Both Have It'), guest('gst00000002', 'YouTube only')]], 'feat Ken Carson': [[]] },
      { 'api.deezer.com/search/track?q=Ken%20Carson': { data: [dzGuest] }, 'api.deezer.com/track/9801': dzGuest },
    );
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(found.features.map((t) => [t.title, t.provider])).toEqual([['Both Have It (feat. Ken Carson)', 'deezer'], ['YouTube only', 'ytmusic']]);
  });

  it('follows all continuation pages even after a quiet run so later official credits are not lost', async () => {
    const quiet = Array.from({ length: 12 }, (_, i) => [stranger(i)]);
    const w = ytWorld({ 'Ken Carson': [[guest('gst00000001', 'Early guest')], ...quiet, [guest('gst00000002', 'Late credited guest')]], 'feat Ken Carson': [[]] });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(found.features.filter((t) => t.provider === 'ytmusic').map((t) => t.title)).toEqual(['Early guest', 'Late credited guest']);
    expect(w.asked.filter((x) => x.startsWith('Ken Carson#'))).toHaveLength(14);
    expect(found.complete).toBe(true);
  });

  it('keeps what was found when a page fails, says the list is incomplete, and does not keep that answer', async () => {
    const w = ytWorld({ 'Ken Carson': [[guest('gst00000001', 'Before the failure')], [guest('gst00000002', 'Never read')]], 'feat Ken Carson': [[]] }, {}, (q, n) => q === 'Ken Carson' && n === 1);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(found.features.filter((t) => t.provider === 'ytmusic').map((t) => t.title)).toEqual(['Before the failure']);
    expect(found.complete).toBe(false);
    expect([...w.m.keys()].some((k) => k.startsWith('artistfeats'))).toBe(false);
  });

  it('asks YouTube Music only for the parts of a page it reads', async () => {
    // Measured: a songs search page counted 692 KB against the day's allowance as it was asked for,
    // and 54 KB with the parts named. Twenty-five pages is 1.3 MB instead of 17 MB.
    const urls: string[] = [];
    const w = ytWorld({ 'Ken Carson': [[own(1)], [guest('gst00000001', 'Second page guest')]], 'feat Ken Carson': [[]] });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    w.tapUrls(urls);
    await w.artists.everyFeature(a);
    expect(urls.length).toBeGreaterThan(2);
    for (const u of urls) {
      const q = new URL(u).searchParams;
      expect(q.get('prettyPrint')).toBe('false');
      const fields = q.get('fields') ?? '';
      // Both shapes a page comes in, and everything a row is read from.
      for (const part of ['tabbedSearchResultsRenderer', 'musicShelfContinuation', 'continuations', 'flexColumns', 'fixedColumns', 'watchEndpoint', 'thumbnail', 'badges']) expect(fields, part).toContain(part);
    }
  });

  it('asks again for the whole page when the short form is refused', async () => {
    let refused = 0;
    const w = ytWorld({ 'Ken Carson': [[guest('gst00000001', 'Still found')]], 'feat Ken Carson': [[]] }, {}, () => false, (url) => {
      if (!new URL(url).searchParams.has('fields')) return false;
      refused += 1;
      return true;
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(refused).toBeGreaterThan(0);
    expect(found.features.filter((t) => t.provider === 'ytmusic').map((t) => t.title)).toEqual(['Still found']);
    expect(found.complete).toBe(true);
  });

  it('waits and asks again when YouTube Music says to slow down, instead of giving the page up', async () => {
    // Measured 2026-11-16: paged quickly, the songs search answers 403 now and then; the same
    // request 700 ms later answers. Before, that one 403 ended the search and left the list short.
    let refusals = 2;
    const w = ytWorld({ 'Ken Carson': [[guest('gst00000001', 'After the wait')]], 'feat Ken Carson': [[]] }, {}, () => false, () => false, (q, n) => q === 'Ken Carson' && n === 0 && refusals-- > 0);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(found.features.filter((t) => t.provider === 'ytmusic').map((t) => t.title)).toEqual(['After the wait']);
    expect(found.complete).toBe(true);
    expect(refusals).toBeLessThan(1);
  });

  it('says the list is incomplete when YouTube Music keeps refusing a page', async () => {
    const w = ytWorld({ 'Ken Carson': [[guest('gst00000001', 'Never read')]], 'feat Ken Carson': [[guest('gst00000002', 'Still found')]] }, {}, () => false, () => false, (q) => q === 'Ken Carson');
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const found = await w.artists.everyFeature(a);
    expect(found.features.filter((t) => t.provider === 'ytmusic').map((t) => t.title)).toEqual(['Still found']);
    expect(found.complete).toBe(false);
    // The page as it is asked for in full is no remedy for "slow down": it is not asked for.
    expect(w.plain).toBe(0);
  });

  it('asks YouTube Music for an artist Deezer does not have', async () => {
    const w = ytWorld({ 'Ken Carson': [[guest('gst00000001', 'YouTube Music guest')]], 'feat Ken Carson': [[]] }, { 'api.deezer.com/search/artist': { data: [] } });
    const a = await w.artists.open({ id: `yt:${UC}` });
    const found = await w.artists.everyFeature(a);
    expect(found.features.map((t) => t.title)).toEqual(['YouTube Music guest']);
    expect(w.seen.some((x) => x.url.includes('api.deezer.com/search/track'))).toBe(false);
  });
});

/**
 * FEATURES-FLOW-001. Owner: "ensure features and artist discography information loads, ensure
 * everything loads as seamless as possible".
 *
 * Measured 2026-11-16: a full look for features took 23 to 52 seconds (Deezer allows about nine reads
 * a second, and each candidate is one read), and the page showed none of them until the last one was
 * in. The look can now be taken a few seconds at a time: each step gives everything confirmed so far.
 */
describe('features a little at a time (FEATURES-FLOW-001)', () => {
  const guest = (id: number, title: string) => ({ id, title, title_short: title, artist: { id: 7, name: 'Lead' }, contributors: [{ id: 7, name: 'Lead' }, { id: 2568121, name: 'Ken Carson' }], album: { id: 77, title: 'LP' }, duration: 100, link: `https://www.deezer.com/track/${id}` });
  const stranger = (id: number) => ({ ...guest(id, `Not Theirs ${id}`), contributors: [{ id: 7, name: 'Lead' }] });
  const guests = Array.from({ length: 8 }, (_, i) => guest(9801 + i, `Guest ${i + 1}`));
  const routesFor = (rows: { id: number }[]) => ({ ...FULL, 'api.deezer.com/search/track?q=Ken%20Carson': { data: rows }, ...Object.fromEntries(rows.map((g) => [`api.deezer.com/track/${g.id}`, g])) });
  const reads = (seen: { url: string }[]) => seen.filter((x) => /\/track\/\d+$/.test(x.url)).length;

  it('gives what is confirmed so far at each step, and never moves or drops a row it has given', async () => {
    const w = world(routesFor(guests), mapStore().store);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const look = w.artists.featureLook(a);
    const steps: { features: Track[]; complete: boolean; more: boolean }[] = [];
    do { steps.push(await look.step({}, 0)); } while (steps[steps.length - 1]!.more && steps.length < 40);
    expect(steps.length).toBeGreaterThan(1);
    // The first step already has some, and not yet all.
    expect(steps[0]!.features.length).toBeGreaterThan(0);
    expect(steps[0]!.features.length).toBeLessThan(guests.length);
    for (let i = 1; i < steps.length; i++) {
      const before = steps[i - 1]!.features.map((t) => t.key);
      expect(steps[i]!.features.slice(0, before.length).map((t) => t.key)).toEqual(before);
    }
    const last = steps[steps.length - 1]!;
    expect(last.more).toBe(false);
    expect(last.complete).toBe(true);
    expect(last.features.map((t) => t.title).sort()).toEqual(guests.map((g) => g.title).sort());
  });

  it('gives the same list in one go as it does in steps', async () => {
    const whole = world(routesFor(guests), mapStore().store);
    const a = await whole.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const all = await whole.artists.everyFeature(a);
    expect(all.features.map((t) => t.title)).toEqual(guests.map((g) => g.title));
    expect(all.complete).toBe(true);
  });

  it('keeps a whole answer, and gives it at once the next time', async () => {
    const kept = mapStore();
    const w = world(routesFor(guests), kept.store);
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    await w.artists.everyFeature(a);
    const asked = w.seen.length;
    const again = await w.artists.featureLook(a).step({}, 0);
    expect(again.more).toBe(false);
    expect(again.features).toHaveLength(guests.length);
    expect(w.seen.length).toBe(asked);
  });

  it('answers on time when a service is holding a request, and has that service\u2019s rows the next time', async () => {
    // Measured 2026-11-16: YouTube Music now and then holds a search page six to nine seconds. A
    // step lasted as long as its slowest request (12.9 s and 19.5 s were seen for a 2.5 s step), so
    // the page sat with nothing new on it. The step now answers when its time is up.
    const OTHER = 'UCbbbbbbbbbbbbbbbbbbbbbb';
    const link = (name: string, id: string) => ({ text: name, navigationEndpoint: { browseEndpoint: { browseId: id } } });
    const ytRow = { musicResponsiveListItemRenderer: { flexColumns: [
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Held Back', navigationEndpoint: { watchEndpoint: { videoId: 'held0000001' } } }] } } },
      { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [link('Lead', OTHER), { text: ' & ' }, link('Ken Carson', UC), { text: ' \u2022 ' }, { text: '3:01' }] } } },
    ] } };
    const shelf = { contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [ytRow] } }] } } } }] } } };
    const w = world(routesFor(guests.slice(0, 2)), mapStore().store, (req) => {
      if (!req.url.includes('/youtubei/v1/search')) return undefined;
      const b = JSON.parse(String(req.body)) as Record<string, unknown>;
      if (b['params'] !== 'EgWKAQIIAWoMEA4QChADEAQQCRAF') return undefined;
      return new Promise((r) => setTimeout(() => r(b['query'] === 'Ken Carson' ? shelf : {}), 400));
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const look = w.artists.featureLook(a);
    const t0 = Date.now();
    const first = await look.step({}, 30);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(first.features.map((t) => t.title)).toEqual(['Guest 1', 'Guest 2']);
    expect(first.more).toBe(true);
    let last = first;
    for (let i = 0; last.more && i < 60; i++) last = await look.step({}, 30);
    expect(last.more).toBe(false);
    expect(last.features.map((t) => t.title)).toEqual(['Guest 1', 'Guest 2', 'Held Back']);
    expect(last.complete).toBe(true);
  });

  it('lets the artist\u2019s own songs be read first: the look for features waits for them on Deezer', async () => {
    // SONGS-FIRST-001. Measured 2026-11-16 on the phone: Deezer answers about nine reads a second,
    // and with the song list and the feature look asking at once the songs took 12 to 16 seconds.
    // The songs are what the page is for, so they go first; the features follow at once after.
    const order: string[] = [];
    const w = world(routesFor(guests), mapStore().store, (req) => {
      const u = new URL(req.url);
      if (u.host !== 'api.deezer.com') return undefined;
      if (/^\/album\/\d+/.test(u.pathname)) { order.push('album'); return new Promise((r) => setTimeout(() => r({ __status: 404 }), 15)); }
      if (/^\/track\/\d+$/.test(u.pathname) || u.pathname === '/search/track') order.push('feature');
      return undefined;
    });
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    order.length = 0;
    const [songs, feats] = await Promise.all([w.artists.everySong(a, {}, { features: false }), w.artists.everyFeature(a)]);
    expect(songs.opened).toBeGreaterThan(4);
    expect(feats.features).toHaveLength(guests.length);
    // Every Deezer album and single of theirs was asked for before the look read anything.
    expect(order.filter((x) => x === 'album').length).toBeGreaterThan(3);
    expect(order.includes('feature')).toBe(true);
    expect(order.lastIndexOf('album')).toBeLessThan(order.indexOf('feature'));
  });

  it('remembers the songs it has already looked at, so a look again reads only the rest', async () => {
    // One candidate cannot be read the first time: the answer is incomplete and is not kept. The
    // seven it did read, and the stranger it ruled out, are not read a second time.
    const rows = [...guests, stranger(9900)];
    let down = true;
    const kept = mapStore();
    const w = world(routesFor(rows), kept.store, (req) => (down && req.url.endsWith('/track/9808') ? { __status: 404 } : undefined));
    const a = await w.artists.open({ id: 'dz:2568121', name: 'Ken Carson' });
    const first = await w.artists.everyFeature(a);
    expect(first.complete).toBe(false);
    expect(first.features).toHaveLength(7);
    const before = reads(w.seen);
    down = false;
    const second = await w.artists.everyFeature(a);
    expect(second.complete).toBe(true);
    expect(second.features.map((t) => t.title).sort()).toEqual(guests.map((g) => g.title).sort());
    expect(reads(w.seen) - before).toBe(1);
  });
});

/**
 * OPEN-FLOW-001. Owner: "ensure everything loads as seamless as possible".
 *
 * Measured 2026-11-16: an artist page is up in about 1.2 s when both services answer, and took 8 to
 * 9 s when YouTube Music held a request before refusing it (Asake 9.4 s, Tyla 8.8 s), with Deezer's
 * whole answer in hand from the first half second. The page no longer waits on the second service.
 */
describe('an artist page does not wait on a slow service (OPEN-FLOW-001)', () => {
  const grid = (titles: string[]) => ({ contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ gridRenderer: { items: titles.map((t, i) => (
    { musicTwoRowItemRenderer: { title: { runs: [{ text: t }] }, subtitle: { runs: [{ text: 'Single' }, { text: ' \u2022 ' }, { text: '2020' }] }, navigationEndpoint: { browseEndpoint: { browseId: `MPREb_more${String(i).padStart(6, '0')}` } } } }
  )) } }] } } } }] } } });
  const withMore = (browseId: string) => {
    const copy = JSON.parse(JSON.stringify(YT_PAGE));
    const secs = copy.contents.singleColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents;
    const shelves = secs.filter((x: Record<string, unknown>) => x['musicCarouselShelfRenderer']);
    const set = (shelf: { musicCarouselShelfRenderer: { header: unknown } }, title: string, params: string) => {
      shelf.musicCarouselShelfRenderer.header = { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: title }] }, moreContentButton: { buttonRenderer: { navigationEndpoint: { browseEndpoint: { browseId, params } } } } } };
    };
    set(shelves[0], 'Albums', 'ggMIegYIAxoCGAI%3D');
    set(shelves[1], 'Singles & EPs', 'ggMIegYIAhoCAQI%3D');
    return copy;
  };
  /** A store that says how long each answer was kept for. */
  function ttlStore() {
    const m = new Map<string, unknown>();
    const kept: Record<string, number> = {};
    return { kept, store: { cacheGet: (k: string) => (m.has(k) ? { value: m.get(k), created: 0, stale: false } : null), cachePut: async (k: string, _kind: string, v: unknown, ttl: number) => { m.set(k, v); kept[k] = ttl; } } as unknown as Store };
  }
  /** As `world`, with YouTube Music's requests answered by `yt` (which may take its time). */
  function slowWorld(routes: Record<string, unknown>, yt: (body: Record<string, unknown>, url: string) => Promise<unknown>, store?: Store, graceMs = 30) {
    const asked: Record<string, unknown>[] = [];
    const port: HttpPort = {
      async delay() {},
      async request(req: HttpRequest) {
        const u = new URL(req.url);
        if (u.host === 'music.youtube.com') {
          const b = JSON.parse(String(req.body)) as Record<string, unknown>;
          asked.push({ ...b, url: req.url });
          const v = await yt(b, req.url);
          if (v && typeof v === 'object' && '__status' in v) return { status: Number((v as { __status: number }).__status), headers: {}, body: enc('{}') };
          return { status: 200, headers: {}, body: enc(JSON.stringify(v)) };
        }
        const key = u.host + u.pathname + u.search;
        const hit = Object.keys(routes).find((k) => key.startsWith(k));
        return hit ? { status: 200, headers: {}, body: enc(JSON.stringify(routes[hit])) } : { status: 404, headers: {}, body: enc('{}') };
      },
    };
    const http = new Http(port, new HostPacer({}, 0));
    const dz = new Deezer(http);
    const ytm = new YouTubeMusic(http);
    return { artists: new Artists(http, dz, ytm, store, new Albums(http, dz, undefined, ytm), { ytGraceMs: graceMs }), asked };
  }
  const later = <T,>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const answer = (b: Record<string, unknown>, page: unknown = YT_PAGE) => (b['query'] ? YT_SEARCH : b['browseId'] === UC && !b['params'] ? page : {});

  it('opens with what Deezer gave when YouTube Music is slow, says so, and asks again soon', async () => {
    const t = ttlStore();
    const w = slowWorld(FULL, (b) => later(b['browseId'] ? 400 : 0, answer(b)), t.store);
    const t0 = Date.now();
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(a.songs.length).toBeGreaterThan(0);
    expect(a.sources['deezer']?.state).toBe('ok');
    expect(a.sources['ytmusic']).toMatchObject({ state: 'failed', why: 'busy' });
    // Kept a couple of minutes, not hours: the next visit asks YouTube Music again.
    const ttl = Object.entries(t.kept).find(([k]) => k.startsWith('artistview'))?.[1];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('finishes reading the slow service after the page has opened, and has the whole page the next time (OPEN-HEAL-001)', async () => {
    const t = ttlStore();
    const w = slowWorld(FULL, (b) => later(b['browseId'] ? 150 : 0, answer(b)), t.store);
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(a.sources['ytmusic']).toMatchObject({ state: 'failed', why: 'busy' });
    await later(450, null);
    const b = await w.artists.open({ name: 'Ken Carson' });
    expect(b.sources['ytmusic']?.state).toBe('ok');
    expect(b.links.ytmusic).toContain(UC);
    expect(b.sources['deezer']?.state).toBe('ok');
    expect(b.songs.length).toBeGreaterThanOrEqual(a.songs.length);
    // What was already on its way was waited for, not asked for a second time.
    expect(w.asked.filter((x) => x['browseId'] === UC && !x['params'])).toHaveLength(1);
    expect(w.asked.filter((x) => x['query'])).toHaveLength(1);
    // The whole page is kept as a whole page is.
    expect(Object.entries(t.kept).find(([k]) => k.startsWith('artistview'))?.[1]).toBeGreaterThanOrEqual(3600);
  });

  it('leaves the page as it opened when the slow service ends by refusing (OPEN-HEAL-001)', async () => {
    const t = ttlStore();
    const w = slowWorld(FULL, (b) => later(b['browseId'] ? 150 : 0, b['browseId'] ? { __status: 404 } : answer(b)), t.store);
    const a = await w.artists.open({ name: 'Ken Carson' });
    await later(450, null);
    const b = await w.artists.open({ name: 'Ken Carson' });
    expect(b.sources['ytmusic']?.state).toBe('failed');
    expect(b.songs.length).toBe(a.songs.length);
    expect(Object.entries(t.kept).find(([k]) => k.startsWith('artistview'))?.[1]).toBeLessThanOrEqual(300);
  });

  it('keeps a page both services answered for hours', async () => {
    const t = ttlStore();
    const w = slowWorld(FULL, async (b) => answer(b), t.store);
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(a.sources['ytmusic']?.state).toBe('ok');
    expect(Object.entries(t.kept).find(([k]) => k.startsWith('artistview'))?.[1]).toBeGreaterThanOrEqual(3600);
  });

  it('keeps a page one service refused only briefly', async () => {
    const t = ttlStore();
    const w = slowWorld(FULL, async (b) => (b['browseId'] ? { __status: 404 } : answer(b)), t.store);
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(a.sources['ytmusic']?.state).toBe('failed');
    expect(Object.entries(t.kept).find(([k]) => k.startsWith('artistview'))?.[1]).toBeLessThanOrEqual(300);
  });

  it('still waits for YouTube Music when it is the only service with the artist', async () => {
    const w = slowWorld({ ...FULL, 'api.deezer.com/search/artist': { data: [] } }, (b) => later(b['browseId'] === UC ? 120 : 0, b['browseId'] === SONGS_LIST ? YT_SONGS : b['continuation'] ? YT_CONT : answer(b)), undefined, 20);
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(a.id).toBe(`yt:${UC}`);
    expect(a.songs.length).toBeGreaterThan(0);
  });

  it('waits and asks again when YouTube Music refuses the artist page for a moment', async () => {
    let refusals = 2;
    const w = slowWorld(FULL, async (b) => (b['browseId'] === UC && !b['params'] && refusals-- > 0 ? { __status: 403 } : answer(b)), undefined, 5000);
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(a.sources['ytmusic']?.state).toBe('ok');
    expect(a.links.ytmusic).toContain(UC);
  });

  it('reads the whole list behind each shelf by the list\u2019s own id, both at once, asking only for what it reads', async () => {
    const page = withMore(`MPAD${UC}`);
    let open = 0;
    let most = 0;
    const w = slowWorld(FULL, async (b) => {
      if (b['browseId'] !== `MPAD${UC}`) return answer(b, page);
      open += 1;
      most = Math.max(most, open);
      await later(30, null);
      open -= 1;
      return grid(b['params'] === 'ggMIegYIAhoCAQI%3D' ? ['Deep Single One', 'Deep Single Two'] : ['Deep Album']);
    }, undefined, 5000);
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(a.singles.map((x) => x.title)).toEqual(expect.arrayContaining(['Deep Single One', 'Deep Single Two']));
    expect([...a.albums, ...a.singles].map((x) => x.title)).toContain('Deep Album');
    expect(most).toBe(2);
    const lists = w.asked.filter((b) => b['browseId'] === `MPAD${UC}`);
    expect(lists).toHaveLength(2);
    // Measured: 546 KB as the list comes, 90 KB with the parts named.
    for (const b of lists) expect(new URL(String(b['url'])).searchParams.get('fields')).toContain('gridRenderer');
    // Never the artist page a second time under the list's params.
    expect(w.asked.some((b) => b['browseId'] === UC && b['params'])).toBe(false);
  });

  it('opens with the shelf\u2019s own few when the whole list is slow, rather than waiting for it', async () => {
    const page = withMore(`MPAD${UC}`);
    const w = slowWorld(FULL, (b) => later(b['browseId'] === `MPAD${UC}` ? 400 : 0, b['browseId'] === `MPAD${UC}` ? grid(['Too Late']) : answer(b, page)), undefined, 60);
    const t0 = Date.now();
    const a = await w.artists.open({ name: 'Ken Carson' });
    expect(Date.now() - t0).toBeLessThan(350);
    expect(a.sources['ytmusic']?.state).toBe('ok');
    expect([...a.albums, ...a.singles].map((x) => x.title)).not.toContain('Too Late');
    expect([...a.albums, ...a.singles].some((x) => x.provider === 'ytmusic' || x.provider === 'deezer')).toBe(true);
  });
});
