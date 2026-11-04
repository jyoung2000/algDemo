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
    // src() is the Blob URL and arrives a tick later; see LOCAL-AUDIO-002 for why.
    expect(lib.src(url)).toBeNull();
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

  it('plays the held song from a Blob, so the deck gets a real duration and can seek (LOCAL-AUDIO-002)', async () => {
    // Measured on Android: WebView answers a Range request with 200 and no Content-Range, so
    // Chromium treats the stream as non-seekable — duration stayed Infinity, the progress bar
    // never moved and there was no total time. Fetching the file once and handing the deck a
    // Blob URL gives it the whole thing at once: duration resolves, seeking works.
    const fetched: string[] = [];
    const revoked: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g['fetch'] = vi.fn(async (u: string) => {
      fetched.push(u);
      return { ok: true, blob: async () => new Blob([new Uint8Array(8)], { type: 'audio/ogg' }) } as unknown as Response;
    });
    let n = 0;
    (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => `blob:song-${++n}`;
    (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => void revoked.push(u);
    const lib = new LocalLibrary(api({ local: vi.fn(async () => ({ file: { name: 'song.opus', bytes: 8 }, running: false })) }));
    const url = sourceUrlFor('dQw4w9WgXcQ')!;
    // Nothing is fetched before the shell says it holds the file.
    expect(lib.src(url)).toBeNull();
    expect(fetched).toEqual([]);
    await lib.ensure(url, 'x');
    expect(lib.status(url)).toBe('ready');
    // First ask starts the fetch and returns null; the library notifies when the blob is there.
    expect(lib.src(url)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched).toEqual([localAudioUrl(url)]);
    expect(lib.src(url)).toBe('blob:song-1');
    // Asked again, the same blob comes back: one fetch per song, not one per render.
    expect(lib.src(url)).toBe('blob:song-1');
    expect(fetched).toHaveLength(1);
    // Only a few songs are held at a time; the oldest blob is released.
    for (const id of ['11111111111', '22222222222', '33333333333']) {
      const u = sourceUrlFor(id)!;
      await lib.ensure(u, id);
      lib.src(u);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(revoked).toContain('blob:song-1');
    expect(lib.src(url)).toBeNull(); // released, and fetched again on demand
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
