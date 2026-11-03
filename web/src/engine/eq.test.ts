import { describe, expect, it } from 'vitest';

import {
  EQ_BANDS_HZ,
  EQ_DEFAULTS,
  EQ_PRESETS,
  EQ_Q,
  LIMITER,
  applyPreset,
  clampGain,
  createEqGraph,
  dbToGain,
  eqCurve,
  headroomTrimDb,
  matchesPreset,
  parseEq,
  presetById,
  requiredHeadroomDb,
  responseDbAt,
  type EqConfig,
  type EqContext,
} from './eq';

/* ------------------------------------------------------------------ a mock context */

class Param {
  value: number;
  /** Every value this param was ever ramped or set to, so a test can assert the end state. */
  readonly history: number[] = [];
  constructor(value = 0) {
    this.value = value;
    this.history.push(value);
  }
  setValueAtTime(v: number) {
    this.value = v;
    this.history.push(v);
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    this.history.push(v);
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    this.history.push(v);
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}

class Node {
  readonly outputs: Node[] = [];
  disconnected = 0;
  constructor(readonly kind: string) {}
  connect(to: Node) {
    this.outputs.push(to);
    return to;
  }
  disconnect() {
    this.disconnected += 1;
  }
}

class GainNode_ extends Node {
  readonly gain = new Param(1);
  constructor() {
    super('gain');
  }
}

class BiquadNode extends Node {
  type = 'lowpass';
  readonly frequency = new Param(350);
  readonly Q = new Param(1);
  readonly gain = new Param(0);
  constructor() {
    super('biquad');
  }
}

class CompressorNode extends Node {
  readonly threshold = new Param(-24);
  readonly knee = new Param(30);
  readonly ratio = new Param(12);
  readonly attack = new Param(0.003);
  readonly release = new Param(0.25);
  readonly reduction = 0;
  constructor() {
    super('compressor');
  }
}

function mockContext(sampleRate = 48000) {
  const made: Node[] = [];
  const track = <T extends Node>(n: T): T => {
    made.push(n);
    return n;
  };
  const destination = new Node('destination');
  const ctx = {
    currentTime: 0,
    sampleRate,
    destination: destination as unknown as AudioNode,
    createGain: () => track(new GainNode_()) as unknown as GainNode,
    createBiquadFilter: () => track(new BiquadNode()) as unknown as BiquadFilterNode,
    createDynamicsCompressor: () => track(new CompressorNode()) as unknown as DynamicsCompressorNode,
    createMediaElementSource: () => track(new Node('source')) as unknown as MediaElementAudioSourceNode,
  } satisfies EqContext;
  return { ctx, made, destination };
}

/** Walk the graph from the source and report every path to the destination, as node kinds. */
function paths(from: Node, to: Node): string[][] {
  const found: string[][] = [];
  const walk = (n: Node, trail: string[]) => {
    if (n === to) {
      found.push(trail);
      return;
    }
    for (const next of n.outputs) walk(next, [...trail, next.kind]);
  };
  walk(from, [from.kind]);
  return found;
}

/** Does any route from this node to the destination pass through a filter? */
function reachesVia(from: Node, to: Node, kind: string): boolean {
  const seen = new Set<Node>();
  const walk = (n: Node): boolean => {
    if (n === to) return false;
    if (seen.has(n)) return false;
    seen.add(n);
    return n.outputs.some((next) => next.kind === kind || walk(next));
  };
  return walk(from);
}

/**
 * The dry (bypass) gain node: the one the source feeds whose route to the output never passes
 * through a band filter. Found by topology so the test cannot be satisfied by some other gain
 * node that happens to sit at unity.
 */
function dryNode(source: Node, destination: Node): GainNode_ {
  const candidates = source.outputs.filter((n): n is GainNode_ => n instanceof GainNode_ && !reachesVia(n, destination, 'biquad'));
  expect(candidates, 'exactly one dry path should leave the source').toHaveLength(1);
  return candidates[0]!;
}

/** The wet gain node: the one whose route does pass through the band filters. */
function wetNode(source: Node, destination: Node): GainNode_ {
  const candidates = source.outputs.filter((n): n is GainNode_ => n instanceof GainNode_ && reachesVia(n, destination, 'biquad'));
  expect(candidates, 'exactly one processed path should leave the source').toHaveLength(1);
  return candidates[0]!;
}

const config = (over: Partial<EqConfig> = {}): EqConfig => ({ ...EQ_DEFAULTS, ...over });

/* ------------------------------------------------------------------ the maths */

describe('EQ presets and configuration (EQ-001)', () => {
  it('has ten bands, matching the Airwave player’s graphic centres', () => {
    expect([...EQ_BANDS_HZ]).toEqual([32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
    for (const preset of EQ_PRESETS) {
      expect(preset.gains, `${preset.id} should name every band`).toHaveLength(EQ_BANDS_HZ.length);
    }
  });

  it('offers Flat first, so the default changes nothing', () => {
    expect(EQ_PRESETS[0]?.id).toBe('flat');
    expect(EQ_PRESETS[0]?.gains.every((g) => g === 0)).toBe(true);
    expect(EQ_DEFAULTS.on).toBe(false);
    expect(requiredHeadroomDb(EQ_DEFAULTS)).toBe(0);
  });

  it('keeps every preset inside the slider range it will be drawn with', () => {
    for (const preset of EQ_PRESETS) {
      for (const g of preset.gains) expect(Math.abs(g), `${preset.id}`).toBeLessThanOrEqual(12);
    }
  });

  it('gives each preset a unique id and name', () => {
    expect(new Set(EQ_PRESETS.map((p) => p.id)).size).toBe(EQ_PRESETS.length);
    expect(new Set(EQ_PRESETS.map((p) => p.name)).size).toBe(EQ_PRESETS.length);
  });

  it('repairs anything read back from storage', () => {
    // A stored config from an older build, or a hand-edited one, must not break the player.
    const eq = parseEq({ on: true, presetId: 'rock', gains: [99, -99, 'x', null], preampDb: 50, limiter: false });
    expect(eq.gains).toHaveLength(EQ_BANDS_HZ.length);
    expect(eq.gains[0]).toBe(12);
    expect(eq.gains[1]).toBe(-12);
    expect(eq.gains[2]).toBe(0);
    expect(eq.gains[9]).toBe(0);
    expect(eq.preampDb).toBe(12);
    expect(eq.limiter).toBe(false);
    expect(parseEq(undefined)).toEqual(EQ_DEFAULTS);
    expect(parseEq({ limiter: undefined }).limiter).toBe(true);
  });

  it('applying a preset replaces every gain, and moving one makes it custom', () => {
    const rock = applyPreset(config(), 'rock');
    expect(rock.presetId).toBe('rock');
    expect(rock.gains).toEqual(presetById('rock')!.gains);
    expect(matchesPreset(rock)).toBe(true);
    const moved = { ...rock, gains: rock.gains.map((g, i) => (i === 4 ? g + 3 : g)) };
    expect(matchesPreset(moved)).toBe(false);
    // An unknown id is ignored rather than wiping the user's curve.
    expect(applyPreset(rock, 'nope')).toEqual(rock);
  });

  it('a band’s response peaks at its own centre and falls off either side', () => {
    const one = config({ gains: [0, 0, 0, 0, 0, 8, 0, 0, 0, 0] });
    const atCentre = responseDbAt(one, 1000);
    expect(atCentre).toBeCloseTo(8, 1);
    expect(responseDbAt(one, 250)).toBeLessThan(atCentre);
    expect(responseDbAt(one, 4000)).toBeLessThan(atCentre);
    // Far away it is effectively untouched.
    expect(Math.abs(responseDbAt(one, 32))).toBeLessThan(0.6);
  });

  it('counts the headroom a stack of boosts needs, including where neighbours add up', () => {
    expect(requiredHeadroomDb(config({ gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))).toBe(0);
    // Two adjacent +8 dB bands overlap, so the true peak is above either one alone.
    const pair = config({ gains: [0, 0, 0, 0, 8, 8, 0, 0, 0, 0] });
    expect(requiredHeadroomDb(pair)).toBeGreaterThan(8);
    expect(headroomTrimDb(pair)).toBe(-requiredHeadroomDb(pair));
    // Cuts alone never need headroom.
    expect(requiredHeadroomDb(config({ gains: [-6, -6, -6, 0, 0, 0, 0, 0, 0, 0] }))).toBe(0);
    // The preamp counts too.
    expect(requiredHeadroomDb(config({ preampDb: 6 }))).toBeCloseTo(6, 1);
  });

  it('draws a curve with one point per frequency asked for', () => {
    const curve = eqCurve(config({ gains: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0] }), [32, 1000, 16000]);
    expect(curve).toHaveLength(3);
    expect(curve[0]).toBeGreaterThan(curve[1]!);
  });

  it('clamps a gain to the range the UI offers', () => {
    expect(clampGain(99)).toBe(12);
    expect(clampGain(-99)).toBe(-12);
    expect(clampGain(Number.NaN)).toBe(0);
  });
});

/* ------------------------------------------------------------------ the graph */

describe('the EQ graph (EQ-001)', () => {
  it('builds one peaking filter per band, at that band’s centre and the player’s Q', () => {
    const { ctx, made } = mockContext();
    const source = new Node('source');
    createEqGraph(ctx, source as unknown as AudioNode, config({ on: true }));
    const filters = made.filter((n): n is BiquadNode => n instanceof BiquadNode);
    expect(filters).toHaveLength(EQ_BANDS_HZ.length);
    filters.forEach((f, i) => {
      expect(f.type).toBe('peaking');
      expect(f.frequency.value).toBe(EQ_BANDS_HZ[i]);
      expect(f.Q.value).toBe(EQ_Q);
    });
  });

  it('never asks for a centre above Nyquist, which would throw on a 22 kHz device', () => {
    const { ctx, made } = mockContext(22050);
    createEqGraph(ctx, new Node('source') as unknown as AudioNode, config({ on: true }));
    const filters = made.filter((n): n is BiquadNode => n instanceof BiquadNode);
    for (const f of filters) expect(f.frequency.value).toBeLessThan(22050 / 2);
    // The top band is pinned just under Nyquist rather than dropped.
    expect(filters[9]!.frequency.value).toBeCloseTo(22050 / 2 - 1, 0);
  });

  it('passes the signal through exactly one of the limiter and its bypass', () => {
    // Both open at once sums a limited and an unlimited copy of the same audio.
    const { ctx, made, destination } = mockContext();
    const source = new Node('source');
    const graph = createEqGraph(ctx, source as unknown as AudioNode, config({ on: true, limiter: true }));
    const gains = made.filter((n): n is GainNode_ => n instanceof GainNode_);
    const viaLimiter = paths(source, destination).filter((p) => p.includes('compressor'));
    const viaBypass = paths(source, destination).filter((p) => !p.includes('compressor') && p.includes('biquad'));
    expect(viaLimiter.length, 'a path through the limiter should exist').toBeGreaterThan(0);
    expect(viaBypass.length, 'a path around the limiter should exist').toBeGreaterThan(0);
    // With the limiter on, the bypass must be silent, and the other way round.
    const open = () => gains.filter((g) => g.gain.value > 0).length;
    const before = open();
    graph.apply(config({ on: true, limiter: false }));
    expect(open()).toBe(before);
    const sum = (a: number, b: number) => a + b;
    const limiterPathGains = gains.map((g) => g.gain.value).reduce(sum, 0);
    graph.apply(config({ on: true, limiter: true }));
    expect(gains.map((g) => g.gain.value).reduce(sum, 0)).toBeCloseTo(limiterPathGains, 5);
  });

  it('sets the limiter to a −1 dBFS ceiling', () => {
    const { ctx, made } = mockContext();
    createEqGraph(ctx, new Node('source') as unknown as AudioNode, config({ on: true }));
    const comp = made.find((n): n is CompressorNode => n instanceof CompressorNode)!;
    expect(comp.threshold.value).toBe(LIMITER.thresholdDb);
    expect(comp.ratio.value).toBe(LIMITER.ratio);
    expect(comp.attack.value).toBe(LIMITER.attackSeconds);
  });

  it('turning the EQ off returns the untouched signal at unity, not a quieter one', () => {
    // A bypass that is even slightly quieter reads as "the EQ sounds better", which is a lie.
    const { ctx, made, destination } = mockContext();
    const source = new Node('source');
    const boosted = config({ on: true, gains: [8, 8, 8, 0, 0, 0, 0, 0, 0, 0] });
    const graph = createEqGraph(ctx, source as unknown as AudioNode, boosted);
    graph.apply({ ...boosted, on: false });
    // The dry path must be exactly unity — not the processed path's matched level, which is
    // several dB down once a boost has been trimmed for headroom.
    expect(dryNode(source, destination).gain.value).toBe(1);
    expect(wetNode(source, destination).gain.value).toBe(0);
    expect(graph.trimDb()).toBe(0);
    // Every band is flattened when off, so re-enabling cannot leak a stale gain.
    const filters = made.filter((n): n is BiquadNode => n instanceof BiquadNode);
    for (const f of filters) expect(f.gain.value).toBe(0);
  });

  it('hands the signal to the processed path only when the EQ is on', () => {
    const { ctx, destination } = mockContext();
    const source = new Node('source');
    const graph = createEqGraph(ctx, source as unknown as AudioNode, config({ on: true }));
    expect(wetNode(source, destination).gain.value).toBe(1);
    expect(dryNode(source, destination).gain.value).toBe(0);
    graph.apply(config({ on: false }));
    expect(wetNode(source, destination).gain.value).toBe(0);
    expect(dryNode(source, destination).gain.value).toBe(1);
  });

  it('trims a boosted curve so it cannot clip, and reports the trim it used', () => {
    const { ctx, made } = mockContext();
    const loud = config({ on: true, gains: [10, 10, 10, 0, 0, 0, 0, 0, 0, 0] });
    const graph = createEqGraph(ctx, new Node('source') as unknown as AudioNode, loud);
    expect(graph.trimDb()).toBeLessThan(-9);
    expect(graph.trimDb()).toBe(headroomTrimDb(loud));
    // The trim is a real gain in the chain, not just a number on screen.
    const gains = made.filter((n): n is GainNode_ => n instanceof GainNode_);
    expect(gains.some((g) => Math.abs(g.gain.value - dbToGain(graph.trimDb())) < 1e-9)).toBe(true);
  });

  it('moves every value by a ramp, so a dragged slider does not click', () => {
    const { ctx, made } = mockContext();
    const graph = createEqGraph(ctx, new Node('source') as unknown as AudioNode, config({ on: true }));
    const band = made.filter((n): n is BiquadNode => n instanceof BiquadNode)[5]!;
    const before = band.gain.history.length;
    graph.apply(config({ on: true, gains: [0, 0, 0, 0, 0, 9, 0, 0, 0, 0] }));
    expect(band.gain.value).toBe(9);
    // Anchor + ramp, rather than a bare assignment.
    expect(band.gain.history.length).toBeGreaterThan(before + 1);
  });

  it('reaches the destination and releases every node when disposed', () => {
    const { ctx, made, destination } = mockContext();
    const source = new Node('source');
    const graph = createEqGraph(ctx, source as unknown as AudioNode, config({ on: true }));
    expect(paths(source, destination).length).toBeGreaterThan(0);
    graph.dispose();
    for (const n of made) expect(n.disconnected).toBeGreaterThan(0);
    expect(source.disconnected).toBeGreaterThan(0);
    // Applying after disposal is ignored rather than throwing into the player's render.
    expect(() => graph.apply(config({ on: true }))).not.toThrow();
  });

  it('clamps a stored gain beyond the range when it reaches the filters', () => {
    const { ctx, made } = mockContext();
    const graph = createEqGraph(ctx, new Node('source') as unknown as AudioNode, config({ on: true }));
    graph.apply({ ...config({ on: true }), gains: [900, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    const filters = made.filter((n): n is BiquadNode => n instanceof BiquadNode);
    expect(filters[0]!.gain.value).toBe(12);
  });
});
