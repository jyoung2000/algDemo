/**
 * SOURCE-MORE-001 — Bandcamp as a full-song source.
 *
 * Bandcamp publishes no developer API. What its own site uses, measured live on 2026-11-05:
 *   POST https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic
 *        {"search_text":"ben prunty","search_filter":"t","full_page":false,"fan_id":null}  -> 200
 *     (the retired GET /api/fuzzysearch/1/autocomplete now answers {"error":true,"error_message":"bad function"})
 *   GET  https://bandcamp.com/api/mobile/25/tralbum_details?band_id=..&tralbum_id=..&tralbum_type=t -> 200
 *
 * The search answer has NO duration, so it cannot be identified on its own: the details call is what
 * makes a hit comparable, and it also says whether the public audio is the whole track
 * (`is_streamable`). Measured: track 2133171372 "Giant Step" by Ben Prunty, details duration
 * 190.443; `yt-dlp --dump-single-json https://benprunty.bandcamp.com/track/giant-step` reported
 * 190.443 - the whole song, not a clip.
 */
import { describe, expect, it } from 'vitest';
import { Bandcamp, parseBandcampHits, parseBandcampTrack } from './bandcamp';
import { Http, type HttpPort, type HttpRequest } from './net';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const hit = {
  type: 't',
  id: 2133171372,
  name: 'Giant Step',
  band_id: 2651419152,
  band_name: 'Ben Prunty',
  album_name: 'Chromatic T-Rex',
  item_url_path: 'https://benprunty.bandcamp.com/track/giant-step',
  img: 'https://f4.bcbits.com/img/0192221713_3.jpg',
};

const details = {
  id: 2133171372,
  type: 't',
  title: 'Giant Step',
  bandcamp_url: 'https://benprunty.bandcamp.com/track/giant-step',
  tralbum_artist: 'Ben Prunty',
  album_title: 'Chromatic T-Rex',
  release_date: 1334102400,
  tags: [{ name: 'Soundtrack' }, { name: 'chiptunes' }],
  tracks: [{ track_id: 2133171372, title: 'Giant Step', duration: 190.443, is_streamable: true, band_name: 'Ben Prunty' }],
};

describe('parseBandcampHits (recorded live from autocomplete_elastic)', () => {
  it('keeps the track hits and the ids the details call needs', () => {
    const hits = parseBandcampHits({ auto: { results: [hit, { ...hit, type: 'b', id: 1, name: 'Ben Prunty' }] } });
    expect(hits).toEqual([{ trackId: 2133171372, bandId: 2651419152, title: 'Giant Step', artist: 'Ben Prunty', url: 'https://benprunty.bandcamp.com/track/giant-step' }]);
  });

  it('drops albums, artists and anything without the ids', () => {
    expect(parseBandcampHits({ auto: { results: [{ ...hit, type: 'a' }, { ...hit, band_id: null }] } })).toEqual([]);
    expect(parseBandcampHits({})).toEqual([]);
  });
});

describe('parseBandcampTrack (recorded live from tralbum_details)', () => {
  it('builds a Track with the length the identity matcher needs', () => {
    const t = parseBandcampTrack(details, 2133171372);
    expect(t).not.toBeNull();
    expect(t!.provider).toBe('bandcamp');
    expect(t!.platform_id).toBe('2133171372');
    expect(t!.title).toBe('Giant Step');
    expect(t!.artists).toEqual(['Ben Prunty']);
    expect(t!.duration).toBe(190); // whole seconds, as every other provider reports
    expect(t!.album).toBe('Chromatic T-Rex');
    expect(t!.url).toBe('https://benprunty.bandcamp.com/track/giant-step');
    expect(t!.release?.date).toBe('2012-04-11');
    expect(t!.preview).toBeNull();
  });

  it('refuses a track Bandcamp will not stream in full', () => {
    expect(parseBandcampTrack({ ...details, tracks: [{ ...details.tracks[0], is_streamable: false }] }, 2133171372)).toBeNull();
    expect(parseBandcampTrack({ ...details, tracks: [{ ...details.tracks[0], duration: 0 }] }, 2133171372)).toBeNull();
    expect(parseBandcampTrack({ ...details, tracks: [] }, 2133171372)).toBeNull();
    expect(parseBandcampTrack({ ...details, bandcamp_url: 'http://benprunty.bandcamp.com/track/x' }, 2133171372)).toBeNull();
  });

  it('picks the asked-for track out of an album answer', () => {
    const album = { ...details, tracks: [{ track_id: 1, title: 'Other', duration: 10, is_streamable: true }, details.tracks[0]] };
    expect(parseBandcampTrack(album, 2133171372)!.title).toBe('Giant Step');
  });
  it('never attaches another track returned by the details endpoint to this hit', () => {
    const wrong = { ...details, tracks: [{ ...details.tracks[0], track_id: 42, title: 'Giant Step' }] };
    expect(parseBandcampTrack(wrong, 2133171372)).toBeNull();
  });
});

describe('Bandcamp.search', () => {
  it('posts the search its own site posts, then asks the details call per hit', async () => {
    const seen: HttpRequest[] = [];
    const port: HttpPort = {
      async request(req) {
        seen.push(req);
        if (req.url.includes('autocomplete_elastic')) return { status: 200, headers: {}, body: enc({ auto: { results: [hit] } }) };
        return { status: 200, headers: {}, body: enc(details) };
      },
    };
    const got = await new Bandcamp(new Http(port)).search('ben prunty giant step', 3);
    expect(got.map(t => t.platform_id)).toEqual(['2133171372']);
    expect(seen[0]!.method).toBe('POST');
    expect(JSON.parse(seen[0]!.body ?? '{}')).toMatchObject({ search_text: 'ben prunty giant step', search_filter: 't' });
    const d = new URL(seen[1]!.url);
    expect(d.host).toBe('bandcamp.com');
    expect(d.pathname).toBe('/api/mobile/25/tralbum_details');
    expect(d.searchParams.get('tralbum_id')).toBe('2133171372');
    expect(d.searchParams.get('tralbum_type')).toBe('t');
  });

  it('spends a bounded number of details calls however many hits come back', async () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({ ...hit, id: 1000 + i }));
    let calls = 0;
    const port: HttpPort = {
      async request(req) {
        if (req.url.includes('autocomplete_elastic')) return { status: 200, headers: {}, body: enc({ auto: { results: hits } }) };
        calls++;
        return { status: 200, headers: {}, body: enc({ ...details, tracks: [] }) };
      },
    };
    await new Bandcamp(new Http(port)).search('anything', 3);
    expect(calls).toBeLessThanOrEqual(6);
  });

  it('a hit whose details call fails does not sink the whole search', async () => {
    const port: HttpPort = {
      async request(req) {
        if (req.url.includes('autocomplete_elastic')) return { status: 200, headers: {}, body: enc({ auto: { results: [{ ...hit, id: 7 }, hit] } }) };
        if (req.url.includes('tralbum_id=7')) return { status: 500, headers: {}, body: new Uint8Array() };
        return { status: 200, headers: {}, body: enc(details) };
      },
    };
    const got = await new Bandcamp(new Http(port)).search('ben prunty', 3);
    expect(got.map(t => t.platform_id)).toEqual(['2133171372']);
  });
});
