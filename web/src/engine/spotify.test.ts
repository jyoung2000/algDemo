import { describe, expect, it } from 'vitest';
import { Spotify, looksLikeUrl, normaliseUrl, providerForUrl } from './spotify';
import { BlockedUrl, Http, HostPacer, type HttpPort, type HttpRequest, type HttpResponse } from './net';
import { ProviderError } from './deezer';

const enc = (s: string) => new TextEncoder().encode(s);
// Shape recorded live from open.spotify.com/oembed (title + artwork + iframe, no artist).
const OEMBED = {
  iframe_url: 'https://open.spotify.com/embed/track/0VjIjW4GlUZAMYd2vXMi3b?utm_source=oembed',
  title: 'Blinding Lights',
  thumbnail_url: 'https://image-cdn-ak.spotifycdn.com/image/x',
  provider_name: 'Spotify',
};

function sp(status = 200, body: unknown = OEMBED, redirectTo?: string) {
  const seen: string[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      seen.push(req.url);
      if (redirectTo && new URL(req.url).hostname === 'spotify.link') return { status: 302, headers: { location: redirectTo }, body: new Uint8Array() };
      return { status, headers: {}, body: enc(JSON.stringify(body)) };
    },
  };
  return { s: new Spotify(new Http(port, new HostPacer({}, 0))), seen };
}

describe('Spotify oEmbed', () => {
  it('a track link gives title + artwork, flagged incomplete (no artist)', async () => {
    const { s, seen } = sp();
    const t = await s.resolveLink('https://open.spotify.com/intl-de/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc');
    expect(t.id).toBe('spotify:0VjIjW4GlUZAMYd2vXMi3b');
    expect(t.title).toBe('Blinding Lights');
    expect(t.artists).toEqual([]);
    expect(t['incomplete']).toBe(true);
    expect(t.url).toBe('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b');
    expect(seen[0]).toBe('https://open.spotify.com/oembed?url=https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b');
  });

  it('albums and playlists are refused with the reason', async () => {
    const { s } = sp();
    await expect(s.resolveLink('https://open.spotify.com/album/0VjIjW4GlUZAMYd2vXMi3b')).rejects.toThrow(/That is a Spotify album/);
    await expect(s.resolveLink('https://open.spotify.com/user/someone')).rejects.toThrow(/not a track link/);
  });

  it('404 reads as an unavailable track', async () => {
    const { s } = sp(404, {});
    await expect(s.resolveLink('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b')).rejects.toBeInstanceOf(ProviderError);
  });

  it('short links are followed, and must end on open.spotify.com', async () => {
    const ok = sp(200, OEMBED, 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b');
    expect((await ok.s.resolveLink('https://spotify.link/abc')).title).toBe('Blinding Lights');
  });
});

describe('link routing', () => {
  it('routes each supported host', () => {
    expect(providerForUrl('https://www.deezer.com/track/3135556')).toBe('deezer');
    expect(providerForUrl('https://deezer.page.link/x')).toBe('deezer');
    expect(providerForUrl('https://open.spotify.com/track/x')).toBe('spotify');
    expect(providerForUrl('https://on.soundcloud.com/x')).toBe('soundcloud');
    expect(providerForUrl('https://music.youtube.com/watch?v=x')).toBe('ytmusic');
    expect(providerForUrl('https://youtu.be/x')).toBe('ytmusic');
  });
  it('refuses other hosts', () => {
    expect(() => providerForUrl('https://example.com/a')).toThrow(BlockedUrl);
  });
  it('looksLikeUrl: bare hosts count, sentences do not', () => {
    expect(looksLikeUrl('youtu.be/abc')).toBe(true);
    expect(looksLikeUrl('https://soundcloud.com/a/b')).toBe(true);
    expect(looksLikeUrl('daft punk one more time')).toBe(false);
    expect(looksLikeUrl('daft.punk now')).toBe(false);
  });
  it('normaliseUrl: adds https, upgrades http, rejects off-list hosts', () => {
    expect(normaliseUrl('youtu.be/abcdefghijk')).toBe('https://youtu.be/abcdefghijk');
    expect(normaliseUrl('http://soundcloud.com/a/b')).toBe('https://soundcloud.com/a/b');
    expect(() => normaliseUrl('evil.example/x')).toThrow(BlockedUrl);
  });
});
