/**
 * VOICE-SEARCH-001: the page's handle on speech to text. The model ships with both apps under
 * /models/whisper-tiny.en/; where it is missing (the plain web build), voice search is simply not
 * offered and the mic only identifies music.
 */
import { WHISPER_DIR } from './whisper';

export { queryFromSpeech } from './whisper';

type Reply = { id: number; text?: string; error?: string };
let worker: Promise<Worker | null> | null = null;
const waiting = new Map<number, { ok: (t: string) => void; no: (e: Error) => void }>();
let seq = 1;

function start(): Promise<Worker | null> {
  return (worker ??= (async () => {
    try {
      const head = await fetch(`${WHISPER_DIR}encoder_model_quantized.onnx`, { method: 'HEAD' });
      if (!head.ok || typeof Worker === 'undefined') return null;
    } catch {
      return null;
    }
    const [{ default: wasm }, { default: mjs }] = await Promise.all([
      import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
      import('onnxruntime-web/ort-wasm-simd-threaded.mjs?url'),
    ]);
    const w = new Worker(new URL('./speech-worker.ts', import.meta.url), { type: 'module' });
    const failAll = (e: Error) => { for (const p of waiting.values()) p.no(e); waiting.clear(); };
    w.onmessage = (e: MessageEvent<Reply>) => {
      const p = waiting.get(e.data.id);
      if (!p) return;
      waiting.delete(e.data.id);
      if (e.data.error !== undefined) p.no(new Error(e.data.error));
      else p.ok(e.data.text ?? '');
    };
    w.onerror = (e) => { failAll(new Error(e.message || 'speech worker crashed')); worker = null; };
    w.postMessage({ init: { wasm, mjs } });
    return w;
  })());
}

/** Start loading the model (call when listening starts, so it is ready when the person stops). */
export function prepareSpeech(): void {
  void start();
}

/** What was said in a 16 kHz clip; '' when speech to text is not available here. */
export async function transcribe(samples: Float32Array, signal?: AbortSignal): Promise<string> {
  const w = await start();
  if (!w) return '';
  const y = samples.slice(0, 30 * 16_000);
  return new Promise<string>((ok, no) => {
    const id = seq++;
    waiting.set(id, { ok, no });
    signal?.addEventListener('abort', () => { if (waiting.delete(id)) no(new DOMException('Aborted', 'AbortError')); }, { once: true });
    w.postMessage({ id, y }, [y.buffer]);
  });
}
