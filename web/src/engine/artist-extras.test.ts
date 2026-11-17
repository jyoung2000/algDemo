/**
 * ARTIST-ALL-SOURCES-001. Owner: "ensure the artist / discography page pulls from all sources", then
 * "keep working on all sources and ensure features and artist discography information loads".
 *
 * Measured 2026-11-16 through the app's own engine, for Sade, Khruangbin, Kendrick Lamar, Guri Lahoria,
 * Ben Prunty, RAC and Ken Carson:
 *   SoundCloud /search/users   the official account is `verified`, under a name that is not always the
 *                              artist's ("SadeOfficial", "KhruangBin"); unverified namesakes surround it.
 *   iTunes entity=musicArtist  four artists named "Sade", four named "Ken Carson": the name alone
 *                              does not say which one this is.
 *   Bandcamp filter "b"        khruangbin.bandcamp.com and benprunty.bandcamp.com are the artists' own;
 *                              "kencarsonxperiment" and "kencarson1" carry the name and are not his.
 *   Audius /users/search       RAC is `is_verified`; "Kendrick Lamar" is an empty unverified account.
 * So a platform's page is the artist's only when the platform vouches for it, or its releases are
 * ones this artist is already known for. HearThis and the Internet Archive have neither, and Spotify
 * has no artist lookup without an account: they are not read, and the page says so.
 */
import { describe, expect, it } from 'vitest';
import { Albums } from './albums';
import { ArtistExtrasReader, EXTRA_SOURCES, appleCandidates, hasRecord, knownTitles, pickAudius, pickBandcamp, pickSoundCloud, sameAccount } from './artist-extras';
import { Audius } from './audius';
import { Bandcamp } from './bandcamp';
import { Deezer } from './deezer';
import { Http, HostPacer, type HttpPort, type HttpRequest } from './net';
import { SoundCloud } from './soundcloud';
import type { Store } from './store';
import { makeTrack, type Track } from './track';
import type { AlbumSummary } from './albums';

type Json = Record<string, any>;
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const song = (title: string, provider = 'deezer', artists = ['Khruangbin']): Track =>
  makeTrack({ provider, platformId: `${provider}-${title}`, title, artists, duration: 200, url: `https://example.test/${title}` });
const album = (title: string, kind: AlbumSummary['kind'] = 'album', provider: AlbumSummary['provider'] = 'deezer'): AlbumSummary =>
  ({ id: `dz:${title.length}${title.charCodeAt(0)}`, provider, title, artist: 'Khruangbin', artwork: null, year: '2020', kind, count: 10, url: '' });
const PAGE = {
  id: 'dz:5328540', name: 'Khruangbin',
  songs: [song('Texas Sun'), song('Time (You and I)'), song('Maria Tambi\u00e9n')],
  features: [] as Track[],
  albums: [album('Mordechai'), album('Con Todo El Mundo')],
  singles: [album('Texas Sun', 'single')],
};

// ---- what each service answers ---------------------------------------------------------------------

const scUser = (id: number, username: string, verified: boolean, followers = 100, tracks = 10) =>
  ({ id, kind: 'user', username, verified, followers_count: followers, track_count: tracks, permalink: username.toLowerCase(), permalink_url: `https://soundcloud.com/${username.toLowerCase()}` });
const scTrack = (id: number, title: string, user: string, over: Json = {}) =>
  ({ id, kind: 'track', title, duration: 180_000, full_duration: 180_000, policy: 'ALLOW', permalink_url: `https://soundcloud.com/${user.toLowerCase()}/${id}`, user: { username: user }, publisher_metadata: { artist: 'Khruangbin' }, ...over });
const scSet = (id: number, title: string, user: string, verified: boolean, count = 8) =>
  ({ id, kind: 'playlist', title, set_type: 'album', track_count: count, release_date: '2023-12-01T00:00:00Z', permalink_url: `https://soundcloud.com/${user.toLowerCase()}/sets/${id}`, user: { username: user, verified }, tracks: [] });

const apArtist = (id: number, name: string) => ({ wrapperType: 'artist', artistId: id, artistName: name, artistLinkUrl: `https://music.apple.com/artist/${id}` });
const apAlbum = (id: number, title: string, artist = 'Khruangbin', count = 10) =>
  ({ wrapperType: 'collection', collectionType: 'Album', collectionId: id, collectionName: title, artistName: artist, trackCount: count, releaseDate: '2021-01-01T00:00:00Z', collectionViewUrl: `https://music.apple.com/album/${id}`, artworkUrl100: 'https://a/100x100bb.jpg' });

const bcBand = (id: number, name: string, slug: string) => ({ type: 'b', id, name, item_url_root: `https://${slug}.bandcamp.com` });
const bcItem = (id: number, title: string, type = 'album') => ({ item_id: id, item_type: type, title, band_name: 'Khruangbin', art_id: 911513519, release_date: '01 Dec 2023 00:00:00 GMT', band_id: 3521041845 });
const bcTrack = (id: number, title: string, streamable = true) =>
  ({ track_id: id, title, duration: 286.9, is_streamable: streamable, track_num: 1, band_name: 'Khruangbin', track_url: `https://khruangbin.bandcamp.com/track/${title.toLowerCase().replace(/\W+/g, '-')}` });

const auUser = (id: string, name: string, handle: string, verified: boolean) => ({ id, name, handle, is_verified: verified, follower_count: 10, track_count: 3 });
const auTrack = (id: string, title: string, over: Json = {}) =>
  ({ id, title, duration: 190, permalink: `/RAC/${id}`, is_stream_gated: false, preview_start_seconds: null, user: { name: 'Khruangbin', handle: 'khruangbin' }, ...over });

function mapStore() {
  const m = new Map<string, unknown>();
  return { m, store: { cacheGet: (k: string) => (m.has(k) ? { value: m.get(k), created: 0, stale: false } : null), cachePut: async (k: string, _kind: string, v: unknown) => void m.set(k, v) } as unknown as Store };
}

/** Routes by `host + path + query` prefix (a Bandcamp search by its filter); SoundCloud by its api path. */
function world(routes: Record<string, unknown>, sc: Record<string, unknown> = {}) {
  const seen: HttpRequest[] = [];
  const port: HttpPort = {
    // Backoff between retries is not what is under test.
    async delay() {},
    async request(req: HttpRequest) {
      seen.push(req);
      const u = new URL(req.url);
      let key = u.host + u.pathname + u.search;
      if (u.pathname.endsWith('/autocomplete_elastic')) key = `bandcamp.com/search#${String((JSON.parse(String(req.body)) as Json)['search_filter'])}`;
      const hit = Object.keys(routes).find((k) => key.startsWith(k));
      if (!hit) return { status: 404, headers: {}, body: enc({}) };
      const v = routes[hit];
      if (v instanceof Error) throw v;
      return { status: 200, headers: {}, body: enc(v) };
    },
  };
  const http = new Http(port, new HostPacer({}, 0));
  const kept = mapStore();
  const scAsked: string[] = [];
  const soundcloud = Object.assign(new SoundCloud(http), {
    api: async (path: string) => {
      scAsked.push(path);
      const hit = Object.keys(sc).find((k) => path.startsWith(k));
      if (!hit) return { collection: [] };
      const v = sc[hit];
      if (v instanceof Error) throw v;
      return v as Json;
    },
  });
  const bandcamp = new Bandcamp(http);
  const albums = new Albums(http, new Deezer(http), undefined, undefined, soundcloud, bandcamp);
  const reader = new ArtistExtrasReader(http, kept.store, { sc: soundcloud, bandcamp, audius: new Audius(http), albums });
  return { reader, albums, seen, scAsked, m: kept.m };
}

const NOTHING = {
  'itunes.apple.com/search': { results: [] },
  'bandcamp.com/search#b': { auto: { results: [] } },
  'api.audius.co/v1/users/search': { data: [] },
};

// ---- whose page it is -------------------------------------------------------------------------------

describe('whose page a platform\u2019s account is', () => {
  it('reads an official account under the name it goes by there', () => {
    expect(sameAccount('SadeOfficial', 'Sade')).toBe(true);
    expect(sameAccount('KhruangBin', 'Khruangbin')).toBe(true);
    expect(sameAccount('Kendrick Lamar Music', 'Kendrick Lamar')).toBe(true);
    expect(sameAccount('Sade Olutola', 'Sade')).toBe(false);
    expect(sameAccount('Guri Lahoria777', 'Guri Lahoria')).toBe(false);
    expect(sameAccount('Official', 'Official')).toBe(true);
  });

  it('takes the verified SoundCloud account, and keeps an unverified namesake only as a maybe', () => {
    const users = [scUser(2, 'Khruangbin', false, 2, 0), scUser(1, 'KhruangBin', true, 64109, 190), scUser(3, 'Khruangbin Fans', true)];
    expect(pickSoundCloud(users, 'Khruangbin')).toMatchObject({ verified: { id: 1 }, maybe: [] });
    const none = pickSoundCloud([scUser(8, 'Ben Prunty', false, 1707, 18), scUser(9, 'Ben Prunty', false, 2, 1), scUser(7, 'Ben Prunty', false, 9, 0)], 'Ben Prunty');
    expect(none.verified).toBeNull();
    // The most followed first; an account with no uploads has nothing to compare.
    expect(none.maybe.map((u) => u['id'])).toEqual([8, 9]);
  });

  it('takes an Audius account only when Audius has verified it', () => {
    expect(pickAudius([auUser('a', 'Kendrick Lamar', 'kendricklamar', false), auUser('b', 'RAC', 'RAC', true)], 'RAC')).toMatchObject({ id: 'b' });
    expect(pickAudius([auUser('a', 'Kendrick Lamar', 'kendricklamar', false)], 'Kendrick Lamar')).toBeNull();
    expect(pickAudius([auUser('c', 'Rac', 'scracter', true)], 'RAC')).toMatchObject({ id: 'c' });
  });

  it('takes a Bandcamp page only at the address of the artist\u2019s own name', () => {
    const bands = [bcBand(1, 'Ken Carson', 'kencarsonxperiment'), bcBand(2, 'Ken Carson', 'kencarson1'), bcBand(3, 'Ben Leeds Carson', 'benleedscarson')];
    expect(pickBandcamp(bands, 'Ken Carson')).toEqual([]);
    expect(pickBandcamp([bcBand(5, 'Ben Prunty', 'benprunty'), bcBand(6, 'Grayson County Burn Ban', 'gcbb')], 'Ben Prunty').map((b) => b.id)).toEqual([5]);
    // A page on its own domain cannot be played from, so it is not offered.
    expect(pickBandcamp([{ type: 'b', id: 9, name: 'Shall Not Fade', item_url_root: 'https://shallnotfade.co.uk' }], 'Shall Not Fade')).toEqual([]);
  });

  it('offers every Apple Music artist of exactly that name, a few at most', () => {
    const r = { results: [apArtist(1, 'Sade'), apArtist(2, 'Sade'), apArtist(3, 'Sade Olutola'), apArtist(4, 'SADE'), apArtist(5, 'Sade')] };
    expect(appleCandidates(r, 'Sade')).toEqual(['1', '2', '4']);
  });

  it('knows an artist by the titles on their page, however a service dresses them', () => {
    const known = knownTitles(PAGE);
    expect(known.has('mordechai')).toBe(true);
    expect(known.has('texas sun')).toBe(true);
    expect(known.has('time')).toBe(true);
  });

  it('knows a record under the artist\u2019s name as the record itself', () => {
    const known = knownTitles(PAGE);
    expect(hasRecord(known, 'Mordechai', 'Khruangbin')).toBe(true);
    expect(hasRecord(known, 'Khruangbin: Mordechai', 'Khruangbin')).toBe(true);
    expect(hasRecord(known, 'Khruangbin & Leon Bridges: Texas Sun', 'Khruangbin')).toBe(true);
    // Another record that ends in the same words is not it.
    expect(hasRecord(known, 'Remixes of Mordechai', 'Khruangbin')).toBe(false);
    expect(hasRecord(known, 'Mordechai Remixes', 'Khruangbin')).toBe(false);
  });

  it('knows a record sold by region as the record itself (EDITIONS-001)', () => {
    // Measured 2026-11-16 on khruangbin.bandcamp.com: one record, listed once per sales region.
    const known = knownTitles({ ...PAGE, albums: [...PAGE.albums, album('Hasta El Cielo (Con Todo El Mundo In Dub)')], songs: [...PAGE.songs, song('Christmas Time Is Here')] });
    for (const t of [
      'Con Todo El Mundo (World ex N & S America)', 'Con Todo El Mundo (N & S America Edition)',
      'Hasta El Cielo (Con Todo El Mundo in dub) - Excluding N & S America', 'Hasta El Cielo (Con Todo El Mundo in Dub) (N & S America Edition)',
      'Christmas Time Is Here (Excluding N & S America)', 'Mordechai (UK Edition)', 'Mordechai - Japan Version',
    ]) expect(hasRecord(known, t, 'Khruangbin'), t).toBe(true);
    // A different record is still a different record, whatever is in its brackets.
    expect(hasRecord(known, 'Mordechai (Remixes)', 'Khruangbin')).toBe(false);
    expect(hasRecord(known, 'Mordechai (Live in America)', 'Khruangbin')).toBe(false);
    expect(hasRecord(known, 'America', 'Khruangbin')).toBe(false);
  });
});

// ---- reading ---------------------------------------------------------------------------------------

describe('what the other platforms add to an artist page (ARTIST-ALL-SOURCES-001)', () => {
  it('names the four it reads', () => {
    expect([...EXTRA_SOURCES]).toEqual(['soundcloud', 'apple', 'bandcamp', 'audius']);
  });

  it('adds a verified SoundCloud account\u2019s uploads and sets that the page does not have', async () => {
    const w = world(NOTHING, {
      '/search/users': { collection: [scUser(1, 'KhruangBin', true, 64109, 190)] },
      '/users/1/tracks': { collection: [scTrack(11, 'Texas Sun', 'KhruangBin'), scTrack(12, 'A Loosie', 'KhruangBin'), scTrack(13, 'Only A Clip', 'KhruangBin', { policy: 'SNIP', duration: 30_000, full_duration: 241_000 })], next_href: null },
      '/users/1/albums': { collection: [scSet(21, 'Mordechai', 'KhruangBin', true), scSet(22, 'Live at Stubb\u2019s', 'KhruangBin', true)] },
    });
    const x = await w.reader.read(PAGE);
    expect(x.songs.map((t) => [t.title, t.provider])).toEqual([['A Loosie', 'soundcloud'], ['Only A Clip', 'soundcloud']]);
    // Full songs only: a clip keeps the song's real length and loses the link to the clip.
    expect(x.songs[1]).toMatchObject({ duration: 241, url: '' });
    expect(x.albums.map((a) => [a.id, a.title])).toEqual([['sc:22', 'Live at Stubb\u2019s']]);
    expect(x.sources['soundcloud']).toMatchObject({ state: 'ok', checked: 5 });
    expect(x.sources['soundcloud']!.note).toBeUndefined();
  });

  it('reads an unverified SoundCloud account of that name only when its uploads are this artist\u2019s', async () => {
    const users = { collection: [scUser(8, 'Khruangbin', false, 1707, 18)] };
    const theirs = world(NOTHING, { '/search/users': users, '/users/8/tracks': { collection: [scTrack(31, 'Texas Sun', 'Khruangbin'), scTrack(33, 'Maria Tambi\u00e9n', 'Khruangbin'), scTrack(32, 'Demo', 'Khruangbin')] } });
    const a = await theirs.reader.read(PAGE);
    expect(a.songs.map((t) => t.title)).toEqual(['Demo']);
    expect(a.sources['soundcloud']).toMatchObject({ state: 'ok', note: 'unverified' });

    const someone = world(NOTHING, { '/search/users': users, '/users/8/tracks': { collection: [scTrack(41, 'My Bedroom Tape', 'Khruangbin'), scTrack(42, 'Another One', 'Khruangbin')] } });
    const b = await someone.reader.read(PAGE);
    expect(b.songs).toEqual([]);
    expect(b.sources['soundcloud']).toEqual({ state: 'none' });

    // Measured: an account with two followers and one upload, a copy of a known song. One title in
    // common is what a fan's re-upload looks like, so it is not enough.
    const fan = world(NOTHING, { '/search/users': users, '/users/8/tracks': { collection: [scTrack(51, 'Texas Sun', 'Khruangbin')] } });
    expect((await fan.reader.read(PAGE)).sources['soundcloud']).toEqual({ state: 'none' });
  });

  it('picks the Apple Music artist whose records are this artist\u2019s, and lists only what the page lacks', async () => {
    const w = world({
      ...NOTHING,
      'itunes.apple.com/search': { results: [apArtist(100, 'Khruangbin'), apArtist(200, 'Khruangbin')] },
      'itunes.apple.com/lookup?id=100': { results: [apArtist(100, 'Khruangbin'), apAlbum(101, 'Somebody Else\u2019s Record')] },
      'itunes.apple.com/lookup?id=200': { results: [apArtist(200, 'Khruangbin'), apAlbum(201, 'Mordechai'), apAlbum(202, 'Texas Sun - Single', 'Khruangbin & Leon Bridges', 1), apAlbum(203, 'Hasta El Cielo'), apAlbum(204, 'Someone Else\u2019s Single (feat. Khruangbin) - Single', 'Maribou State', 1), apAlbum(205, 'B-Side - Single', 'Leon Bridges & Khruangbin', 1)] },
    });
    const x = await w.reader.read(PAGE);
    expect(x.albums.map((a) => [a.id, a.title, a.provider])).toEqual([['ap:203', 'Hasta El Cielo', 'apple']]);
    // A single another artist leads with them on it is a feature, not their release; one they share is theirs.
    expect(x.singles.map((a) => a.id)).toEqual(['ap:205']);
    expect(x.sources['apple']).toMatchObject({ state: 'ok', checked: 4 });
  });

  it('says a platform has no page when none of that name can be shown to be this artist', async () => {
    const w = world({
      ...NOTHING,
      'itunes.apple.com/search': { results: [apArtist(100, 'Khruangbin')] },
      'itunes.apple.com/lookup?id=100': { results: [apArtist(100, 'Khruangbin'), apAlbum(101, 'Somebody Else\u2019s Record')] },
      'bandcamp.com/search#b': { auto: { results: [bcBand(1, 'Khruangbin', 'khruangbin')] } },
      'bandcamp.com/api/mobile/25/band_details': { id: 1, name: 'Khruangbin', discography: [bcItem(50, 'Nothing You Know')] },
    });
    const x = await w.reader.read(PAGE);
    expect(x.albums).toEqual([]);
    expect(x.sources['apple']).toEqual({ state: 'none' });
    expect(x.sources['bandcamp']).toEqual({ state: 'none' });
  });

  it('reads the artist\u2019s own Bandcamp page: the records the page lacks, and their songs', async () => {
    const w = world({
      ...NOTHING,
      'bandcamp.com/search#b': { auto: { results: [bcBand(3521041845, 'Khruangbin', 'khruangbin')] } },
      // Measured: Bandcamp lists "Khruangbin: Live at ..." where Deezer has "Live at ...". The same record.
      'bandcamp.com/api/mobile/25/band_details': { id: 3521041845, name: 'Khruangbin', bandcamp_url: 'https://khruangbin.bandcamp.com', discography: [bcItem(1, 'Mordechai'), bcItem(9, 'Khruangbin & Friends: Con Todo El Mundo'), bcItem(2, 'Live at Sydney Opera House'), bcItem(3, 'Vinyl Only'), bcItem(4, 'One Off', 'track')] },
      'bandcamp.com/api/mobile/25/tralbum_details?band_id=3521041845&tralbum_id=2&tralbum_type=a': { id: 2, type: 'a', title: 'Live at Sydney Opera House', tralbum_artist: 'Khruangbin', bandcamp_url: 'https://khruangbin.bandcamp.com/album/live', art_id: 5, release_date: 1701388800, tracks: [bcTrack(201, 'First Class (Live)'), bcTrack(202, 'Paid Only', false)] },
      'bandcamp.com/api/mobile/25/tralbum_details?band_id=3521041845&tralbum_id=3&tralbum_type=a': { id: 3, type: 'a', title: 'Vinyl Only', tralbum_artist: 'Khruangbin', bandcamp_url: 'https://khruangbin.bandcamp.com/album/vinyl', tracks: [bcTrack(301, 'Not Streamed', false)] },
      'bandcamp.com/api/mobile/25/tralbum_details?band_id=3521041845&tralbum_id=4&tralbum_type=t': { id: 4, type: 't', title: 'One Off', tralbum_artist: 'Khruangbin', bandcamp_url: 'https://khruangbin.bandcamp.com/track/one-off', tracks: [bcTrack(4, 'One Off')] },
    });
    const x = await w.reader.read(PAGE);
    // "Mordechai" is on the page already; "Vinyl Only" has nothing that plays in full.
    expect(x.albums.map((a) => [a.id, a.title, a.count, a.year])).toEqual([['bc:3521041845:a2', 'Live at Sydney Opera House', 1, '2023']]);
    expect(x.singles.map((a) => [a.id, a.title])).toEqual([['bc:3521041845:t4', 'One Off']]);
    expect(x.songs.map((t) => [t.title, t.provider, t.url, t.album])).toEqual([
      ['First Class (Live)', 'bandcamp', 'https://khruangbin.bandcamp.com/track/first-class-live-', 'Live at Sydney Opera House'],
      ['One Off', 'bandcamp', 'https://khruangbin.bandcamp.com/track/one-off', null],
    ]);
    expect(x.sources['bandcamp']).toMatchObject({ state: 'ok', checked: 5 });
    expect(w.seen.some((r) => r.url.includes('tralbum_id=9&'))).toBe(false);
    // Bandcamp answers its app API with a challenge page unless the caller names itself.
    const mobile = w.seen.filter((r) => r.url.includes('/api/mobile/'));
    expect(mobile.length).toBeGreaterThan(0);
    for (const r of mobile) expect(Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'user-agent')?.[1]).toMatch(/^AirwaveDiscovery\//);
  });

  it('lists a Bandcamp record sold by region once, and leaves out one the page has under its plain name (EDITIONS-001)', async () => {
    const rel = (id: number, title: string, tracks: unknown[]) => ({ [`bandcamp.com/api/mobile/25/tralbum_details?band_id=3521041845&tralbum_id=${id}&tralbum_type=a`]: { id, type: 'a', title, tralbum_artist: 'Khruangbin', bandcamp_url: `https://khruangbin.bandcamp.com/album/${id}`, tracks } });
    const w = world({
      ...NOTHING,
      'bandcamp.com/search#b': { auto: { results: [bcBand(3521041845, 'Khruangbin', 'khruangbin')] } },
      'bandcamp.com/api/mobile/25/band_details': { id: 3521041845, name: 'Khruangbin', discography: [
        bcItem(1, 'Mordechai'), bcItem(11, 'Con Todo El Mundo (World ex N & S America)'), bcItem(12, 'Con Todo El Mundo (N & S America Edition)'),
        bcItem(21, 'New One (World ex N & S America)'), bcItem(22, 'New One (N & S America Edition)'),
      ] },
      ...rel(21, 'New One (World ex N & S America)', [bcTrack(2101, 'Alpha'), bcTrack(2102, 'Beta'), bcTrack(2103, 'Gamma')]),
      ...rel(22, 'New One (N & S America Edition)', [bcTrack(2201, 'Alpha'), bcTrack(2202, 'Beta', false), bcTrack(2203, 'Gamma', false)]),
    });
    const x = await w.reader.read(PAGE);
    // The edition with the most that plays in full, under the record's own name.
    expect(x.albums.map((a) => [a.id, a.title, a.count])).toEqual([['bc:3521041845:a21', 'New One', 3]]);
    expect(x.songs.map((t) => t.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(w.seen.some((r) => /tralbum_id=1[12]&/.test(r.url))).toBe(false);
  });

  it('does not list other artists\u2019 songs from a mix the artist put together as the artist\u2019s own (COMPILATION-001)', async () => {
    // Measured: "LateNightTales: Khruangbin" is on their Bandcamp page; its songs are titled
    // "Carlos Santana - Illuminations" and credited to the page. Fifteen of them joined Khruangbin's
    // song list. The record is theirs to list; only the song of theirs on it is their song.
    const w = world({
      ...NOTHING,
      'bandcamp.com/search#b': { auto: { results: [bcBand(3521041845, 'Khruangbin', 'khruangbin')] } },
      'bandcamp.com/api/mobile/25/band_details': { id: 3521041845, name: 'Khruangbin', discography: [bcItem(1, 'Mordechai'), bcItem(30, 'LateNightTales: Khruangbin'), bcItem(31, 'Two Part')] },
      'bandcamp.com/api/mobile/25/tralbum_details?band_id=3521041845&tralbum_id=30&tralbum_type=a': { id: 30, type: 'a', title: 'LateNightTales: Khruangbin', tralbum_artist: 'Khruangbin', bandcamp_url: 'https://khruangbin.bandcamp.com/album/lnt', tracks: [
        bcTrack(3001, 'Carlos Santana - Illuminations'), bcTrack(3002, 'Nazia Hassan - Khushi'), bcTrack(3003, 'Khruangbin - Summer Madness (Exclusive Track)'), bcTrack(3004, 'Sanulim - Dont Go'),
      ] },
      // One title with a dash on an ordinary record is a title, not a credit.
      'bandcamp.com/api/mobile/25/tralbum_details?band_id=3521041845&tralbum_id=31&tralbum_type=a': { id: 31, type: 'a', title: 'Two Part', tralbum_artist: 'Khruangbin', bandcamp_url: 'https://khruangbin.bandcamp.com/album/two', tracks: [bcTrack(3101, 'Dusk - Dawn'), bcTrack(3102, 'Plain')] },
    });
    const x = await w.reader.read(PAGE);
    expect(x.albums.map((a) => [a.title, a.count])).toEqual([['LateNightTales: Khruangbin', 4], ['Two Part', 2]]);
    expect(x.songs.map((t) => t.title)).toEqual(['Summer Madness (Exclusive Track)', 'Dusk - Dawn', 'Plain']);
    expect(x.songs.every((t) => t.artists.join() === 'Khruangbin')).toBe(true);
    // The record itself still opens with every song on it, each under the artist who made it.
    const a = await w.albums.open('bc:3521041845:a30');
    expect(a.tracks.map((t) => [t.title, t.artists.join()])).toEqual([
      ['Illuminations', 'Carlos Santana'], ['Khushi', 'Nazia Hassan'], ['Summer Madness (Exclusive Track)', 'Khruangbin'], ['Dont Go', 'Sanulim'],
    ]);
  });

  it('opens a Bandcamp record as an album page', async () => {
    const w = world({
      'bandcamp.com/api/mobile/25/tralbum_details?band_id=7&tralbum_id=2&tralbum_type=a': { id: 2, type: 'a', title: 'Live', tralbum_artist: 'Khruangbin', bandcamp_url: 'https://khruangbin.bandcamp.com/album/live', art_id: 5, release_date: 1701388800, tags: [{ name: 'funk' }], tracks: [bcTrack(201, 'First Class (Live)'), bcTrack(202, 'Paid Only', false)] },
    });
    const a = await w.albums.open('bc:7:a2');
    expect(a).toMatchObject({ id: 'bc:7:a2', provider: 'bandcamp', title: 'Live', artist: 'Khruangbin', year: '2023', kind: 'album', count: 1, genres: ['funk'] });
    expect(a.tracks.map((t) => [t.title, t.album, t['album_id']])).toEqual([['First Class (Live)', 'Live', 'bc:7:a2']]);
    await expect(w.albums.open('bc:7:x2')).rejects.toThrow();
  });

  it('adds a verified Audius account\u2019s whole songs, never a gated clip', async () => {
    const w = world({
      ...NOTHING,
      'api.audius.co/v1/users/search': { data: [auUser('nkwv1', 'Khruangbin', 'khruangbin', true)] },
      'api.audius.co/v1/users/nkwv1/tracks': { data: [auTrack('a1', 'Audius Only'), auTrack('a2', 'Gated', { is_stream_gated: true, preview_start_seconds: 25 }), auTrack('a3', 'Texas Sun')] },
    });
    const x = await w.reader.read(PAGE);
    expect(x.songs.map((t) => [t.title, t.provider])).toEqual([['Audius Only', 'audius']]);
    expect(x.sources['audius']).toMatchObject({ state: 'ok', checked: 2 });
  });

  it('lists a song once when two platforms both add it', async () => {
    const w = world({
      ...NOTHING,
      'api.audius.co/v1/users/search': { data: [auUser('nkwv1', 'Khruangbin', 'khruangbin', true)] },
      'api.audius.co/v1/users/nkwv1/tracks': { data: [auTrack('a1', 'A Loosie')] },
    }, { '/search/users': { collection: [scUser(1, 'KhruangBin', true)] }, '/users/1/tracks': { collection: [scTrack(12, 'A Loosie', 'KhruangBin')] } });
    const x = await w.reader.read(PAGE);
    expect(x.songs.map((t) => [t.title, t.provider])).toEqual([['A Loosie', 'soundcloud']]);
  });

  it('keeps what the others gave when one cannot be read, says why, and asks again next time', async () => {
    const w = world({
      ...NOTHING,
      'itunes.apple.com/search': new TypeError('fetch failed'),
      'api.audius.co/v1/users/search': { data: [auUser('nkwv1', 'Khruangbin', 'khruangbin', true)] },
      'api.audius.co/v1/users/nkwv1/tracks': { data: [auTrack('a1', 'Audius Only')] },
    }, { '/search/users': new Error('HTTP 429 from api-v2.soundcloud.com') });
    const x = await w.reader.read(PAGE);
    expect(x.songs.map((t) => t.title)).toEqual(['Audius Only']);
    expect(x.sources['apple']).toMatchObject({ state: 'failed', why: 'offline' });
    expect(x.sources['soundcloud']).toMatchObject({ state: 'failed', why: 'busy' });
    expect(x.sources['bandcamp']).toEqual({ state: 'none' });
    expect([...w.m.keys()].some((k) => k.startsWith('artistextra'))).toBe(false);
  });

  it('keeps a whole answer, so the page opens with it the next time', async () => {
    const w = world(NOTHING, { '/search/users': { collection: [] } });
    await w.reader.read(PAGE);
    const asked = w.seen.length + w.scAsked.length;
    expect([...w.m.keys()].some((k) => k.startsWith('artistextra'))).toBe(true);
    await w.reader.read(PAGE);
    expect(w.seen.length + w.scAsked.length).toBe(asked);
  });

  it('asks the four platforms together, not one after another', async () => {
    const w = world(NOTHING, { '/search/users': { collection: [] } });
    await w.reader.read(PAGE);
    const first = [...w.seen.map((r) => new URL(r.url).host), ...(w.scAsked.length ? ['soundcloud'] : [])];
    expect(new Set(first)).toEqual(new Set(['itunes.apple.com', 'bandcamp.com', 'api.audius.co', 'soundcloud']));
  });

  it('does not look where nothing could be compared', async () => {
    // A page with no titles at all: a same-named Apple Music or Bandcamp page could be anyone's.
    const w = world({ ...NOTHING, 'itunes.apple.com/search': { results: [apArtist(100, 'Khruangbin')] }, 'bandcamp.com/search#b': { auto: { results: [bcBand(1, 'Khruangbin', 'khruangbin')] } } }, { '/search/users': { collection: [] } });
    const x = await w.reader.read({ id: 'local:khruangbin', name: 'Khruangbin', songs: [], features: [], albums: [], singles: [] });
    expect(x.sources['apple']).toEqual({ state: 'none' });
    expect(x.sources['bandcamp']).toEqual({ state: 'none' });
    expect(w.seen.some((r) => r.url.includes('/lookup') || r.url.includes('band_details'))).toBe(false);
  });
});
