import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SoundCloud, parseTags } from './soundcloud';
import { ProviderError } from './deezer';
import { Http, HostPacer, Meter, type HttpPort, type HttpRequest, type HttpResponse } from './net';
import type { Store } from './store';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const load = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
// Recorded live from api-v2.soundcloud.com (first three items; unused heavy fields dropped).
const search = load('sc-search.json');
const track = load('sc-track.json');
const related = load('sc-related.json');

const enc = (s: string) => new TextEncoder().encode(s);
const json = (b: unknown): HttpResponse => ({ status: 200, headers: {}, body: enc(JSON.stringify(b)) });

function sc(opts: { expireFirstId?: boolean; notFound?: boolean } = {}) {
  const seen: string[] = [];
  let expired = !!opts.expireFirstId;
  const port: HttpPort = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      seen.push(req.url);
      const u = new URL(req.url);
      if (u.hostname === 'soundcloud.com') {
        const n = seen.filter((s) => s.startsWith('https://soundcloud.com/')).length;
        return { status: 200, headers: {}, body: enc(`<script src="https://a-v2.sndcdn.com/assets/${n}-aa.js"></script><script src="https://a-v2.sndcdn.com/assets/x.js"></script>`) };
      }
      if (u.hostname === 'a-v2.sndcdn.com') {
        const n = seen.filter((s) => s.startsWith('https://soundcloud.com/')).length;
        return { status: 200, headers: {}, body: enc(u.pathname.endsWith('x.js') ? 'nothing here' : `var a={client_id:"${(`cid${n}` + 'x'.repeat(32)).slice(0, 32)}"}`) };
      }
      if (u.hostname === 'api-v2.soundcloud.com') {
        if (expired) {
          expired = false;
          return { status: 401, headers: {}, body: enc('{}') };
        }
        if (u.pathname === '/search/tracks') return json(search);
        if (u.pathname === '/resolve') return opts.notFound ? { status: 404, headers: {}, body: enc('{}') } : json(track);
        if (u.pathname.endsWith('/related')) return json(related);
      }
      return { status: 404, headers: {}, body: enc('{}') };
    },
  };
  return { s: new SoundCloud(new Http(port, new HostPacer({}, 0))), seen };
}

describe('SoundCloud mapping matches providers.py + yt-dlp', () => {
  it('track: artist, release date, genre and tags', async () => {
    const { s } = sc();
    const t = await s.resolveLink('https://soundcloud.com/forss/flickermood?utm=x');
    expect(t.id).toBe('soundcloud:293');
    expect(t.title).toBe('Flickermood');
    expect(t.artists).toEqual(['Forss']);
    expect(t.duration).toBe(214);
    expect(t.url).toBe('https://soundcloud.com/forss/flickermood');
    expect(t.release).toEqual({ date: '2003-06-02', precision: 'day', kind: 'release', source: 'SoundCloud' });
    expect(t.tags.map((x) => [x.name, x.source, x.confidence])).toEqual([
      ['electronic', 'SoundCloud uploader genre', 0.6],
      ['downtempo', 'SoundCloud uploader tag', 0.4],
    ]);
    expect(t.artwork).toMatch(/-t300x300\.jpg$/);
  });

  it('search: "Artist - Title" uploads are split, official tracks keep the publisher', async () => {
    const { s } = sc();
    const r = await s.search('flickermood forss', 5);
    expect(r.map((t) => t.id)).toEqual(['soundcloud:293', 'soundcloud:37490295', 'soundcloud:1066400848']);
    expect(r[1]!.title).toBe('Forss Flickermood Extendend Mix');
    expect(r[1]!.artists).toEqual(['Dj Lu-Ne and Dj Mole']);
    expect(r[2]!.artists).toEqual(['Forss']);
  });

  it('related: uses the numeric track id and returns tracks', async () => {
    const { s, seen } = sc();
    const t = await s.resolveLink('https://soundcloud.com/forss/flickermood');
    const r = await s.related(t, 3);
    expect(r.length).toBe(3);
    expect(r[0]!.url).toBe('https://soundcloud.com/ital-tek/ex-2');
    expect(seen.some((u) => u.includes('/tracks/293/related'))).toBe(true);
  });
});

describe('SoundCloud client id and links', () => {
  it('scrapes the id from the newest bundle that has one, once', async () => {
    const { s, seen } = sc();
    await s.search('a');
    await s.search('b');
    expect(seen.filter((u) => u === 'https://soundcloud.com/').length).toBe(1);
    expect(seen.find((u) => u.includes('/search/tracks'))).toMatch(/client_id=cid1x+/);
  });

  it('an expired id (401) is refreshed once and the call retried', async () => {
    const { s, seen } = sc({ expireFirstId: true });
    const r = await s.search('flickermood', 3);
    expect(r.length).toBe(3);
    expect(seen.filter((u) => u === 'https://soundcloud.com/').length).toBe(2);
  });

  it('refuses sets, profiles and reserved pages in plain words', async () => {
    const { s } = sc();
    await expect(s.resolveLink('https://soundcloud.com/forss/sets/album')).rejects.toThrow(/playlist \(set\)/);
    await expect(s.resolveLink('https://soundcloud.com/forss')).rejects.toThrow(/profile or page/);
    await expect(s.resolveLink('https://soundcloud.com/forss/tracks')).rejects.toThrow(/profile or page/);
    await expect(s.resolveLink('https://soundcloud.com/discover/sets')).rejects.toBeInstanceOf(ProviderError);
  });

  it('a missing track says so', async () => {
    const { s } = sc({ notFound: true });
    await expect(s.resolveLink('https://soundcloud.com/forss/gone')).rejects.toThrow(/does not exist or is private/);
  });

  it('parseTags follows the yt-dlp grammar', () => {
    expect(parseTags('downtempo "Electronic Music" chill')).toEqual(['downtempo', 'Electronic Music', 'chill']);
    expect(parseTags(null)).toEqual([]);
  });

  it('playback link is the widget embed', () => {
    const { s } = sc();
    const l = s.playbackLink({ url: 'https://soundcloud.com/forss/flickermood' } as never);
    expect(l.embed).toBe('https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fforss%2Fflickermood&auto_play=true&visual=false&show_comments=false');
  });
});

/**
 * Live shape, measured 2026-11-05 against soundcloud.com: the only bundle that carries a
 * client id is a-v2.sndcdn.com/assets/55-*.js, 2,950,727 bytes and served UNCOMPRESSED
 * (no content-encoding), so the id costs ~3 MB of transfer. The id itself is 32 alphanumerics
 * (`client_id:"N5nHxilyZaG4XKY57pV0M6qx6JysgIFW"` that day), exactly yt-dlp's
 * `client_id\s*:\s*"([0-9a-zA-Z]{32})"`. Anything that makes that one read fail — a search
 * request whose own byte allowance is nearly spent, a cancel, a transport error — used to be
 * swallowed and reported as "SoundCloud did not hand out a client id; its site may have changed",
 * which is what the Android trace showed for every full-song lookup.
 */
const LIVE_ID_SHAPE = 'N5nHxilyZaG4XKY57pV0M6qx6JysgIFW';

/** A page like the real one: one tiny bundle without an id, one heavy bundle that has it. */
function scHeavy(opts: { pad?: number; form?: 'plain' | 'json'; store?: Store; empty?: () => boolean } = {}) {
  const pad = 'y'.repeat(opts.pad ?? 40_000);
  const snippet = opts.form === 'json' ? `{"client_id":"${LIVE_ID_SHAPE}"}` : `var a={client_id:"${LIVE_ID_SHAPE}"}`;
  const seen: string[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      seen.push(req.url);
      const u = new URL(req.url);
      if (u.hostname === 'soundcloud.com') {
        return { status: 200, headers: {}, body: enc('<script src="https://a-v2.sndcdn.com/assets/0-a.js"></script><script src="https://a-v2.sndcdn.com/assets/55-b.js"></script>') };
      }
      if (u.hostname === 'a-v2.sndcdn.com') {
        const body = u.pathname.includes('/55-') ? `${pad}${snippet}${pad}` : 'no id in this one';
        return { status: 200, headers: { 'content-length': String(body.length) }, body: enc(body) };
      }
      if (u.hostname === 'api-v2.soundcloud.com' && u.pathname === '/search/tracks') {
        return json(opts.empty?.() ? { collection: [] } : search);
      }
      return { status: 404, headers: {}, body: enc('{}') };
    },
  };
  return { s: new SoundCloud(new Http(port, new HostPacer({}, 0)), opts.store), seen };
}

/** Just the two cache methods `cached()` uses, so these tests need no real storage backend. */
function memStore(): Store {
  const map = new Map<string, unknown>();
  return {
    cacheGet: (k: string) => (map.has(k) ? { value: map.get(k), created: 0, stale: false } : null),
    cachePut: async (k: string, _kind: string, v: unknown) => void map.set(k, v),
  } as unknown as Store;
}

describe('SoundCloud client id: the ~3 MB bundle read, and what it says when it fails', () => {
  it('still gets the id when the calling search has nearly spent its own byte allowance', async () => {
    const { s } = scHeavy({ pad: 150_000 }); // a 300 KB bundle stands in for the live 2.95 MB one
    const meter = new Meter(250_000, 50_000_000); // per-request cap, day wide open
    meter.add('metadata', 150_000); // the YouTube/Deezer searches of this same lookup ran first:
    // 100 KB left — enough for the api-v2 answer, nowhere near enough for the bundle.
    const r = await s.search('flickermood forss', 3, { meter });
    expect(r.length).toBe(3);
  });

  it('blames the transfer allowance, not SoundCloud, when the day is spent', async () => {
    const { s } = scHeavy();
    const meter = new Meter(50_000, 50_000);
    meter.add('metadata', 49_000);
    await expect(s.search('flickermood forss', 3, { meter })).rejects.toThrow(/allowance/i);
  });

  it('reads the id from a JSON-shaped bundle as well as a bare one', async () => {
    const { s } = scHeavy({ form: 'json' });
    expect((await s.search('flickermood forss', 3)).length).toBe(3);
  });

  it('a retry with refresh re-asks instead of replaying a cached empty answer', async () => {
    let empty = true;
    const { s } = scHeavy({ store: memStore(), empty: () => empty });
    expect((await s.search('flickermood forss', 3)).length).toBe(0);
    empty = false;
    expect((await s.search('flickermood forss', 3)).length).toBe(0); // the miss is cached
    expect((await s.search('flickermood forss', 3, { refresh: true })).length).toBe(3);
  });

  // Real network. Run with AW_LIVE=1; skipped by default so the suite stays offline.
  it.skipIf(!process.env['AW_LIVE'])('live: a real search against api-v2.soundcloud.com', async () => {
    const livePort: HttpPort = {
      async request(req: HttpRequest): Promise<HttpResponse> {
        const r = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, redirect: 'manual' });
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
      },
    };
    const s = new SoundCloud(new Http(livePort, new HostPacer({}, 0)));
    const meter = new Meter(2_000_000, 60_000_000); // smaller than the live bundle on purpose
    const r = await s.search('flickermood forss', 3, { meter });
    console.log('live tracks:', r.map((t) => `${t.artists.join(', ')} - ${t.title}`), 'bytes:', meter.counts);
    expect(r.length).toBeGreaterThan(0);
  }, 60_000);
});
