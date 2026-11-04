import { describe, expect, it, vi } from 'vitest';
import { LocalLibrary, POLL_MS, localAudioUrl, sourceUrlFor, type LocalApi } from './local-audio';

const api = (overrides: Partial<LocalApi> = {}): LocalApi & { started: string[] } => {
  const started: string[] = [];
  return {
    started,
    local: vi.fn(async () => ({ file: null, running: false })),
    start: vi.fn(async (url: string) => {
      started.push(url);
      return { job: { id: 'j1' } };
    }),
    ...overrides,
  };
};

describe('local audio: a downloaded full song the decks can play (LOCAL-AUDIO-001)', () => {
  it('names the file by its source link, at the app origin, so Web Audio may route it', () => {
    // Same origin: no CORS opt-in, no silence. The source link is the key both shells index on.
    expect(sourceUrlFor('dQw4w9WgXcQ')).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(sourceUrlFor('not a video id')).toBeNull();
    expect(localAudioUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('/local-audio?u=https%3A%2F%2Fmusic.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ');
  });

  it('answers unknown until the shell has been asked, then ready or missing', async () => {
    const a = api({ local: vi.fn(async () => ({ file: { name: 'song.opus', bytes: 100 }, running: false })) });
    const lib = new LocalLibrary(a);
    const url = sourceUrlFor('dQw4w9WgXcQ')!;
    expect(lib.status(url)).toBe('unknown');
    await lib.refresh(url);
    expect(lib.status(url)).toBe('ready');
    expect(lib.src(url)).toBe(localAudioUrl(url));
  });

  it('starts one download for a missing song and never a second while it runs', async () => {
    let running = false;
    const a = api({ local: vi.fn(async () => ({ file: null, running })) });
    const lib = new LocalLibrary(a);
    const url = sourceUrlFor('dQw4w9WgXcQ')!;
    await lib.ensure(url, 'Song — Artist');
    expect(a.started).toEqual([url]);
    expect(lib.status(url)).toBe('running');
    running = true;
    await lib.ensure(url, 'Song — Artist');
    await lib.ensure(url, 'Song — Artist');
    expect(a.started).toHaveLength(1);
    expect(lib.src(url)).toBeNull();
  });

  it('tells subscribers when a song becomes ready', async () => {
    let file: { name: string; bytes: number } | null = null;
    const a = api({ local: vi.fn(async () => ({ file, running: file === null })) });
    const lib = new LocalLibrary(a);
    const url = sourceUrlFor('dQw4w9WgXcQ')!;
    const seen: string[] = [];
    lib.subscribe(() => seen.push(lib.status(url)));
    await lib.ensure(url, 'x');
    file = { name: 'song.opus', bytes: 1 };
    await lib.refresh(url);
    expect(seen).toContain('running');
    expect(seen[seen.length - 1]).toBe('ready');
  });

  it('keeps asking the shell about a running download until it is ready, so the deck learns the file arrived', async () => {
    // Observed on the Windows app: the download finished in Music and the library stayed on
    // "running" forever, so the song played in YouTube's player to the end.
    vi.useFakeTimers();
    try {
      let file: { name: string; bytes: number } | null = null;
      const a = api({ local: vi.fn(async () => ({ file, running: file === null })) });
      const lib = new LocalLibrary(a);
      const url = sourceUrlFor('dQw4w9WgXcQ')!;
      await lib.ensure(url, 'x');
      expect(lib.status(url)).toBe('running');
      const asks = (a.local as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect((a.local as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(asks);
      file = { name: 'song.opus', bytes: 1 };
      await vi.advanceTimersByTimeAsync(POLL_MS);
      expect(lib.status(url)).toBe('ready');
      // Nothing left running: the polling stops.
      const after = (a.local as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      await vi.advanceTimersByTimeAsync(POLL_MS * 3);
      expect((a.local as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a failed download as missing so the player falls back instead of waiting forever', async () => {
    const a = api({ start: vi.fn(async () => { throw new Error('yt-dlp is not installed'); }) });
    const lib = new LocalLibrary(a);
    const url = sourceUrlFor('dQw4w9WgXcQ')!;
    await lib.ensure(url, 'x');
    expect(lib.status(url)).toBe('missing');
    expect(lib.error(url)).toMatch(/yt-dlp/);
  });
});
