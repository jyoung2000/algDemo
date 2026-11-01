/** The deterministic signal from tools/golden_audio.py (tones + integer-hash noise), as float32. */
export function tones(seconds: number, seed: number): Float32Array {
  const n = Math.floor(seconds * 48000);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 48000;
    let v = 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.25 * Math.sin(2 * Math.PI * 1330 * t) + 0.1 * Math.sin(2 * Math.PI * 6100 * t);
    v *= 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.7 * t);
    const h = Number((BigInt(i + seed * 7919) * 2654435761n) & 0xffffffffn);
    v += 0.02 * ((h / 4294967296) * 2 - 1);
    y[i] = Math.max(-1, Math.min(1, v));
  }
  return y;
}
