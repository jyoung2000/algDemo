// @vitest-environment happy-dom
// STORAGE-TRUTH-001: the Storage panel must report the audio the app actually stores. The WebView's
// own storage estimate never sees the private queue cache, so a status that only reports the
// estimate tells the listener 2 MB while 70 MB of songs sit on disk.
import { afterEach, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';

const port = { request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) };
const api = async () => new LocalApi({ store: await Store.open(new MemoryBackend()), port, encoder: null, spotifySearch: () => async () => [] });

/** A native shell that answers `health` with a real cache size, the way Windows and Android do. */
const nativeWith = (cacheBytes: number, cacheLimitBytes: number) => {
  (window as unknown as { AirwaveNative: unknown }).AirwaveNative = {
    downloads: (id: number, json: string) => {
      const req = JSON.parse(json) as { op: string };
      const reply = req.op === 'health'
        ? { ready: true, runs_spotdl: true, tools: [], saves_to: 'C:/Music', cache_bytes: cacheBytes, cache_limit_bytes: cacheLimitBytes }
        : { error: `unexpected op ${req.op}` };
      setTimeout(() => window.__awDl?.(id, JSON.stringify(reply)), 0);
    },
  };
};

afterEach(() => { delete (window as unknown as { AirwaveNative?: unknown }).AirwaveNative; });

it('reports the private queue audio cache and its limit as app storage', async () => {
  nativeWith(69_600_218, 1_073_741_824);
  const r = await (await api()).handle('GET', '/api/status');
  const storage = (r.body as { storage: { queue_audio: { bytes: number; limit: number } | null; total: number } }).storage;
  expect(storage.queue_audio).toEqual({ bytes: 69_600_218, limit: 1_073_741_824 });
  // The headline total must not understate the app: stored songs count toward it.
  expect(storage.total).toBeGreaterThanOrEqual(69_600_218);
});

it('says nothing about embedded players streaming songs, because the apps store them', async () => {
  nativeWith(1_000, 1_073_741_824);
  const r = await (await api()).handle('GET', '/api/status');
  const body = r.body as { storage: { not_counted: string }; transfer_note: string };
  expect(body.storage.not_counted).not.toMatch(/embedded player/i);
  expect(body.storage.not_counted).not.toMatch(/not stored/i);
  expect(body.transfer_note).not.toMatch(/embedded player/i);
});

it('reports no queue audio in a plain browser instead of failing', async () => {
  const r = await (await api()).handle('GET', '/api/status');
  const storage = (r.body as { storage: { queue_audio: unknown; total: number } }).storage;
  expect(storage.queue_audio).toBeNull();
  expect(r.status).toBe(200);
});
