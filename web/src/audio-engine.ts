/**
 * The one audio engine the app shares.
 *
 * A browser only allows an AudioContext to start inside a user gesture, and only one is wanted for
 * the whole page, so this is a lazily created singleton rather than React state. The player feeds
 * it elements; Settings reads and writes the EQ and the mixer through it.
 *
 * It deliberately never throws: on a browser with no Web Audio, or for audio the page is not
 * allowed to touch, `reason()` explains why and playback simply continues unprocessed.
 */

import { EQ_DEFAULTS, parseEq, type EqConfig } from './engine/eq';
import { createAudioBus, type AudioBus, type BusContext, type DeckId } from './engine/audio-bus';
import { clampSlider } from './engine/crossfade';

export type EngineReason =
  | 'ready'
  | 'no-web-audio'
  | 'not-started'
  | 'iframe-playback'
  | 'cross-origin-without-cors';

export const REASON_TEXT: Record<EngineReason, string> = {
  // True whether or not a song happens to be playing right now: the graph exists and previews go
  // through it. Saying "processing this preview" while nothing plays was a claim about work the
  // engine was not doing.
  ready: 'Songs played by this app — downloaded full songs and 30-second previews — go through the equaliser and mixer.',
  'not-started': 'Starts with the first song you play.',
  'no-web-audio': 'This browser cannot process audio.',
  'iframe-playback':
    'This song plays in YouTube’s or SoundCloud’s own player, which Airwave cannot reach. Downloaded full songs and 30-second previews go through the equaliser and mixer.',
  'cross-origin-without-cors': 'This preview’s server did not allow processing, so it plays unprocessed.',
};

interface EngineState {
  ctx: AudioContext | null;
  bus: AudioBus | null;
  reason: EngineReason;
  eq: EqConfig;
  mix: number;
  /** Download full songs so the decks (and so the equaliser and mixer) can play them. */
  localMix: boolean;
}

const state: EngineState = { ctx: null, bus: null, reason: 'not-started', eq: EQ_DEFAULTS, mix: 0, localMix: false };
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of [...listeners]) l();
};

type Ctor = new () => AudioContext;
const audioContextCtor = (): Ctor | null => {
  const w = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
};

export const engineAvailable = (): boolean => audioContextCtor() !== null;

/**
 * Build the context and bus if they do not exist yet. Must be called from a user gesture — the
 * player calls it when a song starts, which is one.
 */
export function startEngine(): AudioBus | null {
  if (state.bus) return state.bus;
  const Ctor = audioContextCtor();
  if (!Ctor) {
    state.reason = 'no-web-audio';
    notify();
    return null;
  }
  try {
    state.ctx = new Ctor();
    const origin = typeof location === 'undefined' ? '' : location.origin;
    state.bus = createAudioBus(state.ctx as unknown as BusContext, state.eq, origin);
    state.reason = 'ready';
  } catch {
    state.ctx = null;
    state.bus = null;
    state.reason = 'no-web-audio';
  }
  notify();
  return state.bus;
}

/** A suspended context (tab was hidden, or it was created before the gesture) needs waking. */
export function resumeEngine(): void {
  const ctx = state.ctx;
  if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
}

/**
 * Route a media element through the engine.
 *
 * Returns the reason the audio is or is not being processed, so the caller can report it rather
 * than leaving a dead-looking control. Attaching is refused for audio that would be silenced.
 */
export function attachElement(element: HTMLMediaElement | null, deck: DeckId): EngineReason {
  if (!element) return state.reason;
  const bus = startEngine();
  if (!bus) return state.reason;
  const deckObj = bus.attach(element, deck);
  if (!deckObj) {
    state.reason = 'cross-origin-without-cors';
    notify();
    return state.reason;
  }
  if (state.reason !== 'ready') {
    state.reason = 'ready';
    notify();
  }
  return state.reason;
}

export const bus = (): AudioBus | null => state.bus;

/** A read-only picture of the live graph for the UI and for checks on a real build (ENGINE-PEEK-001). */
export const peekEngine = () => ({ reason: state.reason, mix: state.mix, eq: state.eq, localMix: state.localMix, bus: state.bus?.peek() ?? null });
if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__airwaveEngine', { value: { peek: peekEngine }, configurable: true, enumerable: false, writable: false });
}
export const reason = (): EngineReason => state.reason;

/** Tell the UI that the current song cannot be processed at all (an iframe provider). */
export function setUnprocessable(kind: 'iframe-playback' | null): void {
  const next: EngineReason = kind ?? (state.bus ? 'ready' : 'not-started');
  if (state.reason === next) return;
  state.reason = next;
  notify();
}

export const eqConfig = (): EqConfig => state.eq;

export function setEqConfig(raw: unknown): EqConfig {
  state.eq = parseEq(raw);
  state.bus?.setEq(state.eq);
  notify();
  return state.eq;
}

export const mixSlider = (): number => state.mix;

export function setMixSlider(v: number): number {
  state.mix = clampSlider(v);
  notify();
  return state.mix;
}

export const localMix = (): boolean => state.localMix;

export function setLocalMix(v: boolean): boolean {
  state.localMix = Boolean(v);
  notify();
  return state.localMix;
}

/** Whether anything would be heard through the graph: the crossfader is up, or the equaliser is on. */
export const wantsProcessing = (): boolean => state.mix > 0 || state.eq.on;

export const trimDb = (): number => state.bus?.trimDb() ?? 0;

/** Subscribe to engine changes; returns an unsubscribe. */
export function subscribeEngine(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Tests only: forget the singleton so each case starts clean. */
export function resetEngineForTests(): void {
  state.bus?.dispose();
  state.ctx = null;
  state.bus = null;
  state.reason = 'not-started';
  state.eq = EQ_DEFAULTS;
  state.mix = 0;
  state.localMix = false;
  listeners.clear();
}
