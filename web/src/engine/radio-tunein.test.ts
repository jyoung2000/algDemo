// RADIO-PLAYING-NOW-001 (owner, 2026-11-20): "You should also be able to search by artist name or song name the
// radio tab to find any station playing that artist or song currently". TuneIn's station search reports what each
// station is playing; only stations whose CURRENT song names the artist or song are listed, never a station that is
// merely named after the artist ("Drake Radio") or tagged with a genre.
import { describe, expect, it } from 'vitest';
import { publisherBroadcast } from './radio-feeds';
import { parseTuneinDescribe, parseTuneinNow, parseTuneinPlaying, playingMatches, songArtists, tuneinGuide, tuneinSearchUrl, tuneinTuneUrl, RadioPlayingNow } from './radio-tunein';

const row = (o: Record<string, unknown>) => ({ element: 'outline', type: 'audio', item: 'station', formats: 'mp3', bitrate: '128', reliability: '99', ...o });
const SEARCH = JSON.stringify({ head: { status: '200' }, body: [
  { element: 'outline', type: 'link', text: 'Artist: Drake', URL: 'http://opml.radiotime.com/Browse.ashx?id=m538202', guide_id: 'm538202' },
  row({ text: 'WCRX', URL: 'http://opml.radiotime.com/Tune.ashx?id=s28032', guide_id: 's28032', subtext: 'Drake - NOKIA', playing: 'Drake - NOKIA', playing_image: 'http://cdn-albums.tunein.com/gn/7WHRNGV1HBq.jpg', image: 'http://cdn-profiles.tunein.com/s28032/images/logoq.png?t=1' }),
  row({ text: 'Drake Radio', URL: 'http://opml.radiotime.com/Tune.ashx?id=s361830', guide_id: 's361830', subtext: 'Nichts als Drake und seine...' }),
  row({ text: 'Hot Hip Hop and R&B', guide_id: 's273492', subtext: "The top destination for today's best selection of Hip Hop and R&B" }),
  row({ text: 'KDRS Online', guide_id: 's287944', playing: 'Kendrick Lamar, SZA - luther', image: 'https://cdn-profiles.tunein.com/s287944/images/logoq.png' }),
  row({ text: 'Mix 96.7', guide_id: 's31183', subtext: 'Luke', playing: 'Drakeo the Ruler - Flu Flamming' }),
  row({ text: 'Bad id', guide_id: '../x', playing: 'Drake - Passionfruit' }),
] });

describe('which current songs answer a search', () => {
  it('matches the artist, the song, or both, as whole words', () => {
    const nokia = { artist: 'Drake', title: 'NOKIA' };
    expect(playingMatches(nokia, 'drake')).toBe(true);
    expect(playingMatches(nokia, 'Nokia')).toBe(true);
    expect(playingMatches(nokia, 'drake nokia')).toBe(true);
    expect(playingMatches({ artist: 'Drakeo the Ruler', title: 'Flu Flamming' }, 'drake')).toBe(false);
    expect(playingMatches({ artist: 'Kendrick Lamar', title: 'Not Like Us' }, 'kendrick lamar not like us')).toBe(true);
    expect(playingMatches({ artist: 'Kendrick Lamar, SZA', title: 'luther' }, 'sza')).toBe(true);
    expect(playingMatches({ artist: 'Beyoncé', title: 'CUFF IT' }, 'beyonce')).toBe(true);
    expect(playingMatches({ artist: 'Simon & Garfunkel', title: 'The Boxer' }, 'simon and garfunkel')).toBe(true);
    expect(playingMatches({ artist: 'Drake', title: 'NOKIA' }, '')).toBe(false);
    expect(playingMatches({ artist: 'Drake', title: 'NOKIA' }, 'd')).toBe(false);
  });
});

describe('TuneIn station search', () => {
  it('asks the station search with the typed words', () => {
    const u = new URL(tuneinSearchUrl('  Drake  '));
    expect(u.origin + u.pathname).toBe('https://opml.radiotime.com/Search.ashx');
    expect(u.searchParams.get('query')).toBe('Drake');
    expect(u.searchParams.get('types')).toBe('station');
    expect(u.searchParams.get('render')).toBe('json');
  });
  it('keeps only stations whose current song matches, as playable stations', () => {
    const now = 1_800_000_000_000;
    const found = parseTuneinPlaying(SEARCH, 'drake', now);
    expect(found.map(f => f.station.name)).toEqual(['WCRX']);
    const [wcrx] = found;
    expect(wcrx!.station).toMatchObject({ id: 'ti-s28032', name: 'WCRX', url: 'https://opml.radiotime.com/Tune.ashx?id=s28032', image: 'https://cdn-profiles.tunein.com/s28032/images/logoq.png?t=1', codec: 'MP3', bitrate: 128, tags: [] });
    expect(wcrx!.broadcast).toMatchObject({ state: 'current', kind: 'song', artist: 'Drake', title: 'NOKIA', checkedAt: now, artwork: 'https://cdn-albums.tunein.com/gn/7WHRNGV1HBq.jpg' });
    expect(parseTuneinPlaying(SEARCH, 'luther', now).map(f => f.station.id)).toEqual(['ti-s287944']);
  });
  it('never fails on a broken answer', () => {
    expect(parseTuneinPlaying('<html>', 'drake')).toEqual([]);
    expect(parseTuneinPlaying('{"body":7}', 'drake')).toEqual([]);
  });
  it('turns ids into TuneIn guide ids only for TuneIn stations', () => {
    expect(tuneinGuide('ti-s28032')).toBe('s28032');
    expect(tuneinGuide('ihr-865')).toBeNull();
    expect(tuneinGuide('ti-s28032x')).toBeNull();
    expect(tuneinTuneUrl('s28032')).toBe('https://opml.radiotime.com/Tune.ashx?id=s28032');
  });
});

const NOW_SONG = JSON.stringify({ Header: { Title: 'WCRX', Subtitle: 'Drake - NOKIA' }, Secondary: { GuideId: 'o37213883', Image: 'http://cdn-albums.tunein.com/gn/7WHRNGV1HBg.jpg', Title: 'Drake - NOKIA', Subtitle: 'WCRX' } });
const NOW_AD = JSON.stringify({ Header: { Title: 'The Fox 99.9', Subtitle: 'MR. LUBE - SHOP LOCAL, BUY CANADIAN, IT MATTERS' }, Secondary: { GuideId: 'o0', Title: 'MR. LUBE - SHOP LOCAL, BUY CANADIAN, IT MATTERS' } });
const NOW_NONE = JSON.stringify({ Header: { Title: 'Drake Radio', Subtitle: 'Germany' } });

describe("TuneIn's now-playing feed", () => {
  it('reads a song only when TuneIn names a real track', () => {
    expect(parseTuneinNow(NOW_SONG, 5)).toMatchObject({ state: 'current', kind: 'song', artist: 'Drake', title: 'NOKIA', source: 'TuneIn', checkedAt: 5, artwork: 'https://cdn-albums.tunein.com/gn/7WHRNGV1HBg.jpg' });
    expect(parseTuneinNow(NOW_AD, 5)).toBeNull();
    expect(parseTuneinNow(NOW_NONE, 5)).toBeNull();
    expect(parseTuneinNow('nope', 5)).toBeNull();
  });
});

const DESCRIBE = JSON.stringify({ head: { status: '200' }, body: [{ element: 'station', guide_id: 's28032', name: 'WCRX', call_sign: 'WCRX', frequency: '88.1', band: 'FM', url: 'http://www.colum.edu/academics/wcrx/', logo: 'https://cdn-profiles.tunein.com/s28032/images/logoq.png?t=6', location: 'Chicago, IL', current_song: 'NOKIA', current_artist: 'Drake', language: 'English' }] });
describe('TuneIn station details', () => {
  it('gives the place, language and the song it reports now', () => {
    expect(parseTuneinDescribe(DESCRIBE)).toEqual({ guide: 's28032', name: 'WCRX', region: 'Chicago, IL', language: 'english', homepage: 'http://www.colum.edu/academics/wcrx/', image: 'https://cdn-profiles.tunein.com/s28032/images/logoq.png?t=6', song: { artist: 'Drake', title: 'NOKIA' } });
    expect(parseTuneinDescribe('{}')).toBeNull();
  });
});

describe('RadioPlayingNow', () => {
  const answers = (map: Record<string, string>) => async (url: string) => { for (const [k, v] of Object.entries(map)) if (url.includes(k)) return v; throw new Error('offline ' + url); };
  it('adds the place and drops a station whose details say it moved on', async () => {
    const moved = DESCRIBE.replace('s28032', 's287944').replace('"WCRX"', '"KDRS Online"').replace('NOKIA', 'Other Song').replace('"Drake"', '"Someone"');
    const p = new RadioPlayingNow(answers({ 'Search.ashx': SEARCH.replace('Kendrick Lamar, SZA - luther', 'Drake - Rich Baby Daddy'), 'id=s28032': DESCRIBE, 'id=s287944': moved }));
    const found = await p.search('drake');
    expect(found.map(f => [f.station.id, f.station.region, f.station.language])).toEqual([['ti-s28032', 'Chicago, IL', 'english']]);
  });
  it('keeps a station when its details cannot be read', async () => {
    const p = new RadioPlayingNow(answers({ 'Search.ashx': SEARCH }));
    expect((await p.search('drake')).map(f => f.station.id)).toEqual(['ti-s28032']);
  });
  it('asks nothing for frequencies or one letter, and fails quietly', async () => {
    let asked = 0; const p = new RadioPlayingNow(async () => { asked++; throw new Error('offline'); });
    expect(await p.search('102.7')).toEqual([]);
    expect(await p.search('x')).toEqual([]);
    expect(asked).toBe(0);
    expect(await p.search('drake')).toEqual([]);
    expect(asked).toBe(2); // the station search and the song lookup
  });
});

describe("a TuneIn station's song on air", () => {
  const ti = { id: 'ti-s28032', name: 'WCRX', url: 'https://opml.radiotime.com/Tune.ashx?id=s28032', homepage: '', image: '', country: '', countryCode: '', region: '', language: '', tags: [], codec: 'MP3', bitrate: 128, latitude: null, longitude: null };
  it("is read from TuneIn's now-playing feed for the station", async () => {
    const asked: string[] = [];
    const b = await publisherBroadcast(ti, async u => { asked.push(u); return NOW_SONG; }, 9);
    expect(asked).toEqual(['https://feed.tunein.com/profiles/s28032/nowPlaying']);
    expect(b).toMatchObject({ state: 'current', kind: 'song', artist: 'Drake', title: 'NOKIA', source: 'TuneIn' });
  });
  it('is not invented during an ad', async () => {
    expect(await publisherBroadcast(ti, async () => NOW_AD, 9)).toBeNull();
  });
});

// Measured 2026-11-20: TuneIn's search finds "The Weeknd" but not "save your tears"; the song's artist is looked up
// first (Deezer), then the stations playing that artist are kept when their song is the one typed.
const DEEZER = JSON.stringify({ data: [
  { title: 'Save Your Tears', artist: { name: 'The Weeknd' } },
  { title: 'Save Your Tears (Remix)', artist: { name: 'The Weeknd' } },
  { title: 'Save Your Tears', artist: { name: 'Boyce Avenue' } },
  { title: 'Unrelated', artist: { name: 'Someone' } },
  { title: 'Save Your Tears', artist: { name: 'Zist' } },
] });
const WEEKND = JSON.stringify({ body: [
  row({ text: 'Mix 96.5', guide_id: 's31200', playing: 'The Weeknd - Save Your Tears' }),
  row({ text: 'Radio Nano', guide_id: 's31201', playing: 'The Weeknd - Take My Breath' }),
] });
describe('searching by song name', () => {
  it('names the artists of songs titled like the search, at most two', () => {
    expect(songArtists(DEEZER, 'save your tears')).toEqual(['The Weeknd', 'Boyce Avenue']);
    expect(songArtists('nope', 'x')).toEqual([]);
  });
  it("finds the stations playing the song through its artist's stations", async () => {
    const asked: string[] = [];
    const p = new RadioPlayingNow(async u => { asked.push(u); if (u.includes('deezer')) return DEEZER; if (u.includes('Search.ashx') && u.includes('Weeknd')) return WEEKND; if (u.includes('Search.ashx')) return '{"body":[]}'; throw new Error('offline'); });
    const found = await p.search('save your tears');
    expect(found.map(f => [f.station.name, f.broadcast.title])).toEqual([['Mix 96.5', 'Save Your Tears']]);
    expect(asked.filter(u => u.includes('Search.ashx')).map(u => new URL(u).searchParams.get('query'))).toEqual(['save your tears', 'The Weeknd', 'Boyce Avenue']);
  });
  it('does not ask the artist search twice when the search is the artist', async () => {
    const asked: string[] = [];
    const p = new RadioPlayingNow(async u => { asked.push(u); if (u.includes('deezer')) return JSON.stringify({ data: [{ title: 'NOKIA', artist: { name: 'Drake' } }] }); if (u.includes('Search.ashx')) return SEARCH; throw new Error('offline'); });
    expect((await p.search('Drake')).map(f => f.station.id)).toEqual(['ti-s28032']);
    expect(asked.filter(u => u.includes('Search.ashx'))).toHaveLength(1);
  });
});
