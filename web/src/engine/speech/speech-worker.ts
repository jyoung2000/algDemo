/**
 * VOICE-SEARCH-001: Whisper off the page's thread. Loading the model and running it take a second or
 * more; on the page's own thread they would freeze the listening panel and the search box.
 */
import { Whisper, WHISPER_DIR, type SpeechOrt, type WhisperFiles } from './whisper';

let whisper: Whisper | null = null;

async function bytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export const loadWhisperFiles = async (): Promise<WhisperFiles> => {
  const [encoder, decoder, vocab, generation] = await Promise.all([
    bytes(`${WHISPER_DIR}encoder_model_quantized.onnx`),
    bytes(`${WHISPER_DIR}decoder_model_quantized.onnx`),
    fetch(`${WHISPER_DIR}vocab.json`).then((r) => r.json()),
    fetch(`${WHISPER_DIR}generation_config.json`).then((r) => r.json()),
  ]);
  return { encoder, decoder, vocab, generation };
};

self.onmessage = async (e: MessageEvent<{ init: { wasm: string; mjs: string } } | { id: number; y: Float32Array }>) => {
  const m = e.data;
  if ('init' in m) {
    const ort = (await import('onnxruntime-web/wasm')) as unknown as SpeechOrt & { env: { wasm: Record<string, unknown> } };
    ort.env.wasm['wasmPaths'] = { wasm: m.init.wasm, mjs: m.init.mjs };
    ort.env.wasm['numThreads'] = 1;
    ort.env.wasm['proxy'] = false;
    whisper = new Whisper(ort, loadWhisperFiles);
    whisper.prepare().catch(() => { /* reported when a clip is sent */ });
    return;
  }
  try {
    if (!whisper) throw new Error('speech worker not started');
    (self as unknown as Worker).postMessage({ id: m.id, text: await whisper.transcribe(m.y) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
