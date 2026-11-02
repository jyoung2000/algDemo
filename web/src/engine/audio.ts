/**
 * Audio embeddings front end (port of server/airwave_discovery/audio.py): everything except decoding and
 * the ONNX session, which are in decode.ts and encoder.ts because they need browser APIs.
 *
 * Preprocessing follows AudioMuse-AI-DCLAP's README: 48 kHz mono, int16 round-trip, 10 s segments with 50 %
 * overlap, 128-band Slaney mel (n_fft 2048, hop 480, fmin 0, fmax 14 kHz, power 2), power_to_db(ref=1,
 * amin=1e-10, top_db=None). Vectors are stored with MODEL_ID and PREPROCESS_ID and never compared across them.
 */
export const MODEL_ID = 'audiomuse-dclap-v1-epoch36';
export const PREPROCESS_ID = 'sr48k-int16-seg10s-hop5s-tail1-mel128-nfft2048-hop480-f0-14k-db';
export const DIM = 512;
export const SR = 48_000;
export const SEGMENT = 480_000;
export const HOP = 240_000;
export const N_MELS = 128;
export const N_FFT = 2048;
export const HOP_MELS = 480;
export const FMAX = 14_000;

export const MODEL_FILES: Record<string, { sha256: string; size: number }> = {
  'model_epoch_36.onnx': { sha256: '17860403f8fc90aff8ac0632a0741eb5e58d8c0b0ad2fce5ced967274b0ea971', size: 1_243_778 },
  'model_epoch_36.onnx.data': { sha256: '2a735b23c2aad7b12d9ffc85334cebcc659c07696d2ff60e2e378da28b6df657', size: 21_168_128 },
};
export const MODEL_DOWNLOAD_BYTES = Object.values(MODEL_FILES).reduce((a, f) => a + f.size, 0);

const LOG_STEP = Math.log(6.4) / 27;
const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;

const hzToMel = (f: number): number => (f >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(Math.max(f, 1e-10) / MIN_LOG_HZ) / LOG_STEP : f / F_SP);
const melToHz = (m: number): number => (m >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOG_STEP * (m - MIN_LOG_MEL)) : F_SP * m);

/** librosa.filters.mel(sr, n_fft, n_mels, fmin, fmax, htk=False, norm='slaney'), rows of length n_fft/2+1. */
export function melFilterbank(sr = SR, nFft = N_FFT, nMels = N_MELS, fmin = 0, fmax = FMAX): Float32Array[] {
  const bins = 1 + nFft / 2;
  const fft = new Float64Array(bins).map((_, i) => (i * sr) / nFft);
  const lo = hzToMel(fmin);
  const hi = hzToMel(fmax);
  const melF = Array.from({ length: nMels + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (nMels + 1)));
  const fdiff = melF.slice(1).map((v, i) => v - melF[i]!);
  const rows: Float32Array[] = [];
  for (let i = 0; i < nMels; i++) {
    const row = new Float64Array(bins);
    const enorm = 2 / (melF[i + 2]! - melF[i]!);
    for (let k = 0; k < bins; k++) {
      const lower = -(melF[i]! - fft[k]!) / fdiff[i]!;
      const upper = (melF[i + 2]! - fft[k]!) / fdiff[i + 1]!;
      row[k] = Math.max(0, Math.min(lower, upper)) * enorm;
    }
    rows.push(Float32Array.from(row));
  }
  return rows;
}

let mel: Float32Array[] | null = null;
/** Per mel row, the first and one-past-last FFT bin with a non-zero weight (a Slaney triangle is narrow). */
let melSpan: Int32Array | null = null;
let window: Float64Array | null = null;
let twiddle: { cos: Float64Array; sin: Float64Array; rev: Uint32Array } | null = null;

function tables() {
  if (!mel) {
    mel = melFilterbank();
    melSpan = new Int32Array(mel.length * 2);
    mel.forEach((row, m) => {
      let lo = 0;
      let hi = row.length;
      while (lo < hi && row[lo] === 0) lo++;
      while (hi > lo && row[hi - 1] === 0) hi--;
      melSpan![m * 2] = lo;
      melSpan![m * 2 + 1] = hi;
    });
  }
  window ??= Float64Array.from({ length: N_FFT }, (_, i) => Math.fround(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT)));
  if (!twiddle) {
    const half = N_FFT / 2;
    const rev = new Uint32Array(N_FFT);
    const bitsN = Math.log2(N_FFT);
    for (let i = 0; i < N_FFT; i++) {
      let r = 0;
      for (let b = 0; b < bitsN; b++) if (i & (1 << b)) r |= 1 << (bitsN - 1 - b);
      rev[i] = r;
    }
    twiddle = {
      cos: Float64Array.from({ length: half }, (_, k) => Math.cos((-2 * Math.PI * k) / N_FFT)),
      sin: Float64Array.from({ length: half }, (_, k) => Math.sin((-2 * Math.PI * k) / N_FFT)),
      rev,
    };
  }
  return { mel, window, twiddle, span: melSpan! };
}

/** In-place radix-2 complex FFT of length N_FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const { twiddle: t } = tables();
  const n = N_FFT;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i]!;
    if (j > i) {
      const a = re[i]!;
      re[i] = re[j]!;
      re[j] = a;
      const b = im[i]!;
      im[i] = im[j]!;
      im[j] = b;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = t.cos[k * step]!;
        const wi = t.sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
}

/** numpy "reflect" padding index (edge not repeated). */
const reflect = (i: number, n: number): number => {
  const period = 2 * (n - 1);
  let r = ((i % period) + period) % period;
  if (r >= n) r = period - r;
  return r;
};

/** (n_mels x frames) log-power mel for one segment, center=True with reflect padding, row-major. */
export function logMel(segment: Float32Array): { data: Float32Array; frames: number } {
  const { mel: fb, window: win, span } = tables();
  const pad = N_FFT / 2;
  const padded = segment.length + 2 * pad;
  const frames = 1 + Math.floor((padded - N_FFT) / HOP_MELS);
  const bins = 1 + N_FFT / 2;
  const out = new Float32Array(N_MELS * frames);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const power = new Float32Array(bins);
  for (let f = 0; f < frames; f++) {
    const base = f * HOP_MELS;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = Math.fround(segment[reflect(base + i - pad, segment.length)]! * win[i]!);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) power[k] = Math.fround(re[k]! * re[k]! + im[k]! * im[k]!);
    for (let m = 0; m < N_MELS; m++) {
      const row = fb[m]!;
      let acc = 0;
      // Only the bins the triangle covers: the rest add exactly 0, so the sum is unchanged.
      for (let k = span[m * 2]!, end = span[m * 2 + 1]!; k < end; k++) acc += row[k]! * power[k]!;
      out[m * frames + f] = 10 * Math.log10(Math.max(1e-10, acc));
    }
  }
  return { data: out, frames };
}

export function segmentsOf(y: Float32Array): Float32Array[] {
  const total = y.length;
  if (total <= SEGMENT) {
    const seg = new Float32Array(SEGMENT);
    seg.set(y);
    return [seg];
  }
  const segs: Float32Array[] = [];
  let last = 0;
  for (let s = 0; s + SEGMENT <= total; s += HOP) {
    segs.push(y.subarray(s, s + SEGMENT));
    last = s;
  }
  if (last + SEGMENT < total) segs.push(y.subarray(total - SEGMENT)); // cover the tail once
  return segs;
}

/** Remove leading ID3v2 tags (some decoders reject a zero-length tag). */
export function stripId3v2(data: Uint8Array): Uint8Array {
  let d = data;
  while (d.length >= 10 && d[0] === 0x49 && d[1] === 0x44 && d[2] === 0x33) {
    const size = (d[6]! << 21) | (d[7]! << 14) | (d[8]! << 7) | d[9]!;
    const footer = d[5]! & 0x10 ? 10 : 0;
    d = d.subarray(10 + size + footer);
  }
  return d;
}

/** Clip to [-1, 1] and round-trip through int16, as the model's README prescribes. */
export function int16RoundTrip(y: Float32Array): Float32Array {
  const out = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) {
    const c = Math.max(-1, Math.min(1, y[i]!));
    out[i] = Math.fround(Math.trunc(Math.fround(c * 32767)) / 32767);
  }
  return out;
}

/** Drop leading and trailing near-silence so a quiet intro does not dominate a short excerpt. */
export function trimSilence(y: Float32Array, thresholdDb = -45, frame = 4800): Float32Array {
  if (y.length < frame * 4) return y;
  const n = Math.floor(y.length / frame);
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) s += y[j]! * y[j]!;
    const db = 20 * Math.log10(Math.sqrt(s / frame + 1e-12) + 1e-12);
    if (db > thresholdDb) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return y.subarray(0, 0);
  return y.subarray(first * frame, (last + 1) * frame);
}

/**
 * Tempo from the audio itself, for songs whose catalogue entry has no BPM (Deezer reports 0 for many).
 * Energy-onset envelope at 100 Hz, autocorrelated over 70-180 BPM, with a mild preference for the
 * common 90-150 range so a half or double tempo is not picked over the felt one. Returns null when
 * the beat is not clear enough to claim (talking, ambient, too short).
 */
export function estimateBpm(y: Float32Array, sr = SR): number | null {
  const hop = Math.round(sr / 100);
  const win = hop * 2;
  const frames = Math.floor((y.length - win) / hop);
  if (frames < 600) return null; // under ~6 s
  const env = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let j = i * hop; j < i * hop + win; j++) s += y[j]! * y[j]!;
    env[i] = Math.log1p(1000 * Math.sqrt(s / win));
  }
  const onset = new Float64Array(frames);
  for (let i = 1; i < frames; i++) onset[i] = Math.max(0, env[i]! - env[i - 1]!);
  // remove the slow trend so loud passages do not dominate
  const w = 50;
  const flat = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let m = 0;
    let n = 0;
    for (let j = Math.max(0, i - w); j < Math.min(frames, i + w + 1); j++, n++) m += onset[j]!;
    flat[i] = Math.max(0, onset[i]! - m / n);
  }
  let energy = 0;
  for (let i = 0; i < frames; i++) energy += flat[i]! * flat[i]!;
  if (energy < 1e-9) return null;
  const minLag = Math.floor(6000 / 180);
  const maxLag = Math.ceil(6000 / 70);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < frames; i++) s += flat[i]! * flat[i - lag]!;
    ac[lag] = s / (frames - lag);
  }
  let best = -1;
  let bestScore = 0;
  let sum = 0;
  let count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 6000 / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.85) ** 2);
    const sc = ac[lag]! * (0.55 + 0.45 * prior);
    sum += ac[lag]!;
    count++;
    if (ac[lag]! >= ac[lag - 1]! && ac[lag]! >= ac[lag + 1]! && sc > bestScore) {
      best = lag;
      bestScore = sc;
    }
  }
  if (best < 0) return null;
  // the peak has to stand clear of the average correlation, or there is no steady beat to report
  if (ac[best]! < 1.6 * (sum / count)) return null;
  const a0 = ac[best - 1]!;
  const b0 = ac[best]!;
  const c0 = ac[best + 1]!;
  const d = a0 - 2 * b0 + c0;
  const lag = best + (d !== 0 ? (0.5 * (a0 - c0)) / d : 0);
  const bpm = 6000 / lag;
  return Math.round(bpm * 10) / 10;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / ((Math.sqrt(na) || 1e-9) * (Math.sqrt(nb) || 1e-9));
}

/** Mean of segment embeddings, L2-normalised (what Encoder.embed_audio returns as the vector). */
export function meanNormalise(embs: ArrayLike<number>[]): Float32Array {
  const v = new Float32Array(embs[0]!.length);
  for (const e of embs) for (let i = 0; i < v.length; i++) v[i] = v[i]! + e[i]!;
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] = Math.fround(v[i]! / embs.length);
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm) + 1e-9;
  for (let i = 0; i < v.length; i++) v[i] = Math.fround(v[i]! / norm);
  return v;
}
