/**
 * FULL-SONG-EMBED-001: the audio model must be able to hear the whole song, not Deezer's 30 seconds.
 *
 * The pipeline only ever embedded a preview (`vectorFor` returns null without a Deezer id and
 * without a preview, then embeds the preview). The installed apps now hold the complete track in
 * the queue cache, so the model can analyse the real thing — and for songs with no Deezer match it
 * is the only audio there has ever been.
 *
 * The premise is tested too, not assumed: a four-section signal is built so that its first 30
 * seconds genuinely cannot stand for the whole, and the preview-sized embedding is shown to be a
 * worse description of it than a bounded sample spread across the song.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HOP, SEGMENT, SR, cosine, segmentsOf, segmentsSpread } from './audio';
import { Encoder, type OrtLike } from './encoder';
import { MemoryBackend, Store } from './store';

/** One section of a "song": its own pitch and timbre, so sections are not interchangeable. */
function section(seconds: number, f0: number, f1: number, seed: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0.42 * Math.sin(2 * Math.PI * f0 * t) + 0.24 * Math.sin(2 * Math.PI * f1 * t) + 0.08 * Math.sin(2 * Math.PI * (f1 * 3.1) * t);
    v *= 0.62 + 0.38 * Math.sin(2 * Math.PI * 0.9 * t);
    const h = Number((BigInt(i + seed * 7919) * 2654435761n) & 0xffffffffn);
    v += 0.02 * ((h / 4294967296) * 2 - 1);
    y[i] = Math.max(-1, Math.min(1, v));
  }
  return y;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Two minutes in four unmistakably different sections. */
const song = () =>
  concat([
    section(30, 110, 640, 1),
    section(30, 233, 1330, 2),
    section(30, 440, 2250, 3),
    section(30, 147, 880, 4),
  ]);

const offsetsOf = (segs: Float32Array[]) => segs.map((s) => s.byteOffset / 4);

describe('a bounded sample spread across the whole song (FULL-SONG-EMBED-001)', () => {
  it('is exactly the ordinary segmentation when the song fits inside the budget', () => {
    const y = section(40, 220, 1330, 7);
    const natural = segmentsOf(y);
    const spread = segmentsSpread(y, natural.length + 5);
    expect(offsetsOf(spread)).toEqual(offsetsOf(natural));
  });

  it('never returns more windows than the budget allows', () => {
    const y = song();
    expect(segmentsOf(y).length).toBeGreaterThan(8);
    expect(segmentsSpread(y, 8).length).toBe(8);
  });

  it('still reaches both the first and the last moment of the song', () => {
    const y = song();
    const spread = segmentsSpread(y, 6);
    const offs = offsetsOf(spread);
    expect(offs[0]).toBe(0);
    expect(offs[offs.length - 1]! + SEGMENT).toBe(y.length);
  });

  it('never samples the same window twice, so the mean is not weighted by accident', () => {
    const y = song();
    const offs = offsetsOf(segmentsSpread(y, 9));
    expect(new Set(offs).size).toBe(offs.length);
    for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThan(offs[i - 1]!);
  });

  it('keeps every window a whole segment inside the signal', () => {
    const y = song();
    for (const s of segmentsSpread(y, 7)) {
      expect(s.length).toBe(SEGMENT);
      expect(s.byteOffset / 4 + SEGMENT).toBeLessThanOrEqual(y.length);
    }
  });

  it('does not pretend a budget of one is coverage: it is still the first window', () => {
    const y = song();
    expect(offsetsOf(segmentsSpread(y, 1))).toEqual([0]);
  });

  it('falls back to the ordinary single padded window for a clip shorter than one segment', () => {
    const y = section(4, 220, 1330, 9);
    expect(segmentsSpread(y, 8).length).toBe(1);
    expect(segmentsSpread(y, 8)[0]!.length).toBe(SEGMENT);
  });

  it('uses the ordinary hop when it is not over budget, so nothing is skipped', () => {
    const y = song();
    const natural = segmentsOf(y);
    const offs = offsetsOf(segmentsSpread(y, natural.length));
    expect(offs[1]! - offs[0]!).toBe(HOP);
  });
});

describe('the vector store records what was embedded (FULL-SONG-EMBED-001)', () => {
  it('reports the provenance it was given, so a preview vector can be told from a full song', async () => {
    const store = await Store.open(new MemoryBackend());
    await store.vectorPut('track:abc', 'm', 'p', new Float32Array([1, 0, 0]), 'local-full-song-8seg');
    expect(store.vectorSource('track:abc', 'm', 'p')).toBe('local-full-song-8seg');
  });

  it('reports nothing for a song it has never embedded', async () => {
    const store = await Store.open(new MemoryBackend());
    expect(store.vectorSource('track:missing', 'm', 'p')).toBeNull();
  });
});

const dir = new URL('../../../.data/models/', import.meta.url);
const haveModel = existsSync(new URL('model_epoch_36.onnx.data', dir));

describe.skipIf(!haveModel)('the model actually hears more of the song (FULL-SONG-EMBED-001)', () => {
  it('describes the song better from a spread sample than from its first 30 seconds', async () => {
    const ort = (await import('onnxruntime-web')) as unknown as OrtLike;
    const enc = new Encoder(ort, async () => ({
      model: new Uint8Array(readFileSync(new URL('model_epoch_36.onnx', dir))),
      data: new Uint8Array(readFileSync(new URL('model_epoch_36.onnx.data', dir))),
    }));
    const y = song();
    const preview = y.subarray(0, 30 * SR);

    const whole = await enc.embedAudio(y);
    const first30 = await enc.embedAudio(preview);
    const spread = await enc.embedAudio(y, undefined, 8);

    expect(whole.segments).toBeGreaterThan(first30.segments * 3);
    expect(spread.segments).toBe(8);

    const previewLikeness = cosine(first30.vector, whole.vector);
    const spreadLikeness = cosine(spread.vector, whole.vector);
    console.log('cosine(first30, whole) =', previewLikeness, ' cosine(spread8, whole) =', spreadLikeness);

    // The premise: a 30-second window really does misdescribe this song.
    expect(previewLikeness).toBeLessThan(0.99);
    // The point: a bounded spread is a far better stand-in for the whole song.
    expect(spreadLikeness).toBeGreaterThan(previewLikeness);
    expect(spreadLikeness).toBeGreaterThan(0.99);
  }, 600_000);
});
