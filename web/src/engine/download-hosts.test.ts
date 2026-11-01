/**
 * The downloader host lists live in three places: the page (downloads.ts), the Windows shell
 * (windows/downloads.cjs) and the Android shell (Downloads.kt). They must agree, or one app could be
 * pointed at a site the other refuses. Also covers the page's own URL gate and tool choice.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DL_FORMATS, SPOTDL_HOSTS, YTDLP_HOSTS, matchTarget, targetFor, urlAllowedFor } from './downloads';

const root = new URL('../../../', import.meta.url);
const path = (p: string): string => new URL(p, root).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const quoted = (block: string): string[] => [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
const win = createRequire(import.meta.url)(path('windows/downloads.cjs')) as {
  YTDLP_HOSTS: string[];
  SPOTDL_HOSTS: string[];
  FORMATS: string[];
  urlAllowedFor: (tool: string, url: string) => boolean;
  buildArgs: (tool: string, url: string, format: string, dir: string, ffmpeg: string) => string[];
};

describe('download host lists agree', () => {
  it('Windows matches the page', () => {
    expect(new Set(win.YTDLP_HOSTS)).toEqual(new Set(YTDLP_HOSTS));
    expect(new Set(win.SPOTDL_HOSTS)).toEqual(new Set(SPOTDL_HOSTS));
    expect(new Set(win.FORMATS)).toEqual(new Set(DL_FORMATS));
  });

  it('Android matches the page', () => {
    const kt = readFileSync(path('android/app/src/main/java/com/nowplaying/discovery/Downloads.kt'), 'utf8');
    const hosts = quoted(/val YTDLP_HOSTS = setOf\(([\s\S]*?)\n\s*\)/.exec(kt)?.[1] ?? '');
    const formats = quoted(/val FORMATS = setOf\(([^)]*)\)/.exec(kt)?.[1] ?? '');
    expect(new Set(hosts)).toEqual(new Set(YTDLP_HOSTS));
    expect(new Set(formats)).toEqual(new Set(DL_FORMATS));
  });

  it('no download host is reachable by anything else than the tools', () => {
    for (const h of [...YTDLP_HOSTS, ...SPOTDL_HOSTS]) expect(h).not.toMatch(/\s/);
  });
});

describe('urlAllowedFor', () => {
  const cases: [string, string, boolean][] = [
    ['yt-dlp', 'https://www.youtube.com/watch?v=Rgrt_8mXrK8', true],
    ['yt-dlp', 'https://music.youtube.com/watch?v=Rgrt_8mXrK8', true],
    ['yt-dlp', 'https://soundcloud.com/artist/track', true],
    ['yt-dlp', 'http://www.youtube.com/watch?v=x', false],
    ['yt-dlp', 'https://example.com/a.mp3', false],
    ['yt-dlp', 'https://www.youtube.com.evil.example/watch?v=x', false],
    ['yt-dlp', 'https://user:pw@www.youtube.com/watch?v=x', false],
    ['yt-dlp', 'https://www.youtube.com/watch?v=x --exec calc', false],
    ['yt-dlp', 'https://www.youtube.com/watch?v=x\nsecond', false],
    ['yt-dlp', 'file:///c:/windows/system.ini', false],
    ['yt-dlp', 'not a url', false],
    ['spotdl', 'https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof', true],
    ['spotdl', 'https://open.spotify.com/intl-de/track/2Foc5Q5nqNiosCNqttzHof', true],
    ['spotdl', 'https://open.spotify.com/album/2Foc5Q5nqNiosCNqttzHof', false],
    ['spotdl', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', false],
    ['spotdl', 'https://www.youtube.com/watch?v=Rgrt_8mXrK8', false],
  ];
  it.each(cases)('%s %s -> %s (page and Windows shell agree)', (tool, url, want) => {
    expect(urlAllowedFor(tool as 'yt-dlp' | 'spotdl', url)).toBe(want);
    expect(win.urlAllowedFor(tool, url)).toBe(want);
  });
});

describe('targetFor / matchTarget', () => {
  it('a Spotify link goes to spotDL', () => {
    expect(targetFor({ provider: 'spotify', url: 'https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof' })?.tool).toBe('spotdl');
  });
  it('a YouTube Music song goes to yt-dlp by its video id', () => {
    expect(targetFor({ provider: 'ytmusic', platform_id: 'Rgrt_8mXrK8' })).toEqual({ tool: 'yt-dlp', url: 'https://music.youtube.com/watch?v=Rgrt_8mXrK8' });
  });
  it('a SoundCloud song goes to yt-dlp by its link', () => {
    expect(targetFor({ provider: 'soundcloud', url: 'https://soundcloud.com/a/b' })?.tool).toBe('yt-dlp');
  });
  it('a Deezer or Apple song has no direct target and needs a match first', () => {
    expect(targetFor({ provider: 'deezer', platform_id: '1', url: 'https://www.deezer.com/track/1' })).toBeNull();
    expect(targetFor({ provider: 'apple', platform_id: '1', url: 'https://music.apple.com/x' })).toBeNull();
  });
  it('a malformed video id is refused', () => {
    expect(matchTarget('x; calc')).toBeNull();
    expect(matchTarget('short')).toBeNull();
    expect(matchTarget('Rgrt_8mXrK8')?.tool).toBe('yt-dlp');
  });
});

describe('Windows argument list', () => {
  it('yt-dlp: --ignore-config first, the url last after --, and no shell metacharacters reach an option', () => {
    const a = win.buildArgs('yt-dlp', 'https://music.youtube.com/watch?v=Rgrt_8mXrK8', 'mp3', 'C:/tmp/j', 'C:/t/ffmpeg.exe');
    expect(a[0]).toBe('--ignore-config');
    expect(a.slice(-2)).toEqual(['--', 'https://music.youtube.com/watch?v=Rgrt_8mXrK8']);
    expect(a).toContain('--no-playlist');
    expect(a).not.toContain('--exec');
    expect(a[a.indexOf('--audio-format') + 1]).toBe('mp3');
  });
  it('"original" keeps the source codec', () => {
    expect(win.buildArgs('yt-dlp', 'https://youtu.be/x', 'original', 'd', 'f')).not.toContain('--audio-format');
  });
  it('spotDL: "original" falls back to mp3, since spotDL always converts', () => {
    const a = win.buildArgs('spotdl', 'https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof', 'original', 'd', 'f');
    expect(a[0]).toBe('download');
    expect(a[a.indexOf('--format') + 1]).toBe('mp3');
  });
});
