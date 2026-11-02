import { describe, expect, it } from 'vitest';
import {
  BlockedUrl, BudgetExceeded, CancelToken, Cancelled, FetchError, Http, HostPacer, Meter, hostAllowed, validateUrl,
  type HttpPort, type HttpRequest, type HttpResponse,
} from './net';

const enc = (s: string) => new TextEncoder().encode(s);
const resp = (status: number, body = '', headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: enc(body) });
const fastPacer = () => new HostPacer({}, 0);

/** A scripted transport: each call pops the next response, and records the URLs it was asked for. */
function scripted(...steps: (HttpResponse | Error)[]) {
  const seen: string[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest) {
      seen.push(req.url);
      const next = steps.shift();
      if (!next) throw new Error('no more scripted responses');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { port, seen };
}

describe('host allowlist (mirrors net.py ALLOWED_HOSTS / ALLOWED_SUFFIXES)', () => {
  it('allows the music hosts and their media CDNs', () => {
    for (const h of ['api.deezer.com', 'API.DEEZER.COM', 'api.deezer.com.', 'cdns-preview-1.dzcdn.net', 'cdn-files.sndcdn.com', 'api-v2.soundcloud.com', 'youtu.be']) {
      expect(hostAllowed(h), h).toBe(true);
    }
  });
  it('allows the search providers (MusicSearch) and their artwork hosts', () => {
    for (const h of ['itunes.apple.com', 'api-partner.spotify.com', 'clienttoken.spotify.com', 'open.qobuz.com',
      'na.web.skill.music.a2z.com', 'music.amazon.com', 'resources.tidal.com', 'api.song.link', 'lrclib.net', 'musicbrainz.org', 'i.ytimg.com']) {
      expect(hostAllowed(h), h).toBe(true);
    }
  });
  it('keeps the download resolver hosts out of the allowlist', () => {
    for (const h of ['spotidownloader.com', 'zaz.mesk.skill.music.a2z.com', 'api.zarz.moe', 'qbz.afkarxyz.fun', 'api.github.com', 'pypi.org']) {
      expect(hostAllowed(h), h).toBe(false);
    }
  });
  it('refuses lookalikes and unknown hosts', () => {
    for (const h of ['evil-deezer.com', 'api.deezer.com.evil.net', 'dzcdn.net.attacker.io', 'localhost', '127.0.0.1', '169.254.169.254', '']) {
      expect(hostAllowed(h), h).toBe(false);
    }
  });
});

describe('validateUrl', () => {
  it('accepts a plain https link on an allowed host', () => {
    expect(validateUrl('https://api.deezer.com/search?q=x')).toBe('https://api.deezer.com/search?q=x');
    expect(validateUrl('https://api.deezer.com:443/track/1')).toBeTruthy();
  });
  it('refuses http, credentials, non-standard ports, and unknown hosts', () => {
    expect(() => validateUrl('http://api.deezer.com/x')).toThrow(BlockedUrl);
    expect(() => validateUrl('https://user:pw@api.deezer.com/x')).toThrow(BlockedUrl);
    expect(() => validateUrl('https://api.deezer.com:8443/x')).toThrow(BlockedUrl);
    expect(() => validateUrl('https://example.com/x')).toThrow(BlockedUrl);
    expect(() => validateUrl('not a url')).toThrow(BlockedUrl);
  });
});

describe('Http guard', () => {
  it('returns the body for an allowed 200', async () => {
    const { port, seen } = scripted(resp(200, '{"ok":true}'));
    const http = new Http(port, fastPacer());
    const j = await http.getJson<{ ok: boolean }>('https://api.deezer.com/x', { maxBytes: 1000 });
    expect(j.ok).toBe(true);
    expect(seen).toEqual(['https://api.deezer.com/x']);
  });

  it('re-validates every redirect hop: a redirect to a non-allowed host is refused', async () => {
    const { port, seen } = scripted(resp(302, '', { location: 'https://evil.example/steal' }));
    const http = new Http(port, fastPacer());
    await expect(http.get('https://api.deezer.com/x', { maxBytes: 1000 })).rejects.toThrow(BlockedUrl);
    expect(seen).toEqual(['https://api.deezer.com/x']); // never requested the evil host
  });

  it('follows an allowed redirect and reports the final URL', async () => {
    const { port } = scripted(resp(301, '', { location: 'https://www.deezer.com/track/9' }), resp(200, 'hi'));
    const http = new Http(port, fastPacer());
    const { finalUrl } = await http.get('https://deezer.com/link', { maxBytes: 1000 });
    expect(finalUrl).toBe('https://www.deezer.com/track/9');
  });

  it('refuses a declared Content-Length over the cap before reading', async () => {
    const { port } = scripted(resp(200, 'x', { 'content-length': '999999' }));
    const http = new Http(port, fastPacer());
    await expect(http.get('https://api.deezer.com/x', { maxBytes: 100 })).rejects.toThrow(BudgetExceeded);
  });

  it('aborts when the bytes actually received exceed the cap, not the advertised length', async () => {
    const { port } = scripted(resp(200, 'x'.repeat(500), { 'content-length': '10' }));
    const http = new Http(port, fastPacer());
    await expect(http.get('https://api.deezer.com/x', { maxBytes: 100 })).rejects.toThrow(BudgetExceeded);
  });

  it('retries 429 and 5xx with backoff, then gives up as a FetchError', async () => {
    const { port, seen } = scripted(resp(503), resp(503), resp(503));
    const http = new Http(port, fastPacer());
    await expect(http.get('https://api.deezer.com/x', { maxBytes: 1000, retries: 2 })).rejects.toThrow(FetchError);
    expect(seen.length).toBe(3);
  }, 15000);

  it('stops before the request when the cancel token is set', async () => {
    const { port, seen } = scripted(resp(200, 'ok'));
    const http = new Http(port, fastPacer());
    const token = new CancelToken();
    token.cancel('user left');
    await expect(http.get('https://api.deezer.com/x', { maxBytes: 1000, token })).rejects.toThrow(Cancelled);
    expect(seen).toEqual([]);
  });

  it('counts received bytes against the meter and refuses once the allowance is used', async () => {
    const meter = new Meter(50, 1000);
    const { port } = scripted(resp(200, 'x'.repeat(40)), resp(200, 'x'.repeat(40)));
    const http = new Http(port, fastPacer());
    await http.get('https://api.deezer.com/a', { maxBytes: 1000, meter, category: 'search' });
    expect(meter.total).toBe(40);
    await expect(http.get('https://api.deezer.com/b', { maxBytes: 1000, meter, category: 'search' })).rejects.toThrow(BudgetExceeded);
  });
});

describe('Meter.reserve', () => {
  it('gives a spent request a small allowance that still counts against the day', () => {
    const seen: number[] = [];
    const m = new Meter(1000, 5000, (_c, n) => seen.push(n));
    m.add('metadata', 1200); // the request cap is already used up
    expect(m.remaining()).toBe(0);
    const r = m.reserve(300);
    expect(r.remaining()).toBe(300);
    r.add('metadata', 100);
    expect(r.remaining()).toBe(200);
    expect(seen).toEqual([1200, 100]);
  });
  it('never exceeds what is left of the day', () => {
    const m = new Meter(1000, 1100);
    m.add('metadata', 1000);
    expect(m.reserve(300).remaining()).toBe(100);
    m.add('metadata', 200);
    expect(m.reserve(300).remaining()).toBe(0);
  });
});
