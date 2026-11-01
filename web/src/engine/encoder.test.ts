import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cosine } from './audio';
import { Encoder, type OrtLike } from './encoder';
import { tones } from './testsignal';

const g = JSON.parse(readFileSync(new URL('./golden/audio.json', import.meta.url), 'utf8'));
const dir = new URL('../../../.data/models/', import.meta.url);
const have = existsSync(new URL('model_epoch_36.onnx.data', dir)) && g.embedding;

describe.skipIf(!have)('ONNX encoder (onnxruntime-web, wasm) vs Python onnxruntime', () => {
  it('gives the same 512-d embedding for the same signal', async () => {
    const ort = (await import('onnxruntime-web')) as unknown as OrtLike;
    const enc = new Encoder(ort, async () => ({
      model: new Uint8Array(readFileSync(new URL('model_epoch_36.onnx', dir))),
      data: new Uint8Array(readFileSync(new URL('model_epoch_36.onnx.data', dir))),
    }));
    const r = await enc.embedAudio(tones(25, 3));
    expect(r.segments).toBe(g.embedding.segments);
    expect(r.vector.length).toBe(512);
    const c = cosine(r.vector, g.embedding.vector);
    console.log('cosine(ts, python) =', c, 'infer ms =', Math.round(r.inferMs));
    expect(c).toBeGreaterThan(0.9999);
  }, 120_000);
});
