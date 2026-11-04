/**
 * The app's audio bus: one AudioContext, two decks, an EQ on each, and one crossfade between them.
 *
 *   deck A element → sourceA → EQ A → gainA ─┐
 *                                            ├→ master → limiter → destination
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
  LIMITER,
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
  /**
   * Put a deck at full level and the other at silence, with only a click-avoiding ramp. Doubles as
   * the cancel for a transition in flight: `cut(live())` stops the fade and keeps the live deck,
   * continuing from the level the fade had actually reached. Ignored if `deck` is not attached.
   */
  cut(deck: DeckId): void;
  masterGain(): number;
  setMasterGain(v: number): void;
  trimDb(): number;
  /**
   * A read-only picture of the graph: which deck is live, each deck's fader level and EQ state.
   * For the UI's engine line and for checks against a real build (ENGINE-PEEK-001).
   */
  peek(): BusPeek;
  dispose(): void;
}

export interface BusPeek {
  live: DeckId;
  master: number;
  decks: Partial<Record<DeckId, { gain: number; src: string; eq: ReturnType<EqGraph['peek']> }>>;
}

/** Steps used to draw the equal-power curve into a param ramp. */
const CURVE_STEPS = 48;
/** Even an "instant" change gets this long, or the jump itself clicks. */
const CUT_SECONDS = 0.012;
/** Filter corners get a slightly longer glide than a gain: coefficients audibly thump otherwise. */
const FILTER_REST_SECONDS = 0.04;

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

/** Mirror only bus-owned automation, not EQ. Also works when cancelAndHoldAtTime is absent.
 * AudioParam.value is not an automation target, and cancelling first can restore an OLD value.
 * Keep the actual Float32 curve so interruptions interpolate exactly what was scheduled.
 */
interface Automation {
  start: number;
  seconds: number;
  values: readonly number[] | Float32Array;
  exponential?: boolean;
}
const automation = new WeakMap<AudioParam, Automation>();
const duration = (seconds: number): number => Number.isFinite(seconds) ? Math.max(CUT_SECONDS, Math.min(60, seconds)) : CUT_SECONDS;

function valueAt(param: AudioParam, at: number): number {
  const event = automation.get(param);
  if (!event) return param.value;
  const progress = event.seconds > 0 ? Math.max(0, Math.min(1, (at - event.start) / event.seconds)) : 1;
  const position = progress * (event.values.length - 1);
  const i = Math.floor(position);
  const from = event.values[i]!;
  const to = event.values[Math.min(i + 1, event.values.length - 1)]!;
  return event.exponential ? from * (to / from) ** (position - i) : from + (to - from) * (position - i);
}

function hold(param: AudioParam, at: number): number {
  const value = valueAt(param, at);
  if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(at);
  else param.cancelScheduledValues(at);
  param.setValueAtTime(value, at);
  automation.set(param, { start: at, seconds: 0, values: [value] });
  return value;
}

function setParam(param: AudioParam, value: number, at: number): void {
  param.cancelScheduledValues(at);
  param.setValueAtTime(value, at);
  automation.set(param, { start: at, seconds: 0, values: [value] });
}

/**
 * Start a new automation at `at`: hold whatever is there, then ramp to `value` by `end`.
 *
 * `exponential` is for frequencies, heard logarithmically — a linear sweep spends most of its time
 * in the top octave. It cannot touch zero, so a non-positive endpoint falls back to linear.
 */
function rampParam(param: AudioParam, value: number, at: number, end: number, exponential = false): void {
  const from = hold(param, at);
  const exp = exponential && from > 0 && value > 0;
  if (exp) param.exponentialRampToValueAtTime(value, end);
  else param.linearRampToValueAtTime(value, end);
  automation.set(param, { start: at, seconds: Math.max(0, end - at), values: [from, value], exponential: exp });
}

/**
 * Append a second leg to automation already scheduled, WITHOUT cancelling: a planned pair (duck
 * now, give the lows back at the halfway point) is one gesture, and holding at its own start would
 * wipe the first leg before it ran.
 */
function chainParam(param: AudioParam, from: number, value: number, start: number, end: number): void {
  param.linearRampToValueAtTime(value, end);
  automation.set(param, { start, seconds: Math.max(0, end - start), values: [from, value] });
}

function rampCurve(param: AudioParam, to: number, start: number, seconds: number): void {
  const from = hold(param, start);
  const span = duration(seconds);
  const values = new Float32Array(CURVE_STEPS + 1);
  for (let i = 0; i <= CURVE_STEPS; i += 1) {
    const g = equalPower(i / CURVE_STEPS);
    // Interpolate POWER from the held level. Both legs still sum to <= 1 after a reversal,
    // unlike restarting either leg from 0/1 or independently offsetting sine/cosine curves.
    values[i] = Math.sqrt(from * from * g.out * g.out + to * to * g.in * g.in);
  }
  values[0] = from;
  values[CURVE_STEPS] = to;
  param.setValueCurveAtTime(values, start, span);
  automation.set(param, { start, seconds: span, values });
}

/** Silent decks can reset immediately; audible decks glide without a coefficient jump. */
function resetFilter(param: AudioParam, value: number, at: number, silent: boolean, exponential = false): void {
  const event = automation.get(param);
  if (valueAt(param, at) === value && (!event || at >= event.start + event.seconds)) return;
  if (silent) setParam(param, value, at);
  else rampParam(param, value, at, at + FILTER_REST_SECONDS, exponential);
}

function restFilters(deck: Deck, at: number): void {
  const silent = valueAt(deck.gain.gain, at) === 0;
  resetFilter(deck.bass.gain, 0, at, silent);
  // Exponential: a 900 Hz → 20 Hz corner heard linearly spends the whole glide in the top octave.
  resetFilter(deck.sweep.frequency, SWEEP_PARKED_HZ, at, silent, true);
}

export function createAudioBus(ctx: BusContext, initialEq: EqConfig = EQ_DEFAULTS, pageOrigin = ''): AudioBus {
  const master = ctx.createGain();
  master.gain.value = 1;
  // Each deck's own limiter only sees that deck, and the EQ's can be switched off entirely; two
  // decks at equal power still sum above either one. One ceiling on the mix is the only thing that
  // can catch that, so it is not optional and sits after the master fader.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.thresholdDb;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attackSeconds;
  limiter.release.value = LIMITER.releaseSeconds;
  master.connect(limiter);
  limiter.connect(ctx.destination);

  const decks = new Map<DeckId, Deck>();
  const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  let liveDeck: DeckId = 'a';
  let eqConfig = initialEq;
  let disposed = false;

  const releaseDeck = (deck: Deck): void => {
    // EQ owns its source connections too: dispose BEFORE reconnecting a cached source.
    deck.eq.dispose();
    for (const node of [deck.bass, deck.sweep, deck.gain]) node.disconnect();
    decks.delete(deck.id);
  };

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
    if (existing) releaseDeck(existing);
    const previous = [...decks.values()].find(deck => deck.element === element);
    if (previous) {
      if (previous.id === liveDeck) liveDeck = id;
      releaseDeck(previous);
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
    // Cutting to a deck that is not attached would silence everything; the parent calls this on
    // pause and seek, when the other slot may hold nothing yet.
    if (disposed || !decks.has(target)) return;
    const at = ctx.currentTime;
    for (const deck of decks.values()) {
      const want = deck.id === target ? 1 : 0;
      // A cut ends any transition, so the filters go back to flat — otherwise a track that was
      // mid-sweep when the listener pressed Next stays thin for its whole play.
      restFilters(deck, at);
      // From wherever a fade in flight had actually reached, so cancelling mid-crossfade (pause,
      // seek, or a cancelled transition) does not jump the level.
      rampParam(deck.gain.gain, want, at, at + CUT_SECONDS);
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
      if (disposed || target === liveDeck || !decks.has(target)) return liveDeck;
      const from = decks.get(liveDeck);
      const to = decks.get(target);
      const at = ctx.currentTime;
      // A plain fade leaves no filtering behind, so an earlier styled transition's filters have to
      // be cleared here too or the incoming deck arrives thin for the rest of its play.
      if (to) {
        restFilters(to, at);
        rampCurve(to.gain.gain, 1, at, seconds);
      }
      if (from) rampCurve(from.gain.gain, 0, at, seconds);
      liveDeck = target;
      return liveDeck;
    },
    transitionTo(target, seconds, style) {
      if (disposed || target === liveDeck || !decks.has(target)) return liveDeck;
      const from = decks.get(liveDeck);
      const to = decks.get(target);
      const at = ctx.currentTime;
      const span = duration(seconds);

      // A cut is not a fade: hand over in one step rather than pretending to blend.
      if (style === 'cut') {
        cutTo(target);
        return liveDeck;
      }

      // The incoming deck may still be carrying filters from the transition that took it out.
      if (to) restFilters(to, at);
      if (to) rampCurve(to.gain.gain, 1, at, span);
      if (from) rampCurve(from.gain.gain, 0, at, span);

      if (style === 'bass-swap' || style === 'filter') {
        // The incoming track arrives with its lows held down and takes them at the halfway point,
        // so the two basslines never both sit at full level.
        if (to) {
          // Reached over a few ms rather than set: on a reversal the incoming deck is already
          // audible, and dropping an 18 dB shelf in one sample is a click.
          rampParam(to.bass.gain, BASS_DUCK_DB, at, at + CUT_SECONDS);
          chainParam(to.bass.gain, BASS_DUCK_DB, 0, at + CUT_SECONDS, at + span / 2);
        }
        if (from) {
          rampParam(from.bass.gain, BASS_DUCK_DB, at, at + span / 2);
        }
      }

      if (style === 'filter') {
        // The outgoing track thins out as it leaves — the move a DJ makes with a highpass.
        if (from) {
          rampParam(from.sweep.frequency, SWEEP_TOP_HZ, at, at + span, true);
        }
      }

      liveDeck = target;
      return liveDeck;
    },
    cut: cutTo,
    peek: () => {
      const out: BusPeek = { live: liveDeck, master: master.gain.value, decks: {} };
      for (const [id, d] of decks) out.decks[id] = { gain: d.gain.gain.value, src: d.element.currentSrc || d.element.src || '', eq: d.eq.peek() };
      return out;
    },
    masterGain: () => master.gain.value,
    setMasterGain(v) {
      const want = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
      if (disposed) return;
      const now = ctx.currentTime;
      rampParam(master.gain, want, now, now + CUT_SECONDS);
    },
    trimDb: () => decks.get(liveDeck)?.eq.trimDb() ?? 0,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const deck of [...decks.values()]) releaseDeck(deck);
      decks.clear();
      master.disconnect();
      limiter.disconnect();
    },
  };
}

/** The other deck. The player alternates, so song N and song N+1 are never on the same one. */
export const otherDeck = (id: DeckId): DeckId => (id === 'a' ? 'b' : 'a');
