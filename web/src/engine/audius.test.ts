/**
 * SOURCE-MORE-001 — Audius as a full-song source.
 *
 * Audius is a free, keyless public API (api.audius.co/v1, documented as read-only without
 * credentials) whose tracks are whole uploads, not 30-second previews, and yt-dlp has had an Audius
 * extractor for years. Measured live on 2026-11-05: `GET /v1/tracks/search?query=lofi beat&limit=3
 * &app_name=AirwaveDiscovery` answered 200 with `duration` in whole seconds, and
 * `yt-dlp --dump-single-json https://audius.co/Lofibeat/stars-in-the-sky-lofi-beats-370899`
 * reported duration 71 - exactly the API's number - from https://api.audius.co/v1/tracks/95wro/stream.
 *
 * The fixtures below are trimmed copies of that live answer, not invented shapes.
 */
import { describe, expect, it } from 'vitest';
import { Audius, AUDIUS_APP, parseAudiusTracks } from './audius';
import { Http, type HttpPort, type HttpRequest } from './net';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

const live = {
  id: '95wro',
  title: 'Stars In The Sky - Lofi Beats',
  duration: 71,
  permalink: '/Lofibeat/stars-in-the-sky-lofi-beats-370899',
  genre: 'Hip-Hop/Rap',
  mood: 'Peaceful',
  tags: 'stars,sky,lofi,chillhop,peaceful',
  release_date: '2021-04-20T08:00:10Z',
  isrc: null,
  is_stream_gated: false,
  is_download_gated: false,
  is_available: true,
  is_delete: false,
  is_unlisted: false,
  preview_cid: null,
  preview_start_seconds: null,
  artwork: { '150x150': 'https://x/150.jpg', '480x480': 'https://x/480.jpg' },
  user: { name: 'Lofi Beats', handle: 'Lofibeat' },
};

describe('parseAudiusTracks (shapes recorded live from api.audius.co)', () => {
  it('maps an uploaded track to a playable, downloadable Track', () => {
    const [t] = parseAudiusTracks({ data: [live] });
    expect(t).toBeDefined();
    expect(t!.provider).toBe('audius');
    expect(t!.platform_id).toBe('95wro');
    expect(t!.title).toBe('Stars In The Sky - Lofi Beats');
    expect(t!.artists).toEqual(['Lofi Beats']);
    expect(t!.duration).toBe(71); // the API counts whole seconds, like the engine
    expect(t!.url).toBe('https://audius.co/Lofibeat/stars-in-the-sky-lofi-beats-370899');
    expect(t!.release?.date).toBe('2021-04-20');
    expect(t!.tags.length).toBeGreaterThan(0);
  });

  it('never carries a preview: this source is whole uploads or nothing', () => {
    const [t] = parseAudiusTracks({ data: [live] });
    expect(t!.preview).toBeNull();
  });

  it('refuses a gated track, whose public audio is only a clip', () => {
    expect(parseAudiusTracks({ data: [{ ...live, is_stream_gated: true, preview_start_seconds: 0 }] })).toEqual([]);
    expect(parseAudiusTracks({ data: [{ ...live, preview_start_seconds: 30 }] })).toEqual([]);
  });

  it('refuses deleted, hidden or unavailable uploads and anything without a length', () => {
    expect(parseAudiusTracks({ data: [{ ...live, is_delete: true }] })).toEqual([]);
    expect(parseAudiusTracks({ data: [{ ...live, is_unlisted: true }] })).toEqual([]);
    expect(parseAudiusTracks({ data: [{ ...live, is_available: false }] })).toEqual([]);
    expect(parseAudiusTracks({ data: [{ ...live, duration: 0 }] })).toEqual([]);
    expect(parseAudiusTracks({ data: [{ ...live, permalink: null }] })).toEqual([]);
  });

  it('survives an answer that is not the shape it expects', () => {
    expect(parseAudiusTracks({})).toEqual([]);
    expect(parseAudiusTracks({ data: null })).toEqual([]);
  });
});

describe('Audius.search', () => {
  it('asks the documented endpoint with an app name, and only that host', async () => {
    const seen: HttpRequest[] = [];
    const port: HttpPort = {
      async request(req) {
        seen.push(req);
        return { status: 200, headers: {}, body: enc({ data: [live] }) };
      },
    };
    const got = await new Audius(new Http(port)).search('lofi beat', 3);
    expect(got.map(t => t.platform_id)).toEqual(['95wro']);
    const url = new URL(seen[0]!.url);
    expect(url.host).toBe('api.audius.co');
    expect(url.pathname).toBe('/v1/tracks/search');
    expect(url.searchParams.get('query')).toBe('lofi beat');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.get('app_name')).toBe(AUDIUS_APP);
  });
});
