/**
 * DJ-XFADE-001 — what a DJ listens for before mixing two songs, measured from the audio itself.
 *
 * A crossfade anchored to the ends of the FILES blends one song's dying tail into the next song's
 * silence: on the owner's library the last 2.6 s of a typical song (median; 13 s at worst) sit more
 * than 12 dB under the song's own level. So the planner needs to know where the music really starts
 * and stops, and where the beats fall, and none of that is in the metadata.
 *
 * Everything here is pure arithmetic over mono PCM, so it is tested without an AudioContext and
 * ported line for line to Kotlin (engine/TrackCues.kt) for the phone's own player. Only the head and
 * the tail of a song are examined; nothing here looks at, or changes, the middle.
 */

/** A beat grid near one end of a song: tempo, one beat's time in the song, and how sure it is. */
export interface BeatGrid {
  bpm: number;
  /** A beat's position in seconds from the start of the song. */
  beatAt: number;
  /** 1 or more means the grid may be mixed on; less means do not claim a beat. */
  confidence: number;
}

export interface TrackCues {
  /** Length of the audio that was measured, in seconds. */
  duration: number;
  /** First audible sound. */
  start: number;
  /** Last audible sound. */
  end: number;
  /** Last moment the song is still at its own level; after it the song is fading or ringing out. */
  fullEnd: number;
  head: BeatGrid | null;
  tail: BeatGrid | null;
}

/** Rate the app decodes at for analysis. Beats and levels need nothing above 5 kHz. */
export const CUE_RATE = 11025;
export const HEAD_SECONDS = 45;
export const TAIL_SECONDS = 75;
/** A grid is trusted at this confidence (see `tempoOf`: autocorrelation strength and comb contrast). */
export const GRID_CONFIDENT = 1;

const ENVELOPE_SECONDS = 0.05;
/**
 * Silence, for mixing purposes, is this far under the song's body AND under SILENCE_FLOOR_DB. Both,
 * because a quiet ending of a dynamic piece is far under its loud passages and is still music.
 */
const SILENCE_DB = 40;
const SILENCE_FLOOR_DB = -60;
/** Within this of the body the song is still "on". */
const BODY_DB = 12;
const BODY_PERCENTILE = 0.7;
const FLUX_FPS = 86.1328125;
const MIN_BPM = 60;
const MAX_BPM = 180;
const PHASE_SECONDS = 20;
const TEMPO_SECONDS = 60;
const STRENGTH_FLOOR = 0.1;
const CONTRAST_FLOOR = 2.5;
/**
 * Two neighbouring stretches must put the beat in the same place to within this. On real songs it
 * is what separates a grid that predicts the next beats from one that has locked to the wrong
 * tempo or to a song whose rhythm is changing, which strength and contrast alone do not.
 */
const STABLE_SECONDS = 0.03;
/** The stretch at a song's very start or end that a blend is heard over. */
const EDGE_SECONDS = 10;

/** RMS level per 50 ms, in dB. */
export function envelopeDb(x: Float32Array, rate: number, from = 0, to = x.length): Float64Array {
  const size = Math.max(1, Math.floor(rate * ENVELOPE_SECONDS));
  const frames = Math.floor((to - from) / size);
  const out = new Float64Array(Math.max(0, frames));
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const base = from + f * size;
    for (let i = 0; i < size; i += 1) {
      const v = x[base + i]!;
      sum += v * v;
    }
    out[f] = 10 * Math.log10(sum / size + 1e-12);
  }
  return out;
}

function percentile(values: Float64Array, share: number): number {
  if (!values.length) return -120;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(share * (sorted.length - 1))]!;
}

/**
 * Onset strength per ~11.6 ms: the rise in level of the lows, mids and highs, with the local
 * average removed so a loud passage does not read as one long onset.
 */
export function onsetFlux(x: Float32Array, rate: number, from = 0, to = x.length): { flux: Float64Array; fps: number } {
  const hop = Math.max(1, Math.round(rate / FLUX_FPS));
  const fps = rate / hop;
  const frames = Math.floor((to - from) / hop);
  const raw = new Float64Array(Math.max(0, frames));
  const aLow = 1 - Math.exp((-2 * Math.PI * 200) / rate);
  const aMid = 1 - Math.exp((-2 * Math.PI * 2000) / rate);
  let low = 0;
  let wide = 0;
  let pLow = 0;
  let pMid = 0;
  let pHigh = 0;
  for (let f = 0; f < frames; f += 1) {
    let eLow = 0;
    let eMid = 0;
    let eHigh = 0;
    const base = from + f * hop;
    for (let i = 0; i < hop; i += 1) {
      const v = x[base + i]!;
      low += aLow * (v - low);
      wide += aMid * (v - wide);
      const mid = wide - low;
      const high = v - wide;
      eLow += low * low;
      eMid += mid * mid;
      eHigh += high * high;
    }
    const cLow = Math.log1p(100 * Math.sqrt(eLow / hop));
    const cMid = Math.log1p(100 * Math.sqrt(eMid / hop));
    const cHigh = Math.log1p(100 * Math.sqrt(eHigh / hop));
    raw[f] = f === 0 ? 0 : Math.max(0, cLow - pLow) + Math.max(0, cMid - pMid) + Math.max(0, cHigh - pHigh);
    pLow = cLow;
    pMid = cMid;
    pHigh = cHigh;
  }
  // Remove a one-second centred average (zero-padded at the ends) and keep what stands above it.
  const window = Math.max(1, Math.round(fps));
  const before = Math.floor(window / 2);
  const prefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i += 1) prefix[i + 1] = prefix[i]! + raw[i]!;
  const flux = new Float64Array(Math.max(0, frames));
  for (let i = 0; i < frames; i += 1) {
    const a = Math.max(0, i - before);
    const b = Math.min(frames, i - before + window);
    flux[i] = Math.max(0, raw[i]! - (prefix[b]! - prefix[a]!) / window);
  }
  return { flux, fps };
}

/** Value of `v` at a fractional index, linear between neighbours. */
const lerpAt = (v: Float64Array, at: number): number => {
  const i = Math.floor(at);
  if (i < 0 || i + 1 >= v.length) return 0;
  const frac = at - i;
  return v[i]! * (1 - frac) + v[i + 1]! * frac;
};

/** Tempo of an onset curve from its autocorrelation, or null when it is too short or flat. */
export function tempoOf(flux: Float64Array, fps: number): { bpm: number; strength: number } | null {
  const n = flux.length;
  if (n < fps * 8) return null;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += flux[i]!;
  mean /= n;
  const maxLag = Math.min(Math.floor(((fps * 60) / MIN_BPM) * 8) + 2, Math.floor(n / 2));
  const ac = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < n; i += 1) sum += (flux[i]! - mean) * (flux[i + lag]! - mean);
    ac[lag] = sum / (n - lag);
  }
  const zero = ac[0]!;
  if (!(zero > 0)) return null;
  for (let lag = 0; lag <= maxLag; lag += 1) ac[lag] = ac[lag]! / zero;
  const score = (bpm: number, multiples: number): number => {
    const lag = (fps * 60) / bpm;
    let sum = 0;
    let used = 0;
    for (let k = 1; k <= multiples; k += 1) {
      if (k * lag >= maxLag - 1) break;
      sum += lerpAt(ac, k * lag);
      used += 1;
    }
    return used ? sum / used : -Infinity;
  };
  // Half and double time score alike, so lean gently toward the middle of the range.
  let best = -Infinity;
  let bpm = 0;
  for (let step = MIN_BPM * 2; step <= MAX_BPM * 2; step += 1) {
    const candidate = step / 2;
    const fold = Math.log2(candidate / 118);
    const weighted = score(candidate, 4) * Math.exp(-0.5 * fold * fold);
    if (weighted > best) {
      best = weighted;
      bpm = candidate;
    }
  }
  if (!(best > 0)) return null;
  let fine = -Infinity;
  let refined = bpm;
  for (let d = -30; d <= 30; d += 1) {
    const candidate = bpm + d / 50;
    const s = score(candidate, 8);
    if (s > fine) {
      fine = s;
      refined = candidate;
    }
  }
  return { bpm: refined, strength: best };
}

/** Where the beats fall in an onset curve of known tempo: first beat's frame, and how clearly. */
export function phaseOf(flux: Float64Array, fps: number, bpm: number, from = 0, to = flux.length): { frame: number; contrast: number } | null {
  const lag = (fps * 60) / bpm;
  const n = to - from;
  const beats = Math.floor((n - 1) / lag) - 1;
  if (beats < 4) return null;
  const steps = Math.ceil(lag * 4);
  let best = -1;
  let bestAt = 0;
  let total = 0;
  for (let q = 0; q < steps; q += 1) {
    let sum = 0;
    for (let k = 0; k < beats; k += 1) {
      const at = q / 4 + lag * k;
      const i = Math.floor(at);
      const frac = at - i;
      sum += flux[from + i]! * (1 - frac) + flux[Math.min(from + i + 1, to - 1)]! * frac;
    }
    total += sum;
    if (sum > best) {
      best = sum;
      bestAt = q;
    }
  }
  return { frame: bestAt / 4, contrast: best / (total / steps + 1e-12) };
}

/** How far apart two beat times are on one grid, folded to the nearest beat: -beat/2 .. beat/2. */
export function beatError(a: number, b: number, beat: number): number {
  const wrapped = (((a - b) % beat) + beat) % beat;
  return wrapped > beat / 2 ? wrapped - beat : wrapped;
}

/**
 * A beat grid for `[from, from + 3 * third)` of an onset curve, from three equal stretches, pinned
 * to the `edge` seconds at one end of it — the part of the song a blend is actually heard over.
 *
 * Autocorrelation gives the tempo to about a tenth of a percent, which over half a minute is a
 * drift you can hear. So the first and last stretches fix the tempo exactly (the beat must fall in
 * the same place in both), and the middle one is the check: on a steady song it sits on that grid,
 * and on a song whose rhythm moves, or a tempo locked wrongly, it does not. Then the edge itself
 * must show the same beat: an intro or outro without the drums, or with them somewhere else, is
 * not a place to claim a beat. Measured on real songs, this is what a trusted grid means.
 */
function steadyGrid(flux: Float64Array, fps: number, tempo: { bpm: number; strength: number }, from: number, third: number, edge: 'start' | 'end') {
  const first = phaseOf(flux, fps, tempo.bpm, from, from + third);
  const middle = phaseOf(flux, fps, tempo.bpm, from + third, from + 2 * third);
  const last = phaseOf(flux, fps, tempo.bpm, from + 2 * third, from + 3 * third);
  if (!first || !middle || !last) return null;
  const a = from + first.frame;
  const m = from + third + middle.frame;
  const b = from + 2 * third + last.frame;
  const coarse = (fps * 60) / tempo.bpm;
  const beats = Math.round((b - a) / coarse);
  if (beats < 1) return null;
  const lag = (b - a) / beats;
  // A correction beyond one percent is not a refinement; the tempo was wrong.
  if (Math.abs(lag / coarse - 1) > 0.01) return null;
  const bpm = (fps * 60) / lag;
  const span = Math.min(third, Math.floor(EDGE_SECONDS * fps));
  const edgeFrom = edge === 'start' ? from : from + 3 * third - span;
  const near = phaseOf(flux, fps, bpm, edgeFrom, edgeFrom + span);
  if (!near) return null;
  const anchor = edgeFrom + near.frame;
  const drift = Math.max(Math.abs(beatError(m / fps, a / fps, lag / fps)), Math.abs(beatError(anchor / fps, (edge === 'start' ? a : b) / fps, lag / fps)));
  const contrast = Math.min(first.contrast, last.contrast, near.contrast);
  const confidence = Math.min(tempo.strength / STRENGTH_FLOOR, contrast / CONTRAST_FLOOR, STABLE_SECONDS / Math.max(drift, 1e-6));
  return { bpm, anchor, confidence };
}

/**
 * Measure a song. `mono` is the whole song, or at least its first and last minute, at `rate`.
 * `duration` is the song's real length when `mono` is only part of it (see `analyseEnds`).
 */
export function analyseCues(mono: Float32Array, rate: number): TrackCues {
  return analyseEnds(mono, mono, rate, mono.length / rate);
}

/**
 * The same measurement from the two ends alone: `head` is the song's first seconds and `tail` its
 * last, each as long as is available (up to HEAD_SECONDS / TAIL_SECONDS are used).
 */
export function analyseEnds(head: Float32Array, tail: Float32Array, rate: number, duration: number): TrackCues {
  const headTo = Math.min(head.length, Math.floor(HEAD_SECONDS * rate));
  const tailFrom = Math.max(0, tail.length - Math.floor(TAIL_SECONDS * rate));
  const tailOffset = duration - (tail.length - tailFrom) / rate;
  const size = Math.max(1, Math.floor(rate * ENVELOPE_SECONDS));
  const step = size / rate;

  const headEnv = envelopeDb(head, rate, 0, headTo);
  const headBody = percentile(headEnv, BODY_PERCENTILE);
  let first = 0;
  while (first < headEnv.length && !(headEnv[first]! > Math.min(headBody - SILENCE_DB, SILENCE_FLOOR_DB))) first += 1;
  const start = first >= headEnv.length ? 0 : first * step;

  const tailEnv = envelopeDb(tail, rate, tailFrom, tail.length);
  const tailBody = percentile(tailEnv, BODY_PERCENTILE);
  let last = tailEnv.length - 1;
  while (last >= 0 && !(tailEnv[last]! > Math.min(tailBody - SILENCE_DB, SILENCE_FLOOR_DB))) last -= 1;
  let full = tailEnv.length - 1;
  while (full >= 0 && !(tailEnv[full]! > tailBody - BODY_DB)) full -= 1;
  // A song still sounding in its final frame ends where the audio does, not a frame short of it.
  const edge = (frame: number): number => (frame >= tailEnv.length - 1 ? duration : Math.min(duration, tailOffset + (frame + 1) * step));
  const end = last < 0 ? duration : edge(last);
  const fullEnd = full < 0 ? end : Math.min(end, edge(full));

  return { duration, start, end, fullEnd, head: headGrid(head, rate, start, headTo), tail: tailGrid(tail, rate, tailFrom, tailOffset, fullEnd) };
}

function headGrid(head: Float32Array, rate: number, start: number, to: number): BeatGrid | null {
  const from = Math.min(to, Math.floor(start * rate));
  const { flux, fps } = onsetFlux(head, rate, from, to);
  const tempo = tempoOf(flux, fps);
  if (!tempo) return null;
  const grid = steadyGrid(flux, fps, tempo, 0, Math.min(Math.floor(PHASE_SECONDS * fps), Math.floor(flux.length / 3)), 'start');
  if (!grid) return null;
  return { bpm: grid.bpm, beatAt: from / rate + grid.anchor / fps, confidence: grid.confidence };
}

function tailGrid(tail: Float32Array, rate: number, tailFrom: number, tailOffset: number, fullEnd: number): BeatGrid | null {
  // Tempo from the last minute that is still at level; the fade-out itself says little about beats.
  const to = Math.max(tailFrom, Math.min(tail.length, tailFrom + Math.floor((fullEnd - tailOffset) * rate)));
  const from = Math.max(tailFrom, to - Math.floor(TEMPO_SECONDS * rate));
  const { flux, fps } = onsetFlux(tail, rate, from, to);
  const tempo = tempoOf(flux, fps);
  if (!tempo) return null;
  const third = Math.min(Math.floor(PHASE_SECONDS * fps), Math.floor(flux.length / 3));
  const grid = steadyGrid(flux, fps, tempo, flux.length - 3 * third, third, 'end');
  if (!grid) return null;
  const beat = 60 / grid.bpm;
  const firstBeat = tailOffset + (from - tailFrom) / rate + grid.anchor / fps;
  // Report the last beat at or before the song leaves its level: the planner counts from there.
  const beatAt = firstBeat + Math.floor((fullEnd - firstBeat) / beat) * beat;
  return { bpm: grid.bpm, beatAt, confidence: grid.confidence };
}

/** True when a measured grid is sure enough to mix on. */
export const gridUsable = (grid: BeatGrid | null | undefined): grid is BeatGrid =>
  !!grid && Number.isFinite(grid.bpm) && grid.bpm > 0 && Number.isFinite(grid.beatAt) && grid.confidence >= GRID_CONFIDENT;

/* ------------------------------------------------------------------ loading (the app, not the maths) */

export interface CuePcm {
  /** The song's first seconds. */
  head: Float32Array;
  /** The song's last seconds (may be the same array as `head` when the whole song was decoded). */
  tail: Float32Array;
  rate: number;
  duration: number;
}

type OfflineCtor = new (channels: number, length: number, rate: number) => { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> };

/** Decode a whole file to mono at CUE_RATE with the browser's own decoder. */
export async function decodeForCues(url: string): Promise<CuePcm | null> {
  const w = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Ctor || typeof fetch !== 'function') return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  const buffer = await new Ctor(1, 1, CUE_RATE).decodeAudioData(await response.arrayBuffer());
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i += 1) mono[i] = mono[i]! + data[i]! / buffer.numberOfChannels;
  }
  return { head: mono, tail: mono, rate: buffer.sampleRate, duration: buffer.duration };
}

/**
 * Cues per audio URL, measured once. A failure is remembered as "no cues" (the blend then falls
 * back to the file's own ends), never thrown: a song must not fail to play over an analysis.
 */
export function createCueLibrary(load: (url: string) => Promise<CuePcm | null> = decodeForCues, capacity = 48) {
  const held = new Map<string, Promise<TrackCues | null>>();
  const settled = new Map<string, TrackCues | null>();
  return {
    /** Start measuring if not already; resolves to the cues or null. */
    get(url: string): Promise<TrackCues | null> {
      const hit = held.get(url);
      if (hit) return hit;
      const job = load(url)
        .then((pcm) => (pcm && pcm.duration > 0 ? analyseEnds(pcm.head, pcm.tail, pcm.rate, pcm.duration) : null))
        .catch(() => null)
        .then((cues) => {
          settled.set(url, cues);
          return cues;
        });
      held.set(url, job);
      while (held.size > capacity) {
        const oldest = held.keys().next().value as string;
        held.delete(oldest);
        settled.delete(oldest);
      }
      return job;
    },
    /** The cues if they are already measured, without waiting. */
    peek: (url: string): TrackCues | null => settled.get(url) ?? null,
  };
}

export type CueLibrary = ReturnType<typeof createCueLibrary>;
export const trackCues = createCueLibrary();
