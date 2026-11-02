/**
 * Getting 16 kHz mono samples for the fingerprint, from a file the user picked or from the microphone.
 * Nothing here is stored: the samples live in memory until the fingerprint is made, then are dropped.
 */
import { SAMPLE_RATE, WINDOW_SECONDS } from './fingerprint';

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const AUDIO_ACCEPT = '.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac,.webm,audio/*';

export type CaptureErrorCode = 'denied' | 'no_mic' | 'mic_failed' | 'unsupported' | 'unreadable' | 'too_long' | 'cancelled';

export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, message: string = code) {
    super(message);
  }
}

/** Mixes to mono and resamples to 16 kHz (linear interpolation after a box low-pass, adequate for 250-5500 Hz peaks). */
export function toMono16k(channels: Float32Array[], rate: number): Float32Array {
  const n = channels[0]?.length ?? 0;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i]! += ch[i]! / channels.length;
  if (rate === SAMPLE_RATE) return mono;
  const ratio = rate / SAMPLE_RATE;
  let src = mono;
  if (ratio > 1) {
    // Moving-average low-pass over one output period, so content above 8 kHz does not fold into the bands.
    const w = Math.max(1, Math.round(ratio));
    src = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += mono[i]!;
      if (i >= w) acc -= mono[i - w]!;
      src[i] = acc / Math.min(i + 1, w);
    }
  }
  const outLen = Math.floor(n / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = src[j]! * (1 - f) + (src[j + 1] ?? src[j]!) * f;
  }
  return out;
}

const AudioCtx = (): typeof AudioContext | undefined =>
  (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
  (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

/** Decodes an audio file the user picked. Rejects non-audio before decoding by its first bytes. */
export async function samplesFromFile(file: Blob & { name?: string }, signal?: AbortSignal): Promise<Float32Array> {
  if (file.size > MAX_FILE_BYTES) throw new CaptureError('too_long');
  if (file.size < 64) throw new CaptureError('unreadable');
  const Ctor = AudioCtx();
  if (!Ctor) throw new CaptureError('unsupported', 'no Web Audio');
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    throw new CaptureError('too_long');
  }
  if (signal?.aborted) throw new CaptureError('cancelled');
  if (!looksLikeAudio(new Uint8Array(bytes, 0, Math.min(64, bytes.byteLength)))) throw new CaptureError('unsupported');
  const ctx = new Ctor();
  try {
    const buf = await ctx.decodeAudioData(bytes);
    if (signal?.aborted) throw new CaptureError('cancelled');
    if (!buf.length) throw new CaptureError('unreadable');
    const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
    return toMono16k(chans, buf.sampleRate);
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    throw new CaptureError(/memory|allocation|RangeError/i.test(String(e)) ? 'too_long' : 'unreadable');
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

/** Container magic numbers for the formats the picker offers. */
export function looksLikeAudio(h: Uint8Array): boolean {
  const s = (o: number, t: string) => [...t].every((c, i) => h[o + i] === c.charCodeAt(0));
  if (s(0, 'ID3') || (h[0] === 0xff && (h[1]! & 0xe0) === 0xe0)) return true; // MP3 / ADTS AAC
  if (s(0, 'RIFF') && s(8, 'WAVE')) return true;
  if (s(0, 'OggS') || s(0, 'fLaC') || s(4, 'ftyp')) return true; // Ogg, FLAC, MP4/M4A
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return true; // WebM / Matroska
  if (s(0, 'FORM') && (s(8, 'AIFF') || s(8, 'AIFC'))) return true;
  return false;
}

export interface Recording {
  /** Resolves with what was heard when stopped (Stop or the 12 s limit). */
  done: Promise<Float32Array>;
  stop(): void;
  cancel(): void;
  /** Name of the microphone in use (empty when the browser hides it). */
  device: string;
}

/** Where the chosen microphone is remembered (its deviceId; empty means the system default). */
export const MIC_KEY = 'airwave.mic';

export function savedMicId(): string {
  try {
    return globalThis.localStorage?.getItem(MIC_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveMicId(id: string): void {
  try {
    if (id) globalThis.localStorage?.setItem(MIC_KEY, id);
    else globalThis.localStorage?.removeItem(MIC_KEY);
  } catch {
    /* private mode: the choice just lasts until the page closes */
  }
}

export interface MicInfo {
  id: string;
  label: string;
}

/**
 * Lists the audio inputs. Browsers hide the names until the page has been allowed to use a microphone once, so
 * `named` is false until then and the picker offers to allow it.
 */
export async function listMics(): Promise<{ mics: MicInfo[]; named: boolean }> {
  const md = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
  if (!md?.enumerateDevices) return { mics: [], named: false };
  const all = (await md.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const named = all.some((d) => d.label);
  // "default" and "communications" are aliases Chromium adds for another entry; keep "default" (shown as System default).
  const mics = all.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  return { mics, named };
}

/**
 * Opens a microphone. Echo cancellation, noise suppression and auto gain are off: they are tuned for voice and blur
 * music. A remembered device that has gone (unplugged) falls back to the system default instead of failing.
 */
export async function openMic(deviceId: string = savedMicId()): Promise<MediaStream> {
  const md = (globalThis.navigator as Navigator | undefined)?.mediaDevices;
  if (!md?.getUserMedia) throw new CaptureError('unsupported');
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  const want = deviceId && deviceId !== 'default';
  try {
    return await md.getUserMedia({ audio: want ? { ...base, deviceId: { exact: deviceId } } : base });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (want && (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'DevicesNotFoundError')) return openMic('');
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') throw new CaptureError('denied');
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') throw new CaptureError('no_mic');
    throw new CaptureError('mic_failed', String(e));
  }
}

/** The bars on screen: how many. */
export const BAND_COUNT = 24;

/**
 * Turns raw 0..1 band heights into what the bars show: how far each band is above its own recent quiet level.
 * A steady hum, fan or room tone sits at that level and draws nothing; a voice, beat or note rises above it. The result
 * is scaled so the loudest recent peak reaches the top, which keeps a quiet microphone readable the way a camera's auto
 * exposure does. `REF_MIN` stops that boost from blowing small ripples up into full-height bars.
 */
export class BandScaler {
  static readonly REF_MIN = 0.22;
  static readonly REF_DECAY = 0.995;
  /** How fast the quiet level may rise per frame (it falls at once); about 30 s from silence to a held tone. */
  static readonly FLOOR_RISE = 0.0005;
  private ref = BandScaler.REF_MIN;
  private floor: Float32Array | null = null;
  /** Rewrites `bands` in place as 0..1 heights. */
  scale(bands: Float32Array): void {
    const floor = (this.floor ??= Float32Array.from(bands));
    let top = 0;
    for (let i = 0; i < bands.length; i++) {
      const v = bands[i]!;
      floor[i] = v < floor[i]! ? v : floor[i]! + BandScaler.FLOOR_RISE;
      bands[i] = Math.max(0, v - floor[i]!);
      if (bands[i]! > top) top = bands[i]!;
    }
    this.ref = Math.max(BandScaler.REF_MIN, top, this.ref * BandScaler.REF_DECAY);
    for (let i = 0; i < bands.length; i++) bands[i] = Math.min(1, bands[i]! / this.ref);
  }
}

/** Waveform peak (0..1) of the latest ~20 ms: what "is this microphone sending anything" is judged on. */
export const SILENT_PEAK = 0.004;

/**
 * Calls `onBands` every animation frame with BAND_COUNT 0..1 heights (low to high pitch) and the waveform peak, so
 * the screen can move with the sound. Returns a stop function.
 */
export function startBands(ctx: AudioContext, source: AudioNode, onBands: (bands: Float32Array, peak: number) => void): () => void {
  if (typeof requestAnimationFrame !== 'function') return () => undefined;
  let raf = 0;
  let live = true;
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.minDecibels = -90; // the default -100..-30 dB window pins every bar at full for ordinary music
    analyser.maxDecibels = -12;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser);
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const wave = new Float32Array(analyser.fftSize);
    const bands = new Float32Array(BAND_COUNT);
    const hzPerBin = ctx.sampleRate / analyser.fftSize;
    const scaler = new BandScaler();
    const paint = () => {
      if (!live) return;
      analyser.getByteFrequencyData(bins);
      analyser.getFloatTimeDomainData(wave);
      let peak = 0;
      for (let i = 0; i < wave.length; i++) peak = Math.max(peak, Math.abs(wave[i]!));
      // log-spaced bands between 80 Hz and 8 kHz: music lives there, and equal-width bands would leave most bars flat
      for (let b = 0; b < BAND_COUNT; b++) {
        const lo = Math.max(1, Math.floor((80 * Math.pow(100, b / BAND_COUNT)) / hzPerBin));
        const hi = Math.max(lo + 1, Math.floor((80 * Math.pow(100, (b + 1) / BAND_COUNT)) / hzPerBin));
        let sum = 0;
        for (let i = lo; i < hi && i < bins.length; i++) sum += bins[i]!;
        bands[b] = Math.min(1, Math.pow(sum / (hi - lo) / 255, 1.1));
      }
      scaler.scale(bands);
      onBands(bands, peak);
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
  } catch {
    /* the level meter still works without bands */
  }
  return () => {
    live = false;
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    try {
      source.disconnect();
    } catch {
      /* already disconnected */
    }
  };
}

/**
 * Records from the microphone for up to 12 s. `onTick` gets elapsed seconds and a 0..1 level about ten times a second;
 * `onBands` gets the live spectrum (see startBands).
 */
export async function recordMic(
  onTick: (elapsed: number, level: number) => void,
  signal?: AbortSignal,
  onBands?: (bands: Float32Array, peak: number) => void,
): Promise<Recording> {
  const stream = await openMic();
  const device = stream.getAudioTracks()[0]?.label ?? '';
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  if (signal?.aborted) {
    stopTracks();
    throw new CaptureError('cancelled');
  }
  const Ctor = AudioCtx();
  if (!Ctor) {
    stopTracks();
    throw new CaptureError('unsupported');
  }
  const ctx = new Ctor();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but works in every WebView and Electron without serving a worklet file.
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let got = 0;
  const limit = WINDOW_SECONDS * ctx.sampleRate;
  let finished = false;
  let resolve!: (v: Float32Array) => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<Float32Array>((a, b) => ((resolve = a), (reject = b)));
  const t0 = performance.now();
  let level = 0;
  const stopBands = onBands ? startBands(ctx, source, onBands) : () => undefined;
  const tick = setInterval(() => onTick(Math.min(WINDOW_SECONDS, (performance.now() - t0) / 1000), level), 100);

  const teardown = () => {
    clearInterval(tick);
    stopBands();
    node.onaudioprocess = null;
    try {
      source.disconnect();
      node.disconnect();
    } catch {
      /* already disconnected */
    }
    stopTracks();
    void ctx.close().catch(() => undefined);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    const rate = ctx.sampleRate;
    teardown();
    const all = new Float32Array(got);
    let o = 0;
    for (const c of chunks) {
      all.set(c.subarray(0, Math.min(c.length, got - o)), o);
      o += c.length;
    }
    resolve(toMono16k([all], rate));
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    teardown();
    chunks.length = 0;
    reject(new CaptureError('cancelled'));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  stream.getTracks().forEach((t) => t.addEventListener('ended', () => (got > ctx.sampleRate ? finish() : cancel())));

  node.onaudioprocess = (ev) => {
    if (finished) return;
    const d = ev.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]!));
    level = Math.min(1, Math.sqrt(peak) * 1.2);
    chunks.push(new Float32Array(d));
    got += d.length;
    if (got >= limit) finish();
  };
  source.connect(node);
  node.connect(ctx.destination); // the node only runs while connected; its output buffer is left silent
  return { done, stop: finish, cancel, device };
}
