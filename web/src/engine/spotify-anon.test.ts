/**
 * Live check of the anonymous Spotify search through the engine's own Http client (allowlist,
 * pacing and byte caps included). Runs only with AIRWAVE_LIVE=1, like the other live tests.
 */
import { describe, expect, it } from 'vitest';
import { Http, type HttpPort } from './net';
import { SpotifySearch, totpFor } from './spotify-anon';

const live = process.env['AIRWAVE_LIVE'] === '1';

const port: HttpPort = {
  async request(req, signal) {
    // Redirects are not followed here: Http re-checks every hop against the allowlist.
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      ...(req.body !== undefined ? { body: req.body } : {}),
      ...(signal ? { signal } : {}),
      redirect: 'manual',
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  },
};

describe('totpFor', () => {
  it('returns a six-digit code', async () => {
    const code = await totpFor(1_700_000_000, 'abcdefghijklmnopqrstuvwxyz0123456789');
    expect(code).toMatch(/^\d{6}$/);
  });
});

describe('SpotifySearch requests', () => {
  it('names a desktop browser on every request, because Android HTTP gets a page with no player bundle', async () => {
    const seen: Array<{ url: string; ua: string | undefined }> = [];
    const enc = (s: string) => new TextEncoder().encode(s);
    const fake: HttpPort = {
      async request(req) {
        seen.push({ url: req.url, ua: req.headers?.['User-Agent'] });
        const u = new URL(req.url);
        const reply = (s: string) => ({ status: 200, headers: {}, body: enc(s) });
        if (u.pathname === '/api/server-time') return reply('{"serverTime":1700000000}');
        if (u.hostname === 'open.spotify.com' && u.pathname === '/') return reply('<script src="https://open.spotifycdn.com/cdn/build/web-player/web-player.abc123.js"></script>');
        if (u.hostname === 'open.spotifycdn.com') return reply('x={secret:"abcdefghij",version:61}');
        if (u.pathname === '/api/token') return reply('{"accessToken":"t","accessTokenExpirationTimestampMs":9999999999999}');
        return reply('{"data":{"searchV2":{"tracks":{"items":[{"track":{"uri":"spotify:track:1pKYYY0dkg23sQQXi0Q5zN","name":"Around the World","artists":{"items":[{"profile":{"name":"Daft Punk"}}]}}}]}}}}');
      },
    };
    const tracks = await new SpotifySearch(new Http(fake)).searchTracks('around the world', 3);
    expect(tracks.map((t) => t.platform_id)).toEqual(['1pKYYY0dkg23sQQXi0Q5zN']);
    expect(seen.length).toBe(5);
    for (const s of seen) expect(s.ua).toMatch(/^Mozilla\/5\.0 \(Windows NT/);
  });
});

describe.skipIf(!live)('Spotify anonymous search, live', () => {
  it('finds the Spotify track for a known song through the engine Http client', async () => {
    const s = new SpotifySearch(new Http(port));
    const tracks = await s.searchTracks('daft punk around the world', 4);
    expect(tracks.length).toBeGreaterThan(0);
    const first = tracks[0]!;
    expect(first.provider).toBe('spotify');
    expect(first.platform_id).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(first.url).toBe(`https://open.spotify.com/track/${first.platform_id}`);
    expect(tracks.map((t) => t.platform_id)).toContain('1pKYYY0dkg23sQQXi0Q5zN');
  }, 60_000);
});
