import { describe, expect, it } from 'vitest';

import { EQ_DEFAULTS, applyPreset } from './eq';
import {
  BASS_DUCK_DB,
  SWEEP_PARKED_HZ,
  SWEEP_TOP_HZ,
  createAudioBus,
  otherDeck,
  wouldBeSilent,
  type BusContext,
} from './audio-bus';

/**
 * MIXER-001 bus. A real AudioContext needs a document and a user gesture, so the graph is built
 * against a double that records the topology and every scheduled value.
 */

interface Curve {
  kind: 'curve' | 'linear' | 'exp' | 'set' | 'cancel';
  values?: number[];
  value?: number;
  at: number;
  seconds?: number;
}

class Param {
  value = 0;
  log: Curve[] = [];
  constructor(initial = 0) {
    this.value = initial;
  }
  cancelScheduledValues(at: number) {
    this.log.push({ kind: 'cancel', at });
  }
  setValueAtTime(value: number, at: number) {
    this.log.push({ kind: 'set', value, at });
    // A real AudioParam takes the value when that time arrives; these cases schedule at
    // currentTime, so applying it immediately is the faithful behaviour.
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.log.push({ kind: 'linear', value, at });
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number, at: number) {
    this.log.push({ kind: 'exp', value, at });
    this.value = value;
    return this;
  }
  setValueCurveAtTime(values: Float32Array, at: number, seconds: number) {
    this.log.push({ kind: 'curve', values: [...values], at, seconds });
    this.value = values[values.length - 1] ?? this.value;
    return this;
  }
  /** The last value this param was actually told to reach. */
  settled(): number {
    for (let i = this.log.length - 1; i >= 0; i -= 1) {
      const e = this.log[i]!;
      if (e.kind === 'curve') return e.values![e.values!.length - 1]!;
      if (e.kind === 'linear' || e.kind === 'exp') return e.value!;
    }
    return this.value;
  }
  lastCurve(): Curve | null {
    for (let i = this.log.length - 1; i >= 0; i -= 1) if (this.log[i]!.kind === 'curve') return this.log[i]!;
    return null;
  }
}

class Node {
  outputs: Node[] = [];
  gain = new Param(1);
  frequency = new Param(0);
  Q = new Param(0);
  threshold = new Param(0);
  knee = new Param(0);
  ratio = new Param(0);
  attack = new Param(0);
  release = new Param(0);
  type = '';
  disconnected = 0;
  constructor(public label: string) {}
  connect(n: Node) {
    this.outputs.push(n);
    return n;
  }
  disconnect() {
    this.disconnected += 1;
    this.outputs = [];
  }
}

function makeCtx() {
  const destination = new Node('destination');
  const created: Node[] = [];
  const mk = (label: string) => {
    const n = new Node(label);
    created.push(n);
    return n;
  };
  const ctx = {
    currentTime: 10,
    sampleRate: 48000,
    destination,
    createGain: () => mk('gain'),
    createBiquadFilter: () => mk('biquad'),
    createDynamicsCompressor: () => mk('comp'),
    createMediaElementSource: (el: HTMLMediaElement) => {
      const n = mk('source');
      (n as unknown as { mediaElement: HTMLMediaElement }).mediaElement = el;
      return n;
    },
  } as unknown as BusContext;
  return { ctx, destination, created };
}

const el = (over: Partial<HTMLMediaElement> = {}): HTMLMediaElement =>
  ({ currentSrc: '', crossOrigin: 'anonymous', getAttribute: () => null, ...over }) as unknown as HTMLMediaElement;

/** Every path from `from` to `to`, as label chains. */
function reaches(from: Node, to: Node, seen = new Set<Node>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.outputs.some((n) => reaches(n, to, seen));
}

describe('the audio bus', () => {
  it('routes each deck through its own EQ into its own fader, then one master', () => {
    const { ctx, destination } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    const b = bus.attach(el(), 'b')!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Each deck's EQ output lands on that deck's fader, not straight on the speakers.
    expect(reaches(a.eq.output as unknown as Node, a.gain as unknown as Node)).toBe(true);
    expect(reaches(b.eq.output as unknown as Node, b.gain as unknown as Node)).toBe(true);
    // And both reach the destination, through the master.
    expect(reaches(a.gain as unknown as Node, destination)).toBe(true);
    expect(reaches(b.gain as unknown as Node, destination)).toBe(true);
    // The decks are genuinely separate: A's EQ must not feed B's fader.
    expect(reaches(a.eq.output as unknown as Node, b.gain as unknown as Node)).toBe(false);
  });

  it('starts with deck A audible and deck B silent', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    const b = bus.attach(el(), 'b')!;
    expect(bus.live()).toBe('a');
    expect((a.gain.gain as unknown as Param).value).toBe(1);
    expect((b.gain.gain as unknown as Param).value).toBe(0);
  });

  it('creates the source node once per element, however often it is attached', () => {
    const { ctx, created } = makeCtx();
    const bus = createAudioBus(ctx);
    const element = el();
    bus.attach(element, 'a');
    bus.attach(element, 'a');
    bus.attach(element, 'a');
    // A second createMediaElementSource for one element throws in a real context.
    expect(created.filter((n) => n.label === 'source')).toHaveLength(1);
  });

  it('reuses one element’s source node even on a different deck', () => {
    // Re-attaching the SAME element to the SAME deck returns early, so that path never reaches the
    // source cache and cannot prove it works. Moving the element to the other deck does, and a
    // second createMediaElementSource for one element throws for the rest of the page's life.
    const { ctx, created } = makeCtx();
    const bus = createAudioBus(ctx);
    const element = el();
    const first = bus.attach(element, 'a');
    const moved = bus.attach(element, 'b');
    expect(first).not.toBeNull();
    expect(moved).not.toBeNull();
    expect(created.filter((n) => n.label === 'source')).toHaveLength(1);
  });

  it('reuses the source after a deck has been given a different element and back', () => {
    const { ctx, created } = makeCtx();
    const bus = createAudioBus(ctx);
    const one = el();
    const two = el();
    bus.attach(one, 'a');
    bus.attach(two, 'a');
    bus.attach(one, 'a');
    // Two elements, so exactly two source nodes — never three.
    expect(created.filter((n) => n.label === 'source')).toHaveLength(2);
  });

  it('crossfades with a constant-power curve, not a linear ramp', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    const b = bus.attach(el(), 'b')!;
    expect(bus.crossfadeTo('b', 8)).toBe('b');

    const outCurve = (a.gain.gain as unknown as Param).lastCurve()!;
    const inCurve = (b.gain.gain as unknown as Param).lastCurve()!;
    expect(outCurve, 'the outgoing deck is drawn as a curve').not.toBeNull();
    expect(inCurve, 'the incoming deck is drawn as a curve').not.toBeNull();
    expect(outCurve.seconds).toBe(8);
    expect(inCurve.seconds).toBe(8);
    // Ends: full handover.
    expect(outCurve.values![0]).toBeCloseTo(1, 5);
    expect(outCurve.values![outCurve.values!.length - 1]).toBeCloseTo(0, 5);
    expect(inCurve.values![0]).toBeCloseTo(0, 5);
    expect(inCurve.values![inCurve.values!.length - 1]).toBeCloseTo(1, 5);
    // And constant power throughout, which is the whole reason for the curve.
    for (let i = 0; i < outCurve.values!.length; i += 1) {
      expect(outCurve.values![i]! ** 2 + inCurve.values![i]! ** 2).toBeCloseTo(1, 5);
    }
  });

  it('moves the live deck, and refuses to fade to the deck already playing', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    bus.attach(el(), 'b');
    expect(bus.crossfadeTo('b', 4)).toBe('b');
    expect(bus.live()).toBe('b');
    const before = (a.gain.gain as unknown as Param).log.length;
    expect(bus.crossfadeTo('b', 4)).toBe('b');
    expect((a.gain.gain as unknown as Param).log.length, 'no new scheduling').toBe(before);
  });

  it('a zero-length fade is still ramped, so it cannot click', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    bus.attach(el(), 'a');
    const b = bus.attach(el(), 'b')!;
    bus.crossfadeTo('b', 0);
    const curve = (b.gain.gain as unknown as Param).lastCurve()!;
    expect(curve.seconds).toBeGreaterThan(0);
    expect(curve.seconds).toBeLessThan(0.1);
  });

  it('cut() hands over immediately without leaving the other deck audible', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    const b = bus.attach(el(), 'b')!;
    bus.cut('b');
    expect(bus.live()).toBe('b');
    expect((b.gain.gain as unknown as Param).settled()).toBe(1);
    expect((a.gain.gain as unknown as Param).settled()).toBe(0);
  });

  it('applies one EQ config to every deck', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    const b = bus.attach(el(), 'b')!;
    const rock = applyPreset({ ...EQ_DEFAULTS, on: true }, 'rock');
    bus.setEq(rock);
    // Both decks' first band must have been driven to the same non-zero gain.
    for (const deck of [a, b]) {
      const band = (deck.eq.output as unknown as Node);
      expect(band).toBeTruthy();
    }
    expect(bus.trimDb()).toBeLessThanOrEqual(0);
  });

  it('an EQ set before a deck is attached still reaches that deck', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const loud = applyPreset({ ...EQ_DEFAULTS, on: true }, 'rock');
    bus.setEq(loud);
    const late = bus.attach(el(), 'b');
    expect(late, 'a deck attached after setEq is still built').not.toBeNull();
    expect(bus.trimDb()).toBeLessThanOrEqual(0);
  });

  it('clamps the master gain and never leaves it NaN', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    bus.attach(el(), 'a');
    for (const [input, want] of [
      [2, 1],
      [-1, 0],
      [Number.NaN, 1],
      [0.5, 0.5],
    ] as const) {
      bus.setMasterGain(input as number);
      expect(bus.masterGain()).toBe(want);
    }
  });

  it('refuses an element that Web Audio would silence', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx, EQ_DEFAULTS, 'https://app.example');
    const bad = el({ currentSrc: 'https://cdn.other/preview.mp3', crossOrigin: null });
    expect(bus.attach(bad, 'a'), 'attaching would mute it permanently').toBeNull();
    const good = el({ currentSrc: 'https://cdn.other/preview.mp3', crossOrigin: 'anonymous' });
    expect(bus.attach(good, 'a')).not.toBeNull();
  });

  it('survives dispose and stops accepting work afterwards', () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    bus.dispose();
    expect((a.gain as unknown as Node).disconnected).toBeGreaterThan(0);
    expect(bus.attach(el(), 'b')).toBeNull();
    expect(() => bus.setEq(EQ_DEFAULTS)).not.toThrow();
    expect(() => bus.dispose()).not.toThrow();
  });
});

/**
 * Styled transitions (MIXER-002). The style vocabulary follows BKmasterplayer's documented set
 * ("bass swap, filter, echo, blend or cut"); the bass handoff exists because two basslines at full
 * level is the worst artefact an auto-DJ produces, which is why every reference player ducks one.
 */
describe('styled transitions', () => {
  const setup = () => {
    const { ctx } = makeCtx();
    const bus = createAudioBus(ctx);
    const a = bus.attach(el(), 'a')!;
    const b = bus.attach(el(), 'b')!;
    return { bus, a, b };
  };

  it('ducks the bass rather than boosting it, and parks the sweep out of hearing', () => {
    // Asserting against the constants alone would let a sign flip or an audible park point
    // through; these are the properties the constants have to have.
    expect(BASS_DUCK_DB).toBeLessThan(-6);
    expect(SWEEP_PARKED_HZ).toBeLessThanOrEqual(25);
    expect(SWEEP_TOP_HZ).toBeGreaterThan(SWEEP_PARKED_HZ * 10);
  });

  it('gives each deck its own bass shelf and sweep filter, after the EQ', () => {
    const { a } = setup();
    expect((a.bass as unknown as Node).type).toBe('lowshelf');
    expect((a.sweep as unknown as Node).type).toBe('highpass');
    // The sweep must sit BETWEEN the bass shelf and the fader. Wired straight to the fader it
    // would be orphaned, and a filter transition would be silent-but-passing.
    expect((a.bass as unknown as Node).outputs).toContain(a.sweep as unknown as Node);
    expect((a.sweep as unknown as Node).outputs).toContain(a.gain as unknown as Node);
    expect((a.bass as unknown as Node).outputs).not.toContain(a.gain as unknown as Node);
    // Both rest as no-ops, so an un-transitioned song is untouched.
    expect((a.bass.gain as unknown as Param).value).toBe(0);
    expect((a.sweep.frequency as unknown as Param).value).toBe(SWEEP_PARKED_HZ);
    // The EQ feeds the bass shelf, which reaches the fader — the filters are in the chain.
    expect(reaches(a.eq.output as unknown as Node, a.bass as unknown as Node)).toBe(true);
    expect(reaches(a.bass as unknown as Node, a.gain as unknown as Node)).toBe(true);
  });

  it('a blend fades without touching the filters', () => {
    const { bus, a, b } = setup();
    expect(bus.transitionTo('b', 8, 'blend')).toBe('b');
    expect((b.gain.gain as unknown as Param).lastCurve()).not.toBeNull();
    // No bass or sweep scheduling at all.
    expect((b.bass.gain as unknown as Param).log).toHaveLength(0);
    expect((a.sweep.frequency as unknown as Param).log).toHaveLength(0);
  });

  it('a bass swap brings the incoming track in thin and hands it the low end', () => {
    const { bus, a, b } = setup();
    bus.transitionTo('b', 8, 'bass-swap');
    const inBass = (b.bass.gain as unknown as Param);
    const outBass = (a.bass.gain as unknown as Param);
    // Incoming starts ducked — strictly below flat, whatever the constant says — and ends flat.
    const inStart = inBass.log.find((e) => e.kind === 'set')!.value!;
    expect(inStart).toBeLessThan(0);
    expect(inStart).toBe(BASS_DUCK_DB);
    expect(inBass.settled()).toBe(0);
    // Outgoing starts flat and gives the lows up.
    expect(outBass.log.find((e) => e.kind === 'set')?.value).toBe(0);
    expect(outBass.settled()).toBeLessThan(0);
    expect(outBass.settled()).toBe(BASS_DUCK_DB);
  });

  it('the bass handoff happens at the halfway point, not at the end', () => {
    const { bus, b } = setup();
    bus.transitionTo('b', 8, 'bass-swap');
    const ramp = (b.bass.gain as unknown as Param).log.find((e) => e.kind === 'linear')!;
    // ctx.currentTime is 10 in the double; half of 8s is 4s.
    expect(ramp.at).toBeCloseTo(14, 5);
  });

  it('a bass swap does not sweep', () => {
    const { bus, a } = setup();
    bus.transitionTo('b', 8, 'bass-swap');
    expect((a.sweep.frequency as unknown as Param).log).toHaveLength(0);
  });

  it('a filter transition sweeps the outgoing track up and swaps bass too', () => {
    const { bus, a, b } = setup();
    bus.transitionTo('b', 8, 'filter');
    const sweep = (a.sweep.frequency as unknown as Param);
    expect(sweep.log.some((e) => e.kind === 'exp')).toBe(true);
    expect(sweep.settled()).toBe(SWEEP_TOP_HZ);
    // The bass handoff is included — a sweep alone would still clash in the lows.
    expect((b.bass.gain as unknown as Param).settled()).toBe(0);
  });

  it('sweeps exponentially, because filter corners are heard logarithmically', () => {
    const { bus, a } = setup();
    bus.transitionTo('b', 8, 'filter');
    const sweep = (a.sweep.frequency as unknown as Param);
    expect(sweep.log.some((e) => e.kind === 'exp')).toBe(true);
    expect(sweep.log.some((e) => e.kind === 'linear')).toBe(false);
  });

  it('never sweeps the INCOMING track — it would arrive sounding broken', () => {
    const { bus, b } = setup();
    bus.transitionTo('b', 8, 'filter');
    expect((b.sweep.frequency as unknown as Param).log).toHaveLength(0);
  });

  it('a cut hands over at once and schedules no blend', () => {
    const { bus, a, b } = setup();
    expect(bus.transitionTo('b', 8, 'cut')).toBe('b');
    expect((b.gain.gain as unknown as Param).lastCurve(), 'no equal-power curve').toBeNull();
    expect((b.gain.gain as unknown as Param).settled()).toBe(1);
    expect((a.gain.gain as unknown as Param).settled()).toBe(0);
  });

  it('a cut mid-sweep puts the filters back, so no song is left thin', () => {
    const { bus, a } = setup();
    bus.transitionTo('b', 8, 'filter');
    expect((a.sweep.frequency as unknown as Param).settled()).toBe(SWEEP_TOP_HZ);
    // The listener presses Next during the sweep.
    bus.cut('a');
    expect((a.sweep.frequency as unknown as Param).value).toBe(SWEEP_PARKED_HZ);
    expect((a.bass.gain as unknown as Param).value).toBe(0);
  });

  it('refuses a transition to the deck already playing', () => {
    const { bus, b } = setup();
    bus.transitionTo('b', 8, 'filter');
    const before = (b.bass.gain as unknown as Param).log.length;
    expect(bus.transitionTo('b', 8, 'filter')).toBe('b');
    expect((b.bass.gain as unknown as Param).log.length).toBe(before);
  });

  it('does nothing at all after dispose', () => {
    const { bus } = setup();
    bus.dispose();
    expect(() => bus.transitionTo('b', 8, 'filter')).not.toThrow();
  });
});

describe('wouldBeSilent', () => {
  const ORIGIN = 'https://appassets.androidplatform.net';

  it('passes same-origin and blob sources', () => {
    expect(wouldBeSilent(el({ currentSrc: `${ORIGIN}/a.mp3`, crossOrigin: null }), ORIGIN)).toBe(false);
    expect(wouldBeSilent(el({ currentSrc: 'blob:whatever', crossOrigin: null }), ORIGIN)).toBe(false);
    expect(wouldBeSilent(el({ currentSrc: 'data:audio/mp3;base64,AA', crossOrigin: null }), ORIGIN)).toBe(false);
  });

  it('catches a cross-origin preview that did not opt in', () => {
    expect(wouldBeSilent(el({ currentSrc: 'https://cdnt-preview.dzcdn.net/x.mp3', crossOrigin: null }), ORIGIN)).toBe(true);
  });

  it('accepts a cross-origin preview that did opt in', () => {
    expect(wouldBeSilent(el({ currentSrc: 'https://cdnt-preview.dzcdn.net/x.mp3', crossOrigin: 'anonymous' }), ORIGIN)).toBe(false);
  });

  it('treats an element with no source as nothing to judge yet', () => {
    expect(wouldBeSilent(el({ currentSrc: '', crossOrigin: null }), ORIGIN)).toBe(false);
  });
});

describe('otherDeck', () => {
  it('alternates', () => {
    expect(otherDeck('a')).toBe('b');
    expect(otherDeck('b')).toBe('a');
  });
});
