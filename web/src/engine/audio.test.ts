import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tones } from './testsignal';
import { int16RoundTrip, logMel, melFilterbank, segmentsOf, stripId3v2, trimSilence } from './audio';

const g = JSON.parse(readFileSync(new URL('./golden/audio.json', import.meta.url), 'utf8'));

describe('audio front end vs the Python implementation', () => {
  it('builds the same Slaney mel filterbank', () => {
    const fb = melFilterbank();
    expect(fb.length).toBe(g.filterbank.shape[0]);
    expect(fb[0]!.length).toBe(g.filterbank.shape[1]);
    for (const [i, row] of Object.entries<number[]>(g.filterbank.rows)) {
      for (let k = 0; k < row.length; k++) expect(fb[Number(i)]![k]!).toBeCloseTo(row[k]!, 6);
    }
    let sum = 0;
    for (const r of fb) for (const v of r) sum += v;
    expect(Math.abs(sum - g.filterbank.sum) / g.filterbank.sum).toBeLessThan(1e-5);
  });

  it('segments at every boundary like Python', () => {
    for (const [total, expected] of Object.entries<[number, number][]>(g.segments)) {
      const y = Float32Array.from({ length: Number(total) }, (_, i) => i);
      const parts = segmentsOf(y).map((p) => [p[0], p.length]);
      expect(parts).toEqual(expected);
    }
  });

  it('strips stacked ID3v2 tags', () => {
    const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
    const out = stripId3v2(hex(g.id3.input_hex));
    expect(Array.from(out).map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(g.id3.output_hex);
  });

  it('round-trips int16 like Python', () => {
    const input = Float32Array.from(g.int16.in_head);
    const out = int16RoundTrip(input);
    for (let i = 0; i < out.length; i++) expect(out[i]!).toBeCloseTo(g.int16.out_head[i], 7);
  });

  it('trims silence to the same length', () => {
    const y = new Float32Array(48000 + 3 * 48000 + 96000);
    y.set(tones(3, 2), 48000);
    const out = trimSilence(int16RoundTrip(y));
    expect(out.length).toBe(g.trim.out_len);
  });

  it('computes the same log-mel for the same signal', () => {
    const { data, frames } = logMel(tones(10, 1));
    expect(frames).toBe(g.log_mel.shape[1]);
    expect(data.length).toBe(g.log_mel.shape[0] * g.log_mel.shape[1]);
    for (let m = 0; m < 128; m++) {
      for (let f = 0; f < 3; f++) expect(Math.abs(data[m * frames + f]! - g.log_mel.head[m][f])).toBeLessThan(0.05);
      for (let f = 0; f < 2; f++) expect(Math.abs(data[m * frames + 500 + f]! - g.log_mel.mid[m][f])).toBeLessThan(0.05);
    }
    let sum = 0;
    for (const v of data) sum += v;
    expect(Math.abs(sum / data.length - g.log_mel.mean)).toBeLessThan(0.01);
  });
});
