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

import { createEqGraph, EQ_DEFAULTS, parseEq, type EqConfig } from './engine/eq';
import { createAudioBus, type AudioBus, type BusContext, type DeckId } from './engine/audio-bus';
import { PLAY_THROUGH_DEFAULT, clampPlayThrough, clampSlider } from './engine/crossfade';
import { engineAvailable as nativeEngineAvailable, engineSend } from './engine/native-engine';
import { boostGain } from './engine/volume-boost';

export type EngineReason =
  | 'ready'
  | 'no-web-audio'
  | 'not-started'
  | 'iframe-playback'
  | 'cross-origin-without-cors';

export const REASON_TEXT: Record<EngineReason, string> = {
  // True whether or not a song happens to be playing right now: the graph processes full songs
  // played by this app. Saying "processing this song" while nothing plays would claim work the
  // engine was not doing.
  ready: 'Full songs played by this app — from the queue cache or a saved file — go through the equaliser and mixer.',
  'not-started': 'Starts with the first song you play.',
  'no-web-audio': 'This browser cannot process audio.',
  'iframe-playback':
    'This song plays in YouTube’s or SoundCloud’s own player, which jPlay cannot reach. Full songs played inside jPlay go through the equaliser and mixer.',
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
  /** "Play before blending", percent of each song (MIXER-PLAY-THROUGH-002). */
  playThrough: number;
}

const state: EngineState = { ctx: null, bus: null, reason: 'not-started', eq: EQ_DEFAULTS, mix: 0, localMix: false, playThrough: PLAY_THROUGH_DEFAULT };
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
    if (boost !== 1) state.bus.setMasterGain(boost);
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
let radioGraph: ReturnType<typeof createEqGraph> | null = null;

// The mixer can be off for previews. Player then does not attach either element, so intercept its
// play event (which precedes media playback) and route the permanent deck before it makes sound.
// Also handles a deck first used after settings were restored; leave unrelated media untouched.
if (typeof document !== 'undefined') document.addEventListener('play', (event) => {
  const element = event.target;
  if (nativeEngineAvailable() || !(element instanceof HTMLAudioElement)) return;
  const id = element.dataset.deck;
  if (id !== 'a' && id !== 'b') return;
  if (attachElement(element, id) === 'ready') {
    if (state.mix === 0) state.bus?.cut(id);
    resumeEngine();
  }
}, true);

/** A read-only picture of the live graph for the UI and for checks on a real build (ENGINE-PEEK-001). */
export const peekEngine = () => ({ reason: state.reason, mix: state.mix, eq: state.eq, localMix: state.localMix, playThrough: state.playThrough, bus: state.bus?.peek() ?? null, radio: radioGraph?.peek() ?? null });
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

/** EQ-RESTORE-001: until the listener's saved settings have loaded, this module holds blank defaults (EQ off, no
 * mixer). The Android service has already restored the saved sound by itself, so nothing may send these defaults
 * to it: on a real phone that switched the EQ off for two seconds under music that was already playing. */
let savedApplied = false;
export const savedSettingsApplied = (): boolean => savedApplied;
export function markSavedSettingsApplied(): void {
  if (savedApplied) return;
  savedApplied = true;
  notify();
}

export function setEqConfig(raw: unknown): EqConfig {
  state.eq = parseEq(raw);
  state.bus?.setEq(state.eq);
  // Radio unmounts Player, so its settings subscription cannot forward later EQ changes.
  // Send directly from the page-level setting as well; EngineHub persists it for car cold starts.
  if (nativeEngineAvailable()) engineSend({ op: 'settings', eq: state.eq });
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

/** "Play before blending", percent of each song (MIXER-PLAY-THROUGH-002). */
export const playThrough = (): number => state.playThrough;
export function setPlayThrough(v: unknown): number {
  const n = clampPlayThrough(v);
  if (n !== state.playThrough) {
    state.playThrough = n;
    notify();
  }
  return state.playThrough;
}

export function setLocalMix(v: boolean): boolean {
  state.localMix = Boolean(v);
  notify();
  return state.localMix;
}

/**
 * VOLUME-BOOST-001: the part of the volume above 100%, carried by the mix bus master gain (the audio element itself
 * cannot go past 1). Kept here so a bus built later still gets it.
 */
let boost = 1;
export function setVolumeBoost(volume: number): void {
  boost = boostGain(volume);
  state.bus?.setMasterGain(boost);
}
export const volumeBoost = (): number => boost;

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
  radioGraph = null;
  state.eq = EQ_DEFAULTS;
  state.mix = 0;
  state.localMix = false;
  state.playThrough = PLAY_THROUGH_DEFAULT;
  boost = 1;
  savedApplied = false;
  listeners.clear();
}

/** RADIO-001. Windows PCM from the native bounded live buffer uses the same AudioContext and EQ
 * implementation/settings as the song decks, without a second player or bypassing the EQ. Android
 * uses the native engine and immediately disposes this graph after the native start handshake. */
export function radioOutput(): { ctx: AudioContext; input: AudioNode; volume(v: number): void; peek(): ReturnType<ReturnType<typeof createEqGraph>['peek']>; dispose(): void } | null {
  startEngine(); resumeEngine();
  if (!state.ctx) return null;
  const ctx = state.ctx, out = ctx.createGain(), input = ctx.createGain(); out.connect(ctx.destination);
  const graph = createEqGraph(ctx as never, input, state.eq, out);
  radioGraph = graph;
  const off = subscribeEngine(() => graph.apply(state.eq));
  return { ctx, input, volume: (v) => { out.gain.value = Math.min(1, Math.max(0, v)); }, peek: () => graph.peek(), dispose: () => { off(); if (radioGraph === graph) radioGraph = null; graph.dispose(); input.disconnect(); out.disconnect(); } };
}
