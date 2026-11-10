/**
 * VOICE-SEARCH-001 against the Python reference (fixtures/golden.json: transformers'
 * WhisperFeatureExtractor and greedy decoding of the same ONNX files with onnxruntime). The clips are
 * Windows' built-in voice saying a title, a lyric and an artist with a title.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logMel, N_FRAMES } from './mel';
import { queryFromSpeech, Whisper, type SpeechOrt } from './whisper';

const here = join(process.cwd(), 'src', 'engine', 'speech');
const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'golden.json'), 'utf8')) as Record<string, { text: string; tokens: number[]; mel_head: number[][]; mel_sum: number; mel_min: number; mel_max: number }>;
const models = join(process.cwd(), '..', '.data', 'models', 'whisper-tiny.en');

function wav(name: string): Float32Array {
  const b = readFileSync(join(here, 'fixtures', name));
  let p = 12;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'data') {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(p + 8 + i * 2) / 32768;
      return out;
    }
    p += 8 + size;
  }
  throw new Error('no data chunk');
}

describe('log-mel features', () => {
  for (const name of Object.keys(golden)) {
    it(`match transformers' extractor for ${name}`, () => {
      const g = golden[name]!;
      const m = logMel(wav(name));
      let worst = 0;
      for (let mel = 0; mel < 80; mel++) for (let t = 0; t < 4; t++) worst = Math.max(worst, Math.abs(m[mel * N_FRAMES + t]! - g.mel_head[mel]![t]!));
      let lo = Infinity, hi = -Infinity;
      for (const x of m) { if (x < lo) lo = x; if (x > hi) hi = x; }
      expect(worst).toBeLessThan(1e-4);
      expect(lo).toBeCloseTo(g.mel_min, 4);
      expect(hi).toBeCloseTo(g.mel_max, 4);
      expect(m.reduce((a, b) => a + b, 0) / g.mel_sum).toBeCloseTo(1, 4);
    });
  }
});

describe.skipIf(!existsSync(join(models, 'decoder_model_quantized.onnx')))('Whisper tiny.en through onnxruntime-web', () => {
  // The features match the Python extractor to float precision (measured: 1.2e-7 at worst over all
  // 80 x 3000 values), but onnxruntime-web's int8 wasm kernels round differently from native
  // onnxruntime, and "Ken Carson. Yale." came out "Ken Carson, Yale." -- a near tie between two
  // punctuation marks. The search sees neither, so the words the search box gets must be the same.
  it('hears the same words as the Python reference', async () => {
    const ort = (await import('onnxruntime-web')) as unknown as SpeechOrt;
    const w = new Whisper(ort, async () => ({
      encoder: new Uint8Array(readFileSync(join(models, 'encoder_model_quantized.onnx'))),
      decoder: new Uint8Array(readFileSync(join(models, 'decoder_model_quantized.onnx'))),
      vocab: JSON.parse(readFileSync(join(models, 'vocab.json'), 'utf8')),
      generation: JSON.parse(readFileSync(join(models, 'generation_config.json'), 'utf8')),
    }));
    for (const name of Object.keys(golden)) {
      const t0 = performance.now();
      const text = await w.transcribe(wav(name));
      console.log(name, JSON.stringify(text), Math.round(performance.now() - t0), 'ms');
      expect(queryFromSpeech(text)).toBe(queryFromSpeech(golden[name]!.text));
    }
  }, 300_000);
});

describe('a spoken search as a search box query', () => {
  it('drops sentence punctuation and the filler Whisper writes for music or silence', () => {
    expect(queryFromSpeech('Bohemian Rhapsody by Queen.')).toBe('Bohemian Rhapsody by Queen');
    expect(queryFromSpeech('Is this the real life? Is this just fantasy?')).toBe('Is this the real life Is this just fantasy');
    expect(queryFromSpeech('Ken Carson. Yale.')).toBe('Ken Carson Yale');
    expect(queryFromSpeech('Play Yale by Ken Carson.')).toBe('Yale by Ken Carson');
    expect(queryFromSpeech('[Music]')).toBe('');
    expect(queryFromSpeech(' (upbeat music) ♪ ')).toBe('');
    expect(queryFromSpeech('you')).toBe('');
  });
});
