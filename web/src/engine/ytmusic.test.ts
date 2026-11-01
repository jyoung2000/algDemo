import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { YouTubeMusic, parseDuration, parsePlaylist, parseRelated, parseSearchSongs, parseSongRuns, parseWatch } from './ytmusic';
import { NeedsChoice, ProviderError } from './deezer';
import { Http, HostPacer, type HttpPort, type HttpRequest, type HttpResponse } from './net';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'golden');
const load = (n: string) => JSON.parse(readFileSync(join(dir, n), 'utf8'));
// Recorded live from music.youtube.com; `expected` is what ytmusicapi's own parsers return for them
// (server/tools/golden_ytm.py).
const search = load('ytm-search.json');
const watch = load('ytm-watch.json');
const related = load('ytm-related.json');
const playlist = load('ytm-playlist.json');
const expected = load('ytm-expected.json');

const names = (a: { name: string }[] | undefined) => (a ?? []).map((x) => x.name);

describe('parsers match ytmusicapi on recorded responses', () => {
  it('search: songs, artists, album, duration', () => {
    const got = parseSearchSongs(search);
    expect(got.length).toBe(expected.search.length);
    expected.search.forEach((e: any, i: number) => {
      const g = got[i]!;
      expect(g.videoId).toBe(e.videoId);
      expect(g.title).toBe(e.title);
      expect(g.artists).toEqual(e.artists);
      expect(g.album).toEqual(e.album ?? null);
      expect(g.duration_seconds).toBe(e.duration_seconds ?? null);
      expect(g.videoType).toBe(e.videoType ?? '');
      expect(g.year).toBe(e.year ?? null);
    });
  });

  it('watch playlist: tracks and the Related tab id', () => {
    const got = parseWatch(watch);
    expect(got.related).toBe(expected.related_browse);
    expect(got.tracks.length).toBe(expected.watch.length);
    expected.watch.forEach((e: any, i: number) => {
      const g = got.tracks[i]!;
      expect(g.videoId).toBe(e.videoId);
      expect(g.title).toBe(e.title);
      expect(g.artists).toEqual(e.artists);
      expect(g.duration_seconds).toBe(e.duration_seconds ?? parseDuration(e.length));
      expect(g.videoType).toBe(e.videoType ?? '');
    });
  });

  it('related: "You might also like" songs and "Similar artists"', () => {
    const got = parseRelated(related);
    const songs = expected.related.find((s: any) => s.title.toLowerCase() === 'you might also like').contents;
    const artists = expected.related.find((s: any) => s.title.toLowerCase() === 'similar artists').contents;
    expect(got.songs.map((s) => s.videoId)).toEqual(songs.map((s: any) => s.videoId));
    expect(got.songs.map((s) => s.title)).toEqual(songs.map((s: any) => s.title));
    expect(got.songs.map((s) => names(s.artists))).toEqual(songs.map((s: any) => names(s.artists)));
    expect(got.artists).toEqual(artists.map((a: any) => ({ id: a.browseId, name: a.title })));
  });

  it('playlist: title, count and tracks', () => {
    const got = parsePlaylist(playlist);
    expect(got.title).toBe(expected.playlist_title);
    expect(got.tracks.map((t) => t.videoId)).toEqual(expected.playlist.map((t: any) => t.videoId));
    expect(got.tracks.map((t) => t.title)).toEqual(expected.playlist.map((t: any) => t.title));
    expect(got.tracks.map((t) => t.duration_seconds)).toEqual(expected.playlist.map((t: any) => t.duration_seconds ?? null));
    expect(got.tracks.map((t) => names(t.artists))).toEqual(expected.playlist.map((t: any) => names(t.artists)));
  });
});

describe('run parsing edge cases (ytmusicapi parse_song_runs)', () => {
  const dot = { text: ' • ' };
  const art = { text: 'Daft Punk', navigationEndpoint: { browseEndpoint: { browseId: 'UCx' } } };
  it('skips the unlinked "Song" type label', () => {
    const r = parseSongRuns([{ text: 'Song' }, dot, art, dot, { text: '3:21' }], true);
    expect(names(r.artists)).toEqual(['Daft Punk']);
    expect(r.duration_seconds).toBe(201);
  });
  it('treats 2Pac as an artist but 12M views as views', () => {
    expect(names(parseSongRuns([{ text: '2Pac' }]).artists)).toEqual(['2Pac']);
    expect(parseSongRuns([art, dot, { text: '12M views' }]).views).toBe('12M');
  });
  it('reads hour-long durations and rejects junk', () => {
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('2,343')).toBeNull();
    expect(parseDuration(' ')).toBeNull();
  });
});

// ---- the adapter over a recorded port ------------------------------------------------------

function yt(routes: Record<string, unknown>) {
  const seen: HttpRequest[] = [];
  const port: HttpPort = {
    async request(req: HttpRequest): Promise<HttpResponse> {
      seen.push(req);
      const ep = new URL(req.url).pathname.split('/').pop()!;
      const body = JSON.parse(req.body ?? '{}');
      const key = `${ep}:${body.browseId ?? body.videoId ?? ''}`;
      const hit = routes[key] ?? routes[ep];
      if (!hit) return { status: 404, headers: {}, body: new TextEncoder().encode('{}') };
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(hit)) };
    },
  };
  return { y: new YouTubeMusic(new Http(port, new HostPacer({}, 0))), seen };
}

describe('YouTubeMusic adapter', () => {
  it('search POSTs the songs filter to music.youtube.com and maps tracks', async () => {
    const { y, seen } = yt({ search });
    const r = await y.search('daft punk one more time', 3);
    expect(r.length).toBe(3);
    expect(r[0]!.id).toBe('ytmusic:wU26xVT_vBU');
    expect(r[0]!.artists).toEqual(['Daft Punk']);
    expect(r[0]!.album).toBe('One More Time');
    expect(r[0]!.duration).toBe(321);
    expect(r[0]!.url).toBe('https://music.youtube.com/watch?v=wU26xVT_vBU');
    expect(r[0]!.kind).toBe('song');
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toMatch(/^https:\/\/music\.youtube\.com\/youtubei\/v1\/search/);
    const body = JSON.parse(seen[0]!.body!);
    expect(body.query).toBe('daft punk one more time');
    expect(body.params).toBe('EgWKAQIIAWoMEA4QChADEAQQCRAF');
    expect(body.context.client.clientName).toBe('WEB_REMIX');
  });

  it('song(): refuses a watch result for another video', async () => {
    const { y } = yt({ next: watch });
    await expect(y.song('AAAAAAAAAAA')).rejects.toThrow(/unavailable on YouTube Music/);
  });

  it('song() then related(): uses the Related tab id', async () => {
    const { y, seen } = yt({ next: watch, browse: related });
    const first = parseWatch(watch).tracks[0]!.videoId;
    const rel = await y.related(first);
    expect(rel.songs.length).toBeGreaterThan(0);
    expect(rel.artists.length).toBeGreaterThan(0);
    const browse = seen.find((s) => s.url.includes('/browse'))!;
    expect(JSON.parse(browse.body!).browseId).toBe(expected.related_browse);
  });

  it('radio drops the seed and caps at the limit', async () => {
    const { y } = yt({ next: watch });
    const first = parseWatch(watch).tracks[0]!.videoId;
    const r = await y.radio(first, 3);
    expect(r.length).toBe(3);
    expect(r.every((t) => t.platform_id !== first)).toBe(true);
  });

  it('resolveLink: shorts, bad ids and generated mixes are refused in plain words', async () => {
    const { y } = yt({});
    await expect(y.resolveLink('https://www.youtube.com/shorts/abcdefghijk')).rejects.toThrow(/videos, not songs/);
    await expect(y.resolveLink('https://www.youtube.com/watch?v=short')).rejects.toBeInstanceOf(ProviderError);
    await expect(y.resolveLink('https://www.youtube.com/playlist?list=RDabc')).rejects.toThrow(/Mixes, Liked/);
  });

  it('resolveLink: a public playlist raises NeedsChoice with its songs', async () => {
    const { y } = yt({ browse: playlist });
    const err = await y.resolveLink('https://music.youtube.com/playlist?list=PL2BHJ4oGzGos3Kb7jdcqFqWSAUYx-LGY8').catch((e) => e);
    expect(err).toBeInstanceOf(NeedsChoice);
    expect(err.kind).toBe('playlist');
    expect(err.payload.tracks.length).toBe(expected.playlist.length);
    expect(err.payload.title).toBe(expected.playlist_title);
  });

  it('resolveLink: youtu.be and /watch links reach song()', async () => {
    const { y } = yt({ next: watch });
    const id = parseWatch(watch).tracks[0]!.videoId;
    const a = await y.resolveLink(`https://youtu.be/${id}`);
    const b = await y.resolveLink(`https://music.youtube.com/watch?v=${id}&list=RDAMVM${id}`);
    expect(a.platform_id).toBe(id);
    expect(b.platform_id).toBe(id);
  });
});
