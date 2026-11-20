// RADIO-ALL-STATIONS-001 (owner, 2026-11-19): "Why doesnt v103 and power 92 load in the radio list, ensure the radio
// can load all stations in that area". Radio Browser has no V103 (WVAZ) or Power 92 (WPWX) at all, and only 37 of its
// 120 Illinois stations carry coordinates. iHeart's live-station directory lists every station around a US place
// (73 around Chicago, other broadcasters' too) with its logo and stream.
import { describe, expect, it } from 'vitest';
import { iheartIdsUrl, iheartMatches, iheartNearUrl, iheartSearchUrl, mergeStations, parseIheartSearch, parseIheartStations, stationFromIheart, streamOf } from './radio-iheart';
import { RadioDirectory, type RadioStation } from './radio';
import type { RadioPlace } from './radio-places';

const hit = (o: Record<string, unknown>) => ({
  id: 865, name: 'V103', callLetters: 'WVAZ-FM', freq: '102.7', band: 'FM', website: 'v103.iheart.com', logo: 'https://i.iheart.com/v3/re/assets/images/865.png',
  genres: [{ name: 'R&B' }], markets: [{ city: 'Chicago', stateAbbreviation: 'IL', country: 'US', origin: true }], countries: 'US',
  streams: { hls_stream: 'http://stream.revma.ihrhls.com/zc865/hls.m3u8', shoutcast_stream: 'http://stream.revma.ihrhls.com/zc865', secure_hls_stream: 'https://stream.revma.ihrhls.com/zc865/hls.m3u8', secure_shoutcast_stream: 'https://stream.revma.ihrhls.com/zc865' },
  ...o,
});
const V103 = hit({});
const POWER = hit({ id: 6342, name: 'Power 92', callLetters: 'WPWX-FM', freq: '92.3', website: 'power92chicago.com', logo: 'https://i.iheart.com/v3/re/assets.streams/6af4e5.png', genres: [{ name: 'Hip Hop and R&B' }],
  streams: { shoutcast_stream: 'http://ais-sa8.cdnstream1.com/pptsa5hdbog/cjo5jxmng7u', secure_shoutcast_stream: 'https://ais-sa8.cdnstream1.com/pptsa5hdbog/cjo5jxmng7u' } });
const KISS = hit({ id: 849, name: '103.5 Kiss FM', callLetters: 'WKSC-FM', freq: '103.5', website: '1035kissfm.iheart.com', genres: [{ name: 'Top 40 & Pop' }] });
const TU = hit({ id: 1, name: 'La Ley 107.9', callLetters: 'WLEY-FM', freq: '107.9', website: '', genres: [{ name: 'Mexican and Tejano' }, { name: 'Spanish' }] });
const NEAR = JSON.stringify({ total: 4, hits: [V103, POWER, KISS, TU] });

const rb = (o: Record<string, unknown>) => ({ stationuuid: 'rb-' + String(o.name), url: 'https://example.org/s.mp3', homepage: '', favicon: '', country: 'The United States Of America', countrycode: 'US', state: 'Illinois', language: 'english', tags: '', codec: 'MP3', bitrate: 128, geo_lat: null, geo_long: null, ...o });
const RB_KISS = rb({ name: '103.5 KISS FM WKSC Chicago', homepage: 'https://1035kissfm.iheart.com/', geo_lat: 41.876, geo_long: -87.63 });
const RB_WLIT = rb({ name: '93.9 WLIT Lite FM', tags: 'chicago,lite,illinois' });
const RB_PEORIA = rb({ name: 'WCBU Peoria Public Radio', tags: 'npr,public radio' });
const RB_WCHI = rb({ name: 'WCHI 95.5 Chicago', state: 'Chicago' });

const chicago: RadioPlace = { id: 'area:US:41.875,-87.624', label: 'Chicago, Illinois', query: 'Chicago', kind: 'area', lat: 41.8755, lon: -87.6244, radiusKm: 60, countryCode: 'US', region: 'Illinois', city: 'Chicago', selected: true };
const toronto: RadioPlace = { ...chicago, id: 'area:CA:43.65,-79.38', label: 'Toronto, Ontario', query: 'Toronto', lat: 43.65, lon: -79.38, countryCode: 'CA', region: 'Ontario', city: 'Toronto' };

function fake(routes: (url: string) => unknown) {
  const asked: string[] = [];
  const dir = new RadioDirectory(async (url) => { asked.push(url); const v = routes(url); if (v instanceof Error) throw v; return typeof v === 'string' ? v : JSON.stringify(v ?? []); });
  return { dir, asked };
}

describe('iHeart station records', () => {
  it('a record becomes a station with its logo, website, genres and place; id ihr-<n> passes the native id check', () => {
    const s = stationFromIheart(V103)!;
    expect(s).toMatchObject({ id: 'ihr-865', name: 'V103', url: 'https://stream.revma.ihrhls.com/zc865', homepage: 'https://v103.iheart.com', image: 'https://i.iheart.com/v3/re/assets/images/865.png',
      countryCode: 'US', region: 'Chicago, IL', tags: ['r&b'], call: 'WVAZ', frequency: '102.7' });
    expect(s.id).toMatch(/^[A-Za-z0-9-]{1,100}$/);
  });

  it('prefers a direct secure stream, then a direct one, then HLS; a record without one is skipped', () => {
    expect(streamOf(POWER.streams)).toBe('https://ais-sa8.cdnstream1.com/pptsa5hdbog/cjo5jxmng7u');
    expect(streamOf({ hls_stream: 'http://a.example/x.m3u8' })).toBe('http://a.example/x.m3u8');
    expect(streamOf({ pls_stream: 'http://a.example/x.pls', secure_hls_stream: 'https://a.example/x.m3u8' })).toBe('https://a.example/x.m3u8');
    expect(stationFromIheart(hit({ streams: {} }))).toBeNull();
    expect(stationFromIheart(hit({ streams: { shoutcast_stream: 'http://192.168.1.5/x' } }))).toBeNull();
    expect(parseIheartStations('not json')).toEqual([]);
    expect(parseIheartStations(NEAR).map((s) => s.name)).toEqual(['V103', 'Power 92', '103.5 Kiss FM', 'La Ley 107.9']);
  });

  it('URLs for a place, a search and a set of ids', () => {
    expect(iheartNearUrl(41.87554, -87.62442)).toBe('https://api.iheart.com/api/v2/content/liveStations?limit=200&lat=41.8755&lng=-87.6244');
    expect(iheartIdsUrl(['865', '6342'])).toBe('https://api.iheart.com/api/v2/content/liveStations?limit=12&id=865%2C6342');
    expect(iheartSearchUrl('V103')).toContain('keywords=V103');
    expect(parseIheartSearch(JSON.stringify({ results: { stations: [{ id: 865 }, { id: 7059 }, { id: 'x' }] } }))).toEqual(['865', '7059']);
  });

  it('a search matches the call letters and the dial number as well as the name', () => {
    const power = stationFromIheart(POWER)!;
    expect(iheartMatches(power, 'WPWX')).toBe(true);
    expect(iheartMatches(power, '92.3')).toBe(true);
    expect(iheartMatches(power, 'Power 92')).toBe(true);
    expect(iheartMatches(power, 'V103')).toBe(false);
  });

  it('one row per station: a Radio Browser row for the same station wins (keeping starred ids) and borrows the logo', () => {
    const rbKiss = { id: 'rb-kiss', name: '103.5 KISS FM WKSC Chicago', url: 'https://x', homepage: 'https://1035kissfm.iheart.com/', image: '', country: '', countryCode: 'US', region: 'Illinois', language: 'english', tags: [], codec: '', bitrate: 0, latitude: null, longitude: null } as RadioStation;
    const out = mergeStations([rbKiss], parseIheartStations(NEAR));
    expect(out.map((s) => s.id)).toEqual(['rb-kiss', 'ihr-865', 'ihr-6342', 'ihr-1']);
    expect(out[0]!.image).toBe(KISS.logo);
  });
});

describe('the directory with places', () => {
  const routes = (url: string) => {
    if (url.startsWith('https://api.iheart.com/api/v2/content/liveStations?limit=200')) return NEAR;
    if (url.includes('geo_lat=')) return [RB_KISS];
    if (url.includes('state=Chicago')) return [RB_WCHI];
    if (url.includes('state=Illinois')) return [RB_WLIT, RB_PEORIA, RB_KISS];
    return [];
  };

  it('Chicago lists V103 and Power 92, the no-coordinates stations that name Chicago, and each station once', async () => {
    const { dir, asked } = fake(routes);
    const names = (await dir.search({ places: [chicago] })).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['V103', 'Power 92', '93.9 WLIT Lite FM', 'WCHI 95.5 Chicago', '103.5 KISS FM WKSC Chicago']));
    expect(names).not.toContain('103.5 Kiss FM'); // the same station as the Radio Browser KISS row
    expect(names).not.toContain('WCBU Peoria Public Radio'); // Illinois, but not Chicago
    expect(asked.filter((u) => u.includes('api.iheart.com'))).toHaveLength(1);
  });

  it('a place outside the US does not ask iHeart (it would answer with the nearest US city)', async () => {
    const { dir, asked } = fake(routes);
    await dir.search({ places: [toronto] });
    expect(asked.some((u) => u.includes('iheart'))).toBe(false);
  });

  it('filters still apply: a genre, a language, the letter index and the search text', async () => {
    const { dir } = fake(routes);
    expect((await dir.search({ places: [chicago], tag: 'hip hop' })).map((s) => s.name)).toContain('Power 92');
    expect((await dir.search({ places: [chicago], tag: 'hip hop' })).map((s) => s.name)).not.toContain('V103');
    expect((await dir.search({ places: [chicago], language: 'spanish' })).map((s) => s.name)).toContain('La Ley 107.9');
    expect((await dir.search({ places: [chicago], language: 'english' })).map((s) => s.name)).not.toContain('La Ley 107.9');
    expect((await dir.search({ places: [chicago], language: 'german' })).some((s) => s.id.startsWith('ihr-'))).toBe(false);
    expect((await dir.search({ places: [chicago], letter: 'V' })).map((s) => s.name)).toContain('V103');
    expect((await dir.search({ places: [chicago], query: 'WPWX' })).map((s) => s.name)).toEqual(['Power 92']);
  });

  it('iHeart being down never empties the list', async () => {
    const { dir } = fake((u) => (u.includes('iheart') ? new Error('offline') : routes(u)));
    expect((await dir.search({ places: [chicago] })).map((s) => s.name)).toContain('WCHI 95.5 Chicago');
  });

  it('later pages do not repeat the iHeart stations', async () => {
    const { dir, asked } = fake(routes);
    await dir.page({ places: [chicago], offset: 24 });
    expect(asked.some((u) => u.includes('iheart'))).toBe(false);
  });
});

describe('a typed search', () => {
  it('“V103” finds V103 in Chicago although Radio Browser has no row for it', async () => {
    const { dir } = fake((u) => {
      if (u.startsWith('https://api.iheart.com/api/v3/search/all')) return { results: { stations: [{ id: 865 }, { id: 6342 }] } };
      if (u.startsWith('https://api.iheart.com/api/v2/content/liveStations?limit=12')) return { hits: [V103, POWER] };
      return [];
    });
    const found = await dir.search({ query: 'V103' });
    expect(found.map((s) => [s.name, s.region])).toEqual([['V103', 'Chicago, IL']]);
  });

  it('a search limited to another country does not ask iHeart', async () => {
    const { dir, asked } = fake(() => []);
    await dir.search({ query: 'V103', country: 'DE' });
    expect(asked.some((u) => u.includes('iheart'))).toBe(false);
  });
});
