/**
 * Audio analysis off the UI thread. Trimming, tempo, the mel front end and the ONNX run take about a
 * second per preview; on the page's own thread they froze scrolling, typing and the progress text for
 * the whole search. The page decodes (Web Audio is not available here) and hands the samples over.
 */
import { Encoder, type OrtLike } from './encoder';

interface Req {
  id: number;
  y: Float32Array;
  embed: boolean;
}

let encoder: Promise<Encoder> | null = null;

async function bytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function make(wasm: string, mjs: string): Promise<Encoder> {
  return (async () => {
    const ort = (await import('onnxruntime-web/wasm')) as unknown as OrtLike & { env: { wasm: Record<string, unknown> } };
    ort.env.wasm['wasmPaths'] = { wasm, mjs };
    ort.env.wasm['numThreads'] = 1; // no cross-origin isolation, so no SharedArrayBuffer
    ort.env.wasm['proxy'] = false; // this worker is already the proxy
    return new Encoder(ort, async () => {
      const [model, data] = await Promise.all([bytes('/models/model_epoch_36.onnx'), bytes('/models/model_epoch_36.onnx.data')]);
      return { model, data };
    });
  })();
}

self.onmessage = async (e: MessageEvent<Req | { init: { wasm: string; mjs: string } }>) => {
  const m = e.data;
  if ('init' in m) {
    encoder = make(m.init.wasm, m.init.mjs);
    return;
  }
  try {
    const enc = await encoder!;
    const a = await enc.analyse(m.y, m.embed);
    (self as unknown as Worker).postMessage({ id: m.id, ok: a }, a.vector ? [a.vector.buffer] : []);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
