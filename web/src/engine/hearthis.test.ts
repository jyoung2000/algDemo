/** SOURCE-HEARTHIS-001 — creator-enabled, CC-marked HearThis downloads only. */
import { describe, expect, it } from 'vitest';
import { HearThis, parseHearThisTracks } from './hearthis';
import { Http, type HttpPort, type HttpRequest } from './net';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const live = {
  id: '2153536', private: '0', duration: '377', title: "'DEEP' by Random  [HD Creative Commons / Royalty Free]",
  license: 'Attribution', downloadable: '1', type: 'Original', genre: 'Ambient',
  permalink_url: 'https://hearthis.at/random1-ej/deep-by-random-creative-commons-royalty-free/',
  download_url: 'https://hearthis.app/random1-ej/deep-by-random-creative-commons-royalty-free/download/',
  artwork_url: 'https://img.hearthis.at/x.jpg', release_date: '2018-07-13 00:00:00',
  user: { username: 'Sonic Alchemy by frank ferrante', permalink: 'random1-ej' },
};

describe('parseHearThisTracks (shape recorded live from api-v2.hearthis.at)', () => {
  it('maps a complete, uploader-downloadable Creative Commons track', () => {
    const [t] = parseHearThisTracks([live]);
    expect(t).toMatchObject({ provider: 'hearthis', platform_id: '2153536', title: live.title,
      artists: ['Sonic Alchemy by frank ferrante'], duration: 377, preview: null,
      url: live.permalink_url });
    expect(t!.release?.date).toBe('2018-07-13');
  });

  it('accepts recognized CC variants but rejects missing/all-rights licenses', () => {
    for (const license of ['Attribution', 'AttributionShareAlike', 'AttributionNoDerivatives',
      'Noncommercial', 'NoncommercialShareAlike', 'NoncommercialNoDerivatives', 'PublicDomain']) {
      expect(parseHearThisTracks([{ ...live, license }]), license).toHaveLength(1);
    }
    for (const license of ['', 'all', 'All Rights Reserved', 'unknown']) {
      expect(parseHearThisTracks([{ ...live, license }]), license).toEqual([]);
    }
  });

  it('accepts the API\'s optional opaque secret token only for its creator download proof', () => {
    expect(parseHearThisTracks([{ ...live, download_url: 'https://hearthis.app/random1-ej/deep-by-random-creative-commons-royalty-free/download/?secret=PZXed_1' }])).toHaveLength(1);
  });
  it('rejects private, non-downloadable, non-original, preview-length and malformed links', () => {
    for (const row of [
      { ...live, private: '1' }, { ...live, private: undefined },
      { ...live, type: 'DJ-Set' }, { ...live, type: undefined },
      { ...live, downloadable: '0' }, { ...live, download_url: '' },
      { ...live, license: '' }, { ...live, license: 'All Rights Reserved' },
      { ...live, duration: '30' }, { ...live, duration: '59' }, { ...live, duration: '99999' },
      { ...live, permalink_url: 'https://hearthis.at.evil.example/a/b/' },
      { ...live, permalink_url: 'https://hearthis.at/a/b/?next=https://evil.example' },
      { ...live, permalink_url: 'https://hearthis.at/a/b/../song/' },
      { ...live, permalink_url: 'https://hearthis.at/a/b/?' },
      { ...live, permalink_url: 'https://hearthis.at/a/b/#' },
      { ...live, download_url: 'https://hearthis.app/a/b/download/?next=https://evil.example' },
      { ...live, download_url: 'https://hearthis.app/other/different/download/' },
      { ...live, download_url: 'https://evil.example/a/download/' },
      { ...live, user: { username: '', permalink: 'random1-ej' } },
    ]) expect(parseHearThisTracks([row])).toEqual([]);
    expect(parseHearThisTracks({})).toEqual([]);
  });
});

describe('HearThis.search', () => {
  it('asks the keyless public search endpoint with bounded results', async () => {
    const seen: HttpRequest[] = [];
    const port: HttpPort = { async request(req) { seen.push(req); return { status: 200, headers: {}, body: enc([live]) }; } };
    const got = await new HearThis(new Http(port)).search('Deep Random', 50);
    expect(got.map(t => t.platform_id)).toEqual(['2153536']);
    const url = new URL(seen[0]!.url);
    expect(url.host).toBe('api-v2.hearthis.at');
    expect(url.pathname).toBe('/search/');
    expect(url.searchParams.get('t')).toBe('Deep Random');
    expect(Number(url.searchParams.get('count'))).toBeLessThanOrEqual(20);
  });
});
