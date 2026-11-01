import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SoundCloud, parseTags } from './soundcloud';
import { ProviderError } from './deezer';
import { Http, HostPacer, type HttpPort, type HttpRequest, type HttpResponse } from './net';

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
