/**
 * Audio fingerprint for song identification: 16 kHz mono PCM in, Shazam "signature" data URI out.
 * The sound itself never leaves the device; only this list of spectral peaks is sent.
 *
 * This is a TypeScript port of the algorithm in SongRec (https://github.com/marin-m/SongRec, GPL-3.0-or-later,
 * src/core/fingerprinting/algorithm.rs and signature_format.rs, commit 40372e5), itself a re-implementation of
 * Shazam's published-by-reverse-engineering signature format. The derived-work notice is in docs/LICENSES.md; the
 * apps that ship this file are AGPL-3.0, which GPL-3.0 section 13 allows to be combined.
 * Differences from the Rust original: the Hanning window is computed (the Rust file lists a 2048-entry table
 * of the same function); arithmetic is float32 where the original is, via Math.fround, but the FFT is a
 * radix-2 transform of our own, so a borderline peak can differ in the last bit.
 */

export const SAMPLE_RATE = 16_000;
export const WINDOW_SECONDS = 12;
const FFT_SIZE = 2048;
const BINS = 1025;
const HOP = 128;
const DATA_URI_PREFIX = 'data:audio/vnd.shazam.sig;base64,';

export interface FrequencyPeak {
  pass: number;
  magnitude: number;
  bin: number;
}

export interface Signature {
  sampleRate: number;
  numberSamples: number;
  /** Four bands: 250-520 Hz, 520-1450 Hz, 1450-3500 Hz, 3500-5500 Hz. */
  bands: [FrequencyPeak[], FrequencyPeak[], FrequencyPeak[], FrequencyPeak[]];
}

const f = Math.fround;

// Hanning window as SongRec lists it: periodic over 2049 points with the zero ends dropped.
const HANN = new Float32Array(FFT_SIZE);
for (let n = 0; n < FFT_SIZE; n++) HANN[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (n + 1)) / (FFT_SIZE + 1));

// Radix-2 FFT of size 2048, real input, first 1025 bins out.
const COS = new Float64Array(FFT_SIZE / 2);
const SIN = new Float64Array(FFT_SIZE / 2);
for (let i = 0; i < FFT_SIZE / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE);
  SIN[i] = -Math.sin((2 * Math.PI * i) / FFT_SIZE);
}
const REV = new Uint16Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  let r = 0;
  for (let b = 0; b < 11; b++) if (i & (1 << b)) r |= 1 << (10 - b);
  REV[i] = r;
}
const RE = new Float64Array(FFT_SIZE);
const IM = new Float64Array(FFT_SIZE);

function fft(input: Float32Array): void {
  for (let i = 0; i < FFT_SIZE; i++) {
    RE[REV[i]!] = input[i]!;
    IM[REV[i]!] = 0;
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1;
    const step = FFT_SIZE / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = start + k;
        const b = a + half;
        const tr = RE[b]! * COS[t]! - IM[b]! * SIN[t]!;
        const ti = RE[b]! * SIN[t]! + IM[b]! * COS[t]!;
        RE[b] = RE[a]! - tr;
        IM[b] = IM[a]! - ti;
        RE[a] = RE[a]! + tr;
        IM[a] = IM[a]! + ti;
      }
    }
  }
}

const toI16 = (v: number): number => {
  const s = Math.round(v * 32768);
  return s > 32767 ? 32767 : s < -32768 ? -32768 : s;
};

/** Offsets (in spread frames) the time-domain local-maximum test looks at, from SongRec. */
const OTHER_OFFSETS = [-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249];
const NEIGHBOUR_OFFSETS = [-10, -7, -4, -3, 1, 2, 5, 8];

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortError';
  }
}

/**
 * Fingerprint exactly the samples given (16 kHz mono, -1..1). Yields to the event loop every ~64 frames
 * so a Cancel tap is handled while a 12 s clip is being processed.
 */
export async function makeSignature(samples: Float32Array, signal?: AbortSignal): Promise<Signature> {
  const ring = new Int16Array(FFT_SIZE);
  let ringIndex = 0;
  const reordered = new Float32Array(FFT_SIZE);
  const fftOut: Float32Array[] = Array.from({ length: 256 }, () => new Float32Array(BINS));
  let fftIndex = 0;
  const spreadOut: Float32Array[] = Array.from({ length: 256 }, () => new Float32Array(BINS));
  let spreadIndex = 0;
  let spreadDone = 0;
  const bands: Signature['bands'] = [[], [], [], []];
  const copy = new Float32Array(BINS);

  const frames = Math.floor(samples.length / HOP);
  for (let frame = 0; frame < frames; frame++) {
    if (frame % 64 === 0) {
      if (signal?.aborted) throw new Cancelled();
      if (frame) await new Promise<void>((r) => setTimeout(r, 0));
    }
    // 1. 128 new samples into the ring, reorder oldest to newest, window, transform.
    for (let i = 0; i < HOP; i++) ring[ringIndex + i] = toI16(samples[frame * HOP + i]!);
    ringIndex = (ringIndex + HOP) & 2047;
    for (let i = 0; i < FFT_SIZE; i++) reordered[i] = f(ring[(i + ringIndex) & 2047]! * HANN[i]!);
    fft(reordered);
    const power = fftOut[fftIndex]!;
    for (let i = 0; i < BINS; i++) power[i] = f(Math.max((RE[i]! * RE[i]! + IM[i]! * IM[i]!) / 131072, 1e-10));
    fftIndex = (fftIndex + 1) & 255;

    // 2. Spread the newest frame in frequency, then back into the three earlier frames in time.
    const latest = fftOut[(fftIndex - 1) & 255]!;
    const spread = spreadOut[spreadIndex]!;
    spread.set(latest);
    for (let p = 0; p <= 1022; p++) spread[p] = Math.max(spread[p]!, spread[p + 1]!, spread[p + 2]!);
    copy.set(spread);
    for (const back of [1, 3, 6]) {
      const former = spreadOut[(spreadIndex - back) & 255]!;
      for (let p = 0; p <= 1024; p++) if (copy[p]! > former[p]!) former[p] = copy[p]!;
    }
    spreadIndex = (spreadIndex + 1) & 255;
    spreadDone++;

    // 3. Once 46 frames exist, look for peaks in the frame 46 back.
    if (spreadDone >= 46) {
      const at46 = fftOut[(fftIndex - 46) & 255]!;
      const spread49 = spreadOut[(spreadIndex - 49) & 255]!;
      for (let bin = 10; bin <= 1014; bin++) {
        const v = at46[bin]!;
        if (!(v >= 1 / 64 && v >= spread49[bin - 1]!)) continue;
        let maxNeighbour = 0;
        for (const o of NEIGHBOUR_OFFSETS) maxNeighbour = Math.max(maxNeighbour, spread49[bin + o]!);
        if (!(v > maxNeighbour)) continue;
        let maxOther = maxNeighbour;
        for (const o of OTHER_OFFSETS) maxOther = Math.max(maxOther, spreadOut[(spreadIndex + o) & 255]![bin - 1]!);
        if (!(v > maxOther)) continue;

        const mag = f(f(Math.max(Math.log(v), 1 / 64)) * 1477.3 + 6144);
        const before = f(f(Math.max(Math.log(at46[bin - 1]!), 1 / 64)) * 1477.3 + 6144);
        const after = f(f(Math.max(Math.log(at46[bin + 1]!), 1 / 64)) * 1477.3 + 6144);
        const variation1 = mag * 2 - before - after;
        if (!(variation1 >= 0)) continue; // the original asserts; a flat or odd peak is skipped instead of crashing
        const variation2 = ((after - before) * 32) / variation1;
        const corrected = (bin * 64 + Math.trunc(variation2)) & 0xffff;
        const hz = corrected * (16000 / 2 / 1024 / 64);
        const band = hz >= 250 && hz < 520 ? 0 : hz >= 520 && hz < 1450 ? 1 : hz >= 1450 && hz < 3500 ? 2 : hz >= 3500 && hz < 5501 ? 3 : null;
        if (band === null) continue;
        bands[band].push({ pass: spreadDone - 46, magnitude: Math.max(0, Math.min(65535, Math.trunc(mag))), bin: corrected });
      }
    }
  }
  return { sampleRate: SAMPLE_RATE, numberSamples: frames * HOP, bands };
}

/**
 * The 12 s window SongRec sends: the clip padded with silence to 12 s if shorter, otherwise the 12 s around its middle
 * (a song's opening is often quiet, so the middle identifies more files than the start does).
 */
export function pickWindow(samples: Float32Array): Float32Array {
  const want = WINDOW_SECONDS * SAMPLE_RATE;
  if (samples.length < want) {
    const out = new Float32Array(want);
    out.set(samples);
    return out;
  }
  if (samples.length === want) return samples;
  const middle = Math.floor(samples.length / 2);
  return samples.subarray(middle - want / 2, middle + want / 2);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The binary signature (little-endian), as signature_format.rs writes it. */
export function encodeSignature(sig: Signature): Uint8Array {
  const chunks: number[] = [];
  const u32 = (v: number) => chunks.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const u16 = (v: number) => chunks.push(v & 0xff, (v >>> 8) & 0xff);
  const rateId = ({ 8000: 1, 11025: 2, 16000: 3, 32000: 4, 44100: 5, 48000: 6 } as Record<number, number>)[sig.sampleRate];
  if (!rateId) throw new Error(`unsupported sample rate ${sig.sampleRate}`);

  u32(0xcafe2580);
  u32(0); // crc32, patched below
  u32(0); // size minus header, patched below
  u32(0x94119c00);
  u32(0); u32(0); u32(0);
  u32((rateId << 27) >>> 0);
  u32(0); u32(0);
  u32(sig.numberSamples + Math.trunc(sig.sampleRate * 0.24));
  u32((15 << 19) + 0x40000);
  u32(0x40000000);
  u32(0); // size minus header again, patched below

  sig.bands.forEach((peaks, band) => {
    if (!peaks.length) return;
    const body: number[] = [];
    let pass = 0;
    for (const p of peaks) {
      if (p.pass - pass >= 255) {
        body.push(0xff, p.pass & 0xff, (p.pass >>> 8) & 0xff, (p.pass >>> 16) & 0xff, (p.pass >>> 24) & 0xff);
        pass = p.pass;
      }
      body.push(p.pass - pass, p.magnitude & 0xff, (p.magnitude >>> 8) & 0xff, p.bin & 0xff, (p.bin >>> 8) & 0xff);
      pass = p.pass;
    }
    u32(0x60030040 + band);
    u32(body.length);
    for (const b of body) chunks.push(b);
    for (let i = 0; i < (4 - (body.length % 4)) % 4; i++) chunks.push(0);
  });

  const out = Uint8Array.from(chunks);
  const view = new DataView(out.buffer);
  view.setUint32(8, out.length - 48, true);
  view.setUint32(52, out.length - 48, true);
  view.setUint32(4, crc32(out.subarray(8)), true);
  return out;
}

export function signatureUri(sig: Signature): string {
  const bytes = encodeSignature(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return DATA_URI_PREFIX + btoa(bin);
}

export const signatureMillis = (sig: Signature): number => Math.trunc((sig.numberSamples / sig.sampleRate) * 1000);

export const peakCount = (sig: Signature): number => sig.bands.reduce((n, b) => n + b.length, 0);
