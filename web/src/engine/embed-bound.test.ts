/**
 * TASTE-FULL-BOUND-001. Learning a song's sound from its downloaded file decodes the whole file
 * to raw audio inside the page first (about 0.8 MB per second of song). A 101-minute song took the
 * Android WebView to 1.5 GB and the system killed it (2026-11-10). The page now leaves songs over
 * 10 minutes, and files over 16 MB, out of full-song learning, before reading or decoding anything;
 * those songs keep the taste they already had.
 */
import { afterEach, expect, it, vi } from 'vitest';

import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const SRC = 'https://music.youtube.com/watch?v=KavaUJxnNVU';
const track = (duration: number | null) => ({ key: 'zyra music|lofi', title: 'Lofi', artists: ['Zyra Music'], duration });

async function open() {
  const store = await Store.open(new MemoryBackend());
  const port = { request: async () => ({ status: 404, headers: {}, body: new Uint8Array() }) };
  // A stand-in model: this test never gets as far as running it (there is no audio decoder here).
  const encoder = { analyse: vi.fn(async () => ({ tooShort: true })) };
  return new LocalApi({ store, port: port as never, encoder: encoder as never, spotifySearch: () => async () => [] });
}

/** A file answer whose body counts what was read of it. */
function fileAnswer(bytes: number, withLength: boolean) {
  const seen = { read: 0, cancelled: false };
  const chunk = 1 << 20;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close();
      const n = Math.min(chunk, bytes - sent);
      sent += n;
      seen.read += n;
      c.enqueue(new Uint8Array(n));
    },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  const headers: Record<string, string> = withLength ? { 'content-length': String(bytes) } : {};
  return { res: new Response(body, { status: 200, headers }), seen };
}

afterEach(() => vi.unstubAllGlobals());

it('leaves a song over 10 minutes out without reading its file', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const api = await open();
  const r = await api.handle('POST', '/api/embed-local', { track: track(6060), source_url: SRC });
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ embedded: false, already: false, skipped: 'long' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('leaves a file over 16 MB out without reading its body, when its size is given', async () => {
  const f = fileAnswer(112 * 1024 * 1024, true);
  vi.stubGlobal('fetch', vi.fn(async () => f.res));
  const api = await open();
  const r = await api.handle('POST', '/api/embed-local', { track: track(null), source_url: SRC });
  expect(r.body).toMatchObject({ embedded: false, skipped: 'large' });
  expect(f.seen.read).toBeLessThanOrEqual(1 << 20);
  expect(f.seen.cancelled).toBe(true);
});

it('stops reading a file with no size at 16 MB', async () => {
  const f = fileAnswer(40 * 1024 * 1024, false);
  vi.stubGlobal('fetch', vi.fn(async () => f.res));
  const api = await open();
  const r = await api.handle('POST', '/api/embed-local', { track: track(240), source_url: SRC });
  expect(r.body).toMatchObject({ embedded: false, skipped: 'large' });
  expect(f.seen.read).toBeLessThanOrEqual(17 * 1024 * 1024);
  expect(f.seen.cancelled).toBe(true);
});

it('still learns from an ordinary song: 10 minutes and 16 MB exactly are allowed', async () => {
  const f = fileAnswer(16 * 1024 * 1024, false);
  vi.stubGlobal('fetch', vi.fn(async () => f.res));
  const api = await open();
  const r = await api.handle('POST', '/api/embed-local', { track: track(600), source_url: SRC });
  // There is no audio decoder in this test, so the analysis itself declines; the point is that it was reached.
  expect(r.status).toBe(422);
  expect(f.seen.read).toBe(16 * 1024 * 1024);
});
