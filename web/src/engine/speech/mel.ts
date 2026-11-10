/**
 * VOICE-SEARCH-001: Whisper's log-mel front end, a port of transformers' WhisperFeatureExtractor
 * (numpy path): 16 kHz audio padded to 30 s, a 400-point periodic Hann window every 160 samples
 * (centred, reflect-padded), the power spectrum through 80 Slaney mel filters from 0 to 8 kHz, log10
 * floored at 1e-10, clamped to 8 below the peak, then (x + 4) / 4. Checked against the Python
 * extractor in whisper.test.ts.
 */
export const SAMPLE_RATE = 16_000;
export const N_SAMPLES = 480_000;
export const N_FFT = 400;
export const HOP = 160;
export const N_MELS = 80;
export const N_FRAMES = 3000;
const BINS = N_FFT / 2 + 1;

const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + (Math.log(f / 1000) * 27) / Math.log(6.4));
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp(((m - 15) * Math.log(6.4)) / 27));

let filters: Float64Array[] | null = null;
/** transformers' mel_filter_bank(201, 80, 0, 8000, 16000, norm="slaney", mel_scale="slaney"). */
export function melFilters(): Float64Array[] {
  if (filters) return filters;
  const lo = hzToMel(0), hi = hzToMel(SAMPLE_RATE / 2);
  const pts = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (N_MELS + 1)));
  filters = Array.from({ length: N_MELS }, (_, m) => {
    const f = new Float64Array(BINS);
    const enorm = 2 / (pts[m + 2]! - pts[m]!);
    for (let k = 0; k < BINS; k++) {
      const hz = (k * SAMPLE_RATE) / 2 / (BINS - 1);
      const down = (hz - pts[m]!) / (pts[m + 1]! - pts[m]!);
      const up = (pts[m + 2]! - hz) / (pts[m + 2]! - pts[m + 1]!);
      f[k] = Math.max(0, Math.min(down, up)) * enorm;
    }
    return f;
  });
  return filters;
}

/** A mixed-radix complex FFT for N = 400 (2^4 * 5^2), recursive on the smallest factor. */
function fft(re: Float64Array, im: Float64Array, n: number, stride: number, off: number, outRe: Float64Array, outIm: Float64Array, o: number): void {
  if (n === 1) {
    outRe[o] = re[off]!;
    outIm[o] = im[off]!;
    return;
  }
  const p = n % 2 === 0 ? 2 : n % 5 === 0 ? 5 : n;
  const m = n / p;
  for (let r = 0; r < p; r++) fft(re, im, m, stride * p, off + r * stride, outRe, outIm, o + r * m);
  const tr = new Float64Array(p), ti = new Float64Array(p);
  for (let k = 0; k < m; k++) {
    for (let r = 0; r < p; r++) {
      tr[r] = outRe[o + r * m + k]!;
      ti[r] = outIm[o + r * m + k]!;
    }
    for (let q = 0; q < p; q++) {
      const kk = k + q * m;
      let sr = 0, si = 0;
      for (let r = 0; r < p; r++) {
        const a = (-2 * Math.PI * r * kk) / n;
        const c = Math.cos(a), s = Math.sin(a);
        sr += tr[r]! * c - ti[r]! * s;
        si += tr[r]! * s + ti[r]! * c;
      }
      outRe[o + kk] = sr;
      outIm[o + kk] = si;
    }
  }
}

/** [80 * 3000] row-major (mel, frame): the encoder's `input_features` for one clip. */
export function logMel(samples: Float32Array): Float32Array {
  const y = new Float64Array(N_SAMPLES);
  y.set(samples.subarray(0, N_SAMPLES));
  const pad = N_FFT / 2;
  // Reflect padding, as numpy.pad(mode="reflect").
  const at = (i: number) => (i < 0 ? y[-i]! : i >= N_SAMPLES ? y[2 * (N_SAMPLES - 1) - i]! : y[i]!);
  const win = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
  const fb = melFilters();
  const out = new Float32Array(N_MELS * N_FRAMES);
  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT), oRe = new Float64Array(N_FFT), oIm = new Float64Array(N_FFT);
  const power = new Float64Array(BINS);
  // Frames past the end of the sound see only zeros: their mel energy is the floor, so skip the FFT.
  const lastLive = Math.min(N_FRAMES - 1, Math.ceil((samples.length + pad) / HOP));
  let peak = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    if (t > lastLive) {
      for (let m = 0; m < N_MELS; m++) out[m * N_FRAMES + t] = -10;
      continue;
    }
    for (let i = 0; i < N_FFT; i++) {
      re[i] = at(t * HOP + i - pad) * win[i]!;
      im[i] = 0;
    }
    fft(re, im, N_FFT, 1, 0, oRe, oIm, 0);
    for (let k = 0; k < BINS; k++) power[k] = oRe[k]! * oRe[k]! + oIm[k]! * oIm[k]!;
    for (let m = 0; m < N_MELS; m++) {
      const f = fb[m]!;
      let e = 0;
      for (let k = 0; k < BINS; k++) e += f[k]! * power[k]!;
      const v = Math.log10(Math.max(1e-10, e));
      out[m * N_FRAMES + t] = v;
      if (v > peak) peak = v;
    }
  }
  const floor = Math.max(peak, -10) - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i]!, floor) + 4) / 4;
  return out;
}
