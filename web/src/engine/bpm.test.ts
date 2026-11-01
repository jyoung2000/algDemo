import { describe, expect, it } from 'vitest';
import { SR, estimateBpm } from './audio';

/** Kick-like bursts at a steady tempo over low noise, 30 s like a preview. */
function clicks(bpm: number, seconds = 30, jitterMs = 0): Float32Array {
  const y = new Float32Array(SR * seconds);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < y.length; i++) y[i] = (rnd() - 0.5) * 0.01;
  const step = (60 / bpm) * SR;
  for (let t = 0; t < y.length; t += step) {
    const at = Math.round(t + (rnd() - 0.5) * 2 * jitterMs * (SR / 1000));
    for (let k = 0; k < 2400 && at + k < y.length && at >= 0; k++) y[at + k]! += 0.8 * Math.exp(-k / 500) * Math.sin((2 * Math.PI * 60 * k) / SR + 1.2);
  }
  return y;
}

describe('estimateBpm', () => {
  for (const bpm of [80, 100, 120, 128, 140]) {
    it(`finds ${bpm} BPM within 1.5`, () => {
      const got = estimateBpm(clicks(bpm));
      expect(got).not.toBeNull();
      expect(Math.abs(got! - bpm)).toBeLessThan(1.5);
    });
  }
  it('survives a little timing jitter', () => {
    const got = estimateBpm(clicks(110, 30, 8));
    expect(got).not.toBeNull();
    expect(Math.abs(got! - 110)).toBeLessThan(3);
  });
  it('says nothing for noise or silence or a clip that is too short', () => {
    const noise = new Float32Array(SR * 30);
    let s = 3;
    for (let i = 0; i < noise.length; i++) noise[i] = (((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5) * 0.4;
    expect(estimateBpm(noise)).toBeNull();
    expect(estimateBpm(new Float32Array(SR * 30))).toBeNull();
    expect(estimateBpm(clicks(120, 3))).toBeNull();
  });
});
