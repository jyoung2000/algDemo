/**
 * Live check of the anonymous Spotify search through the engine's own Http client (allowlist,
 * pacing and byte caps included). Runs only with AIRWAVE_LIVE=1, like the other live tests.
 */
import { describe, expect, it } from 'vitest';
import { Http, type HttpPort } from './net';
import { SpotifySearch, totpFor } from './spotify-anon';
import { MemoryBackend, Store } from './store';

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

describe('the 4.5 MB player bundle is read once, not on every token (SPEED-DATA-001)', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const fakeWith = (seen: string[], player = 'abc123', expiresIn = 3_600_000) => ({
    async request(req: { url: string }) {
      seen.push(req.url);
      const u = new URL(req.url);
      const reply = (s: string) => ({ status: 200, headers: {}, body: enc(s) });
      if (u.pathname === '/api/server-time') return reply('{"serverTime":1700000000}');
      if (u.hostname === 'open.spotify.com' && u.pathname === '/') return reply(`<script src="https://open.spotifycdn.com/cdn/build/web-player/web-player.${player}.js"></script>`);
      if (u.hostname === 'open.spotifycdn.com') return reply('x={secret:"abcdefghij",version:61}');
      if (u.pathname === '/api/token') return reply(JSON.stringify({ accessToken: 't', accessTokenExpirationTimestampMs: Date.now() + expiresIn }));
      return reply('{"data":{"searchV2":{"tracks":{"items":[]}}}}');
    },
  });
  const bundles = (seen: string[]) => seen.filter((u) => u.includes('open.spotifycdn.com')).length;

  it('two searches at once mint one token and read the bundle once', async () => {
    const seen: string[] = [];
    const s = new SpotifySearch(new Http(fakeWith(seen) as never));
    await Promise.all([s.searchTracks('a', 3), s.searchTracks('b', 3)]);
    expect(bundles(seen)).toBe(1);
    expect(seen.filter((u) => u.includes('/api/token')).length).toBe(1);
  });

  it('the next launch (same store) gets its token without the bundle or the player page', async () => {
    const store = await Store.open(new MemoryBackend());
    const first: string[] = [];
    await new SpotifySearch(new Http(fakeWith(first) as never), store).searchTracks('a', 3);
    expect(bundles(first)).toBe(1);
    const next: string[] = [];
    await new SpotifySearch(new Http(fakeWith(next) as never), store).searchTracks('a', 3);
    expect(bundles(next)).toBe(0);
    expect(next.some((u) => new URL(u).pathname === '/' && u.includes('open.spotify.com'))).toBe(false);
    expect(next.some((u) => u.includes('/api/token'))).toBe(true);
  });

  it('a kept secret Spotify no longer accepts is replaced from the current bundle', async () => {
    const store = await Store.open(new MemoryBackend());
    await new SpotifySearch(new Http(fakeWith([]) as never), store).searchTracks('a', 3);
    const seen: string[] = [];
    let refused = true;
    const base = fakeWith(seen, 'def456');
    const port = { async request(req: { url: string }) {
      if (refused && req.url.includes('/api/token')) { refused = false; seen.push(req.url); return { status: 400, headers: {}, body: enc('{}') }; }
      return base.request(req);
    } };
    const out = await new SpotifySearch(new Http(port as never), store).searchTracks('a', 3);
    expect(out).toEqual([]);
    expect(bundles(seen)).toBe(1);
    expect(seen.filter((u) => u.includes('/api/token')).length).toBe(2);
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
