/**
 * DSP parity reference harness (see CONTRACT.md).
 *
 * Runs the app's REAL audio graph — web/src/engine/audio-bus.ts, eq.ts and crossfade.ts, imported
 * unmodified — inside Chromium's OfflineAudioContext and returns the rendered PCM. Bundled by
 * render-reference.mjs with esbuild (iife, global `DspParity`) and driven by electron-main.cjs.
 */

import { createAudioBus, type BusContext } from '../../web/src/engine/audio-bus';
import { EQ_DEFAULTS, applyPreset, type EqConfig } from '../../web/src/engine/eq';

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const QUANTUM = 128;

export interface ChannelSpec {
  seed: number;
  noiseAmp: number;
  sines: [number, number][];
}
export type DeckInputs = [ChannelSpec, ChannelSpec];
export interface Action {
  frame: number;
  op: 'setEq' | 'transitionTo' | 'crossfadeTo' | 'cut' | 'setMasterGain';
  args: unknown[];
}
export interface Scenario {
  name: string;
  frames: number;
  file: string;
  inputs: { a: DeckInputs; b: DeckInputs };
  initialEq: EqConfig;
  actions: Action[];
}

/* ------------------------------------------------------------------ inputs (contract) */

const DECK_A: DeckInputs = [
  { seed: 1, noiseAmp: 0.08, sines: [[55, 0.12], [440, 0.1], [3000, 0.05]] },
  { seed: 2, noiseAmp: 0.08, sines: [[82.5, 0.12], [660, 0.1], [5000, 0.04]] },
];
const DECK_B: DeckInputs = [
  { seed: 3, noiseAmp: 0.08, sines: [[110, 0.12], [880, 0.1], [2000, 0.05]] },
  { seed: 4, noiseAmp: 0.08, sines: [[165, 0.12], [1320, 0.1], [7000, 0.04]] },
];
/** Attached but silent: same seeds, every amplitude zero. */
const SILENT_B: DeckInputs = [
  { seed: 3, noiseAmp: 0, sines: [] },
  { seed: 4, noiseAmp: 0, sines: [] },
];
/** Loud decks for the master limiter: sines summing to 0.8 per channel, plus light noise. */
const LOUD_A: DeckInputs = [
  { seed: 1, noiseAmp: 0.05, sines: [[55, 0.45], [440, 0.25], [3000, 0.1]] },
  { seed: 2, noiseAmp: 0.05, sines: [[82.5, 0.45], [660, 0.25], [5000, 0.1]] },
];
const LOUD_B: DeckInputs = [
  { seed: 3, noiseAmp: 0.05, sines: [[110, 0.45], [880, 0.25], [2000, 0.1]] },
  { seed: 4, noiseAmp: 0.05, sines: [[165, 0.45], [1320, 0.25], [7000, 0.1]] },
];

/** The contract's generator: xorshift32 noise + float64 sines, rounded to float32. */
export function generateChannel(spec: ChannelSpec, frames: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(frames);
  let x = spec.seed >>> 0;
  for (let n = 0; n < frames; n += 1) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    const u = x / 4294967296;
    const noise = (u * 2 - 1) * spec.noiseAmp;
    let value = 0;
    for (const [hz, amp] of spec.sines) value += amp * Math.sin((2 * Math.PI * hz * n) / SAMPLE_RATE);
    out[n] = Math.fround(value + noise);
  }
  return out;
}

/* ------------------------------------------------------------------ EQ configs (expanded from eq.ts) */

const clone = (c: EqConfig): EqConfig => JSON.parse(JSON.stringify(c)) as EqConfig;
const OFF = clone(EQ_DEFAULTS);
const ROCK = clone(applyPreset({ ...EQ_DEFAULTS, on: true }, 'rock'));
const BASS_BOOSTER_NO_LIMITER = clone(applyPreset({ ...EQ_DEFAULTS, on: true, limiter: false }, 'bass-booster'));
const SOLFEGGIO_528 = clone(applyPreset({ ...EQ_DEFAULTS, on: true }, 'solfeggio-528'));
const EXTREME: EqConfig = {
  ...clone(EQ_DEFAULTS),
  on: true,
  presetId: 'custom',
  gains: [12, -12, 12, -12, 12, -12, 12, -12, 12, -12],
  preampDb: 6,
  limiter: true,
  toneHz: null,
};

/* ------------------------------------------------------------------ scenarios (contract table) */

function scenario(name: string, frames: number, inputs: Scenario['inputs'], initialEq: EqConfig, actions: Action[] = []): Scenario {
  return { name, frames, file: `${name}.f32`, inputs, initialEq, actions };
}

const EQ_ONLY = { a: DECK_A, b: SILENT_B };
const BOTH = { a: DECK_A, b: DECK_B };

export function scenarios(): Scenario[] {
  return [
    scenario('eq-off-passthrough', 48000, EQ_ONLY, OFF),
    scenario('eq-rock', 48000, EQ_ONLY, ROCK),
    scenario('eq-bass-booster-no-limiter', 48000, EQ_ONLY, BASS_BOOSTER_NO_LIMITER),
    scenario('eq-solfeggio-528', 48000, EQ_ONLY, SOLFEGGIO_528),
    scenario('eq-extreme-custom', 48000, EQ_ONLY, EXTREME),
    scenario('eq-toggle-ramp', 72064, EQ_ONLY, OFF, [{ frame: 24064, op: 'setEq', args: [ROCK] }]),
    scenario('xfade-blend', 72064, BOTH, OFF, [{ frame: 12800, op: 'transitionTo', args: ['b', 0.8, 'blend'] }]),
    scenario('xfade-bass-swap', 72064, BOTH, OFF, [{ frame: 12800, op: 'transitionTo', args: ['b', 0.8, 'bass-swap'] }]),
    scenario('xfade-filter', 72064, BOTH, OFF, [{ frame: 12800, op: 'transitionTo', args: ['b', 0.8, 'filter'] }]),
    scenario('xfade-cut', 72064, BOTH, OFF, [{ frame: 12800, op: 'transitionTo', args: ['b', 0.8, 'cut'] }]),
    scenario('xfade-reversal', 72064, BOTH, OFF, [
      { frame: 12800, op: 'transitionTo', args: ['b', 1.0, 'filter'] },
      { frame: 32000, op: 'crossfadeTo', args: ['a', 0.5] },
    ]),
    scenario('loud-sum-limiter', 72064, { a: LOUD_A, b: LOUD_B }, OFF, [
      { frame: 12800, op: 'transitionTo', args: ['b', 0.8, 'blend'] },
    ]),
    scenario('master-gain', 48000, BOTH, OFF, [{ frame: 9600, op: 'setMasterGain', args: [0.5] }]),
  ];
}

/* ------------------------------------------------------------------ rendering */

function deckBuffer(ctx: OfflineAudioContext, deck: DeckInputs, frames: number): AudioBufferSourceNode {
  const buffer = ctx.createBuffer(CHANNELS, frames, SAMPLE_RATE);
  for (let ch = 0; ch < CHANNELS; ch += 1) buffer.copyToChannel(generateChannel(deck[ch]!, frames), ch);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  return node;
}

/** Render one scenario; resolves to the interleaved float32 PCM. */
export async function render(name: string): Promise<Float32Array<ArrayBuffer>> {
  const sc = scenarios().find((s) => s.name === name);
  if (!sc) throw new Error(`unknown scenario ${name}`);
  for (const a of sc.actions) if (a.frame % QUANTUM !== 0) throw new Error(`${name}: action frame ${a.frame} is not a quantum boundary`);

  const ctx = new OfflineAudioContext(CHANNELS, sc.frames, SAMPLE_RATE);
  const srcA = deckBuffer(ctx, sc.inputs.a, sc.frames);
  const srcB = deckBuffer(ctx, sc.inputs.b, sc.frames);
  const elA = { currentSrc: 'blob:a' } as unknown as HTMLMediaElement;
  const elB = { currentSrc: 'blob:b' } as unknown as HTMLMediaElement;
  const prepared = new Map<HTMLMediaElement, AudioBufferSourceNode>([[elA, srcA], [elB, srcB]]);

  // Everything delegates to the real context; only the media-element source is swapped.
  const wrapped: BusContext = {
    get currentTime() { return ctx.currentTime; },
    get sampleRate() { return ctx.sampleRate; },
    get destination() { return ctx.destination; },
    get state() { return ctx.state; },
    createGain: () => ctx.createGain(),
    createBiquadFilter: () => ctx.createBiquadFilter(),
    createDynamicsCompressor: () => ctx.createDynamicsCompressor(),
    createMediaElementSource: (el: HTMLMediaElement) => {
      const node = prepared.get(el);
      if (!node) throw new Error('unexpected element');
      return node as unknown as MediaElementAudioSourceNode;
    },
  };

  const bus = createAudioBus(wrapped, sc.initialEq);
  if (!bus.attach(elA, 'a')) throw new Error('attach a failed');
  if (!bus.attach(elB, 'b')) throw new Error('attach b failed');
  srcA.start(0);
  srcB.start(0);

  const errors: string[] = [];
  for (const action of sc.actions) {
    const at = action.frame / SAMPLE_RATE;
    void ctx.suspend(at).then(() => {
      try {
        if (Math.round(ctx.currentTime * SAMPLE_RATE) !== action.frame) {
          errors.push(`${action.op}@${action.frame} ran at frame ${ctx.currentTime * SAMPLE_RATE}`);
        }
        const fn = (bus as unknown as Record<string, (...args: unknown[]) => unknown>)[action.op];
        if (typeof fn !== 'function') throw new Error(`unknown op ${action.op}`);
        fn(...action.args);
      } catch (e) {
        errors.push(String(e));
      } finally {
        void ctx.resume();
      }
    });
  }

  const rendered = await ctx.startRendering();
  if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
  const out = new Float32Array(sc.frames * CHANNELS);
  const l = rendered.getChannelData(0);
  const r = rendered.getChannelData(1);
  for (let i = 0; i < sc.frames; i += 1) {
    out[2 * i] = l[i]!;
    out[2 * i + 1] = r[i]!;
  }
  return out;
}

const toBase64 = (pcm: Float32Array): string => {
  // Little-endian: every host Chromium runs this on (x86-64, ARM64) is.
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

const sha256Hex = async (pcm: Float32Array<ArrayBuffer>): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', pcm));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Render once and return base64 of the little-endian float32 bytes. */
export async function renderBase64(name: string): Promise<string> {
  return toBase64(await render(name));
}

export interface CanonicalRender {
  base64: string;
  sha256: string;
  /** Distinct outputs Chromium produced for this scenario across `renders` renders. */
  variants: number;
  renders: number;
  /** Largest |sample difference| between the chosen output and any other variant. */
  maxSpread: number;
}

/**
 * Render until the set of distinct outputs is stable, and return the one with the smallest sha256.
 *
 * Why: Chromium sums a node's inputs in hash-set (pointer) order, so a node with three or more
 * non-zero inputs — the EQ's `out` (limited wet + bypass + dry) while the initial ramps run — gives
 * a float result that depends on the summation order, which changes from render to render. Every
 * variant is a genuine rendering of the real graph; they differ by ~1e-5. Collecting all of them and
 * freezing the smallest hash makes the fixtures byte-reproducible without touching the graph.
 *
 * @param stableAfter stop once this many consecutive renders produced no new variant.
 */
export async function renderCanonical(name: string, stableAfter = 150): Promise<CanonicalRender> {
  const variants = new Map<string, Float32Array<ArrayBuffer>>();
  let renders = 0;
  let sinceNew = 0;
  while (sinceNew < stableAfter) {
    const pcm = await render(name);
    renders += 1;
    const hash = await sha256Hex(pcm);
    if (variants.has(hash)) sinceNew += 1;
    else {
      variants.set(hash, pcm);
      sinceNew = 0;
    }
  }
  const sha256 = [...variants.keys()].sort()[0]!;
  const chosen = variants.get(sha256)!;
  let maxSpread = 0;
  for (const other of variants.values()) {
    for (let i = 0; i < chosen.length; i += 1) maxSpread = Math.max(maxSpread, Math.abs(chosen[i]! - other[i]!));
  }
  return { base64: toBase64(chosen), sha256, variants: variants.size, renders, maxSpread };
}
