/**
 * The app's audio bus: one AudioContext, two decks, an EQ on each, and one crossfade between them.
 *
 *   deck A element → sourceA → EQ A → gainA ─┐
 *                                            ├→ master → destination
 *   deck B element → sourceB → EQ B → gainB ─┘
 *
 * Why two decks: a crossfade needs both songs audible at once, so the player keeps two <audio>
 * elements and alternates. Why an EQ per deck rather than one after the mixer: a
 * MediaElementAudioSourceNode belongs to its element for the life of the page, so each element has
 * its own chain anyway, and equalising before the fade means the blend is between two finished
 * sounds rather than one shared filter being yanked between songs.
 *
 * Hard limits this cannot escape, both reported rather than hidden:
 *  - Only the preview path is reachable. YouTube and SoundCloud audio lives in a cross-origin
 *    iframe and no page script can filter or fade it.
 *  - A cross-origin element without CORS, once routed through a graph, outputs SILENCE and keeps
 *    doing so. `attach` therefore refuses unless the element opted in with crossOrigin.
 */

import {
  EQ_DEFAULTS,
  createEqGraph,
  type EqConfig,
  type EqContext,
  type EqGraph,
} from './eq';
import { equalPower, type TransitionStyle } from './crossfade';

export type DeckId = 'a' | 'b';

/** What the bus needs from an AudioContext, so tests can supply a double. */
export interface BusContext extends EqContext {
  readonly state?: string;
  resume?(): Promise<void>;
  close?(): Promise<void>;
}

export type BusUnavailable =
  | 'no-web-audio'
  | 'cross-origin-without-cors'
  | 'iframe-playback'
  | null;

/**
 * How far the incoming track's lows are held down before the swap point, in dB.
 *
 * Two basslines at once is the single ugliest thing an auto-DJ can do: they are the loudest part of
 * each track and they fight. Every reference player does some form of this (BKmasterplayer and
 * BitChord both name a bass handoff), so the incoming deck arrives thin and takes the low end at
 * the halfway point, as the outgoing one gives it up.
 */
export const BASS_DUCK_DB = -18;
/** Corner frequency for that duck, and for the outgoing filter sweep. */
export const BASS_HZ = 180;
/** Where the outgoing deck's highpass sweep ends up by the end of a 'filter' transition. */
export const SWEEP_TOP_HZ = 900;
/** Where the highpass rests when no sweep is running — below hearing, so it is a no-op. */
export const SWEEP_PARKED_HZ = 20;

export interface Deck {
  readonly id: DeckId;
  readonly element: HTMLMediaElement;
  readonly gain: GainNode;
  readonly eq: EqGraph;
  /** Low shelf used for the bass handoff. Flat (0 dB) unless a transition is running. */
  readonly bass: BiquadFilterNode;
  /** Highpass used for the sweep. Parked at 20 Hz, which is inaudible, unless sweeping. */
  readonly sweep: BiquadFilterNode;
}

export interface AudioBus {
  /**
   * Route an element through the bus. Safe to call again with the same element: the source node is
   * created once and reused, because a second `createMediaElementSource` for one element throws.
   */
  attach(element: HTMLMediaElement, deck: DeckId): Deck | null;
  /** Apply an EQ config to every deck. */
  setEq(config: EqConfig): void;
  /** Which deck is currently the audible one. */
  live(): DeckId;
  /**
   * Fade from the live deck to the other one over `seconds`, using an equal-power curve.
   * Returns the deck now becoming live. A zero or negative length is an instant, click-free cut.
   */
  crossfadeTo(deck: DeckId, seconds: number): DeckId;
  /**
   * Run a styled transition to `deck`: the equal-power fade plus whatever the style adds (a bass
   * handoff, a filter sweep). Returns the deck now becoming live.
   */
  transitionTo(deck: DeckId, seconds: number, style: TransitionStyle): DeckId;
  /** Put a deck at full level and the other at silence immediately, with no fade. */
  cut(deck: DeckId): void;
  masterGain(): number;
  setMasterGain(v: number): void;
  trimDb(): number;
  dispose(): void;
}

/** Steps used to draw the equal-power curve into a param ramp. */
const CURVE_STEPS = 48;
/** Even an "instant" change gets this long, or the jump itself clicks. */
const CUT_SECONDS = 0.012;

/**
 * True when routing this element through Web Audio would silence it.
 *
 * A media element whose source is another origin only shares its samples if the server allowed it
 * AND the element asked, via crossOrigin. Without both, a MediaElementAudioSourceNode yields
 * silence — and the damage is permanent for that element, so this is checked before attaching.
 */
export function wouldBeSilent(element: HTMLMediaElement, pageOrigin: string): boolean {
  const raw = element.currentSrc || element.getAttribute('src') || '';
  if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return false;
  let origin: string;
  try {
    origin = new URL(raw, pageOrigin).origin;
  } catch {
    return false;
  }
  if (origin === pageOrigin) return false;
  return !element.crossOrigin;
}

function rampCurve(param: AudioParam, from: number, to: number, start: number, seconds: number): void {
  // setValueCurveAtTime is the honest way to draw a cosine: a linear ramp between the same two
  // endpoints would sag in the middle, which is the exact artefact equalPower exists to avoid.
  const span = Math.max(seconds, CUT_SECONDS);
  const values = new Float32Array(CURVE_STEPS + 1);
  for (let i = 0; i <= CURVE_STEPS; i += 1) {
    const g = equalPower(i / CURVE_STEPS);
    // `from`/`to` tell us which side of the curve this deck is on.
    values[i] = from > to ? g.out : g.in;
  }
  try {
    param.cancelScheduledValues(start);
    param.setValueAtTime(from, start);
    param.setValueCurveAtTime(values, start, span);
  } catch {
    try {
      param.cancelScheduledValues(start);
      param.setValueAtTime(from, start);
      param.linearRampToValueAtTime(to, start + span);
    } catch {
      param.value = to;
    }
  }
}

function setParam(param: AudioParam, value: number, at: number): void {
  try {
    param.cancelScheduledValues(at);
    param.setValueAtTime(value, at);
  } catch {
    param.value = value;
  }
}

/**
 * Ramp a param to `value`, finishing at `end`.
 *
 * `exponential` is for frequencies, which are heard logarithmically. An exponential ramp cannot
 * pass through or start at zero, so the start value is floored at a hair above it.
 */
function rampParam(param: AudioParam, value: number, end: number, _span: number, exponential = false): void {
  try {
    if (exponential) {
      if (param.value <= 0) param.setValueAtTime(0.0001, Math.max(0, end - _span));
      param.exponentialRampToValueAtTime(Math.max(value, 0.0001), end);
    } else {
      param.linearRampToValueAtTime(value, end);
    }
  } catch {
    param.value = value;
  }
}

/** Put a deck's transition filters back to no-ops. */
function restFilters(deck: Deck, at: number): void {
  setParam(deck.bass.gain, 0, at);
  setParam(deck.sweep.frequency, SWEEP_PARKED_HZ, at);
}

export function createAudioBus(ctx: BusContext, initialEq: EqConfig = EQ_DEFAULTS, pageOrigin = ''): AudioBus {
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);

  const decks = new Map<DeckId, Deck>();
  const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  let liveDeck: DeckId = 'a';
  let eqConfig = initialEq;
  let disposed = false;

  const attach = (element: HTMLMediaElement, id: DeckId): Deck | null => {
    if (disposed) return null;
    const existing = decks.get(id);
    if (existing && existing.element === element) return existing;
    if (pageOrigin && wouldBeSilent(element, pageOrigin)) return null;

    let source = sources.get(element);
    if (!source) {
      try {
        source = ctx.createMediaElementSource(element);
      } catch {
        return null;
      }
      sources.set(element, source);
    }
    const gain = ctx.createGain();
    gain.gain.value = id === liveDeck ? 1 : 0;
    gain.connect(master);
    // source → EQ → bass shelf → sweep highpass → deck fader → master.
    // The transition filters sit AFTER the EQ so a bass handoff ducks whatever the listener's own
    // EQ produced, rather than being undone by it.
    const bass = ctx.createBiquadFilter();
    bass.type = 'lowshelf';
    bass.frequency.value = BASS_HZ;
    bass.gain.value = 0;
    const sweep = ctx.createBiquadFilter();
    sweep.type = 'highpass';
    sweep.frequency.value = SWEEP_PARKED_HZ;
    sweep.Q.value = 0.7;
    bass.connect(sweep);
    sweep.connect(gain);
    const eq = createEqGraph(ctx, source, eqConfig, bass);
    const deck: Deck = { id, element, gain, eq, bass, sweep };
    decks.set(id, deck);
    return deck;
  };

  /** Hand over immediately, ending any running transition. Shared by `cut` and a 'cut' style. */
  const cutTo = (target: DeckId): void => {
    if (disposed) return;
    const at = ctx.currentTime;
    for (const deck of decks.values()) {
      const want = deck.id === target ? 1 : 0;
      // A cut ends any transition, so the filters go back to flat — otherwise a track that was
      // mid-sweep when the listener pressed Next stays thin for its whole play.
      restFilters(deck, at);
      try {
        deck.gain.gain.cancelScheduledValues(at);
        deck.gain.gain.setValueAtTime(deck.gain.gain.value, at);
        deck.gain.gain.linearRampToValueAtTime(want, at + CUT_SECONDS);
      } catch {
        deck.gain.gain.value = want;
      }
    }
    liveDeck = target;
  };

  return {
    attach,
    setEq(config) {
      if (disposed) return;
      eqConfig = config;
      for (const deck of decks.values()) deck.eq.apply(config);
    },
    live: () => liveDeck,
    crossfadeTo(target, seconds) {
      if (disposed || target === liveDeck) return liveDeck;
      const from = decks.get(liveDeck);
      const to = decks.get(target);
      const at = ctx.currentTime;
      if (to) rampCurve(to.gain.gain, 0, 1, at, seconds);
      if (from) rampCurve(from.gain.gain, 1, 0, at, seconds);
      liveDeck = target;
      return liveDeck;
    },
    transitionTo(target, seconds, style) {
      if (disposed || target === liveDeck) return liveDeck;
      const from = decks.get(liveDeck);
      const to = decks.get(target);
      const at = ctx.currentTime;
      const span = Math.max(seconds, CUT_SECONDS);

      // A cut is not a fade: hand over in one step rather than pretending to blend.
      if (style === 'cut') {
        cutTo(target);
        return liveDeck;
      }

      if (to) rampCurve(to.gain.gain, 0, 1, at, seconds);
      if (from) rampCurve(from.gain.gain, 1, 0, at, seconds);

      if (style === 'bass-swap' || style === 'filter') {
        // The incoming track arrives with its lows held down and takes them at the halfway point,
        // so the two basslines never both sit at full level.
        if (to) {
          setParam(to.bass.gain, BASS_DUCK_DB, at);
          rampParam(to.bass.gain, 0, at + span / 2, span / 2);
        }
        if (from) {
          setParam(from.bass.gain, 0, at);
          rampParam(from.bass.gain, BASS_DUCK_DB, at + span / 2, span / 2);
        }
      }

      if (style === 'filter') {
        // The outgoing track thins out as it leaves — the move a DJ makes with a highpass.
        if (from) {
          setParam(from.sweep.frequency, SWEEP_PARKED_HZ, at);
          // Exponential, because pitch and filter corners are heard logarithmically; a linear
          // sweep spends most of its time in the top octave where little is left to remove.
          rampParam(from.sweep.frequency, SWEEP_TOP_HZ, at + span, span, true);
        }
      }

      liveDeck = target;
      return liveDeck;
    },
    cut: cutTo,
    masterGain: () => master.gain.value,
    setMasterGain(v) {
      const want = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
      const at = ctx.currentTime;
      try {
        master.gain.cancelScheduledValues(at);
        master.gain.setValueAtTime(master.gain.value, at);
        master.gain.linearRampToValueAtTime(want, at + CUT_SECONDS);
      } catch {
        master.gain.value = want;
      }
    },
    trimDb: () => decks.get(liveDeck)?.eq.trimDb() ?? 0,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const deck of decks.values()) {
        deck.eq.dispose();
        try {
          deck.gain.disconnect();
        } catch {
          /* already gone */
        }
      }
      decks.clear();
      try {
        master.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}

/** The other deck. The player alternates, so song N and song N+1 are never on the same one. */
export const otherDeck = (id: DeckId): DeckId => (id === 'a' ? 'b' : 'a');
