/**
 * Starts the in-app engine inside the Android WebView: IndexedDB store, the bundled ONNX audio model,
 * the guarded HTTP bridge. Everything the UI used to ask the Python server for is answered by LocalApi.
 */
import { Encoder, type Analyser, type OrtLike } from './encoder';
import { WorkerEncoder } from './worker-encoder';
import { openIdbBackend } from './idb';
import { LocalApi } from './local-api';
import { defaultHttpPort, isNative } from './native-http';
import { spotifySearchAvailable, spotifySearchRaw } from './downloads';
import { searchSpotify } from './spotify-search';
import { SpotifySearch } from './spotify-anon';
import type { Http } from './net';
import { Store } from './store';

let started: Promise<LocalApi> | null = null;

async function bytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The audio model ships next to the app (Android assets: web/models). Null when it is not there. */
async function makeEncoder(): Promise<Analyser | null> {
  try {
    const head = await fetch('/models/model_epoch_36.onnx', { method: 'HEAD' });
    if (!head.ok) return null;
  } catch {
    return null;
  }
  const [{ default: wasm }, { default: mjs }] = await Promise.all([
    import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
    import('onnxruntime-web/ort-wasm-simd-threaded.mjs?url'),
  ]);
  // The model and the maths run in a worker so the page stays responsive during a search. If a worker
  // cannot start, the same code runs on the page's own thread instead.
  if (typeof Worker !== 'undefined') {
    try {
      const w = new Worker(new URL('./audio-worker.ts', import.meta.url), { type: 'module' });
      return new WorkerEncoder(w, { wasm, mjs });
    } catch {
      /* fall through to the in-thread encoder */
    }
  }
  const ort = (await import('onnxruntime-web/wasm')) as unknown as OrtLike & { env: { wasm: Record<string, unknown> } };
  ort.env.wasm['wasmPaths'] = { wasm, mjs };
  ort.env.wasm['numThreads'] = 1; // no cross-origin isolation in the WebView, so no SharedArrayBuffer
  ort.env.wasm['proxy'] = false;
  return new Encoder(ort, async () => {
    const [model, data] = await Promise.all([bytes('/models/model_epoch_36.onnx'), bytes('/models/model_epoch_36.onnx.data')]);
    return { model, data };
  });
}

export function startLocal(): Promise<LocalApi> {
  started ??= (async () => {
    const store = await Store.open(await openIdbBackend(), {
      cacheBudget: 150_000_000,
      freeBytes: async () => {
        const e = await navigator.storage?.estimate?.();
        return e?.quota != null && e.usage != null ? e.quota - e.usage : null;
      },
      freeFloor: 50_000_000,
    });
    void navigator.storage?.persist?.();
    // Spotify search: the anonymous web-player search on every platform. Windows adds spotDL (in the
    // shell) as the fallback when that search fails; Android has no spotDL and reports the failure.
    const spotifySearch = (http: Http) => {
      const anon = new SpotifySearch(http);
      return async (q: string, limit: number) => {
        try {
          return await anon.searchTracks(q, limit);
        } catch (e) {
          if (!spotifySearchAvailable()) throw e;
          // Android has a native downloader too, but no spotDL: its shell rejects the request, and
          // the anonymous search's own error is the one worth showing.
          try {
            return await searchSpotify(async (query, n) => (await spotifySearchRaw(query, n)).songs, q, limit);
          } catch {
            throw e;
          }
        }
      };
    };
    return new LocalApi({ store, port: defaultHttpPort(), encoder: await makeEncoder(), spotifySearch });
  })();
  return started;
}

/** True when the page runs inside the Android shell, or with ?local=1 for testing in a browser. */
export const useLocalEngine = (): boolean => isNative() || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('local'));
