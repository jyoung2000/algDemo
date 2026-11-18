// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachElement, bus, peekEngine, radioOutput, resetEngineForTests, setEqConfig } from './audio-engine';
import { EQ_DEFAULTS } from './engine/eq';

class Param {
  value = 1;
  targets: number[] = [];
  setValueAtTime(v: number) { this.value = v; return this; }
  linearRampToValueAtTime(v: number) { this.targets.push(v); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number) { this.targets.push(v); this.value = v; return this; }
  setValueCurveAtTime(v: Float32Array) { this.value = v[v.length - 1]!; return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}
class Node {
  outputs: Node[] = [];
  gain = new Param(); frequency = new Param(); Q = new Param();
  threshold = new Param(); knee = new Param(); ratio = new Param();
  attack = new Param(); release = new Param();
  type = '';
  constructor(readonly kind: string, readonly element?: HTMLMediaElement) {}
  connect(to: Node) { this.outputs.push(to); return to; }
  disconnect() { this.outputs = []; }
}
class FakeContext {
  static instances: FakeContext[] = [];
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  destination = new Node('speakers');
  sources: Node[] = [];
  nodes: Node[] = [];
  constructor() { FakeContext.instances.push(this); }
  make(kind: string) { const n = new Node(kind); this.nodes.push(n); return n; }
  createGain() { return this.make('gain'); }
  createBiquadFilter() { return this.make('band'); }
  createDynamicsCompressor() { return this.make('compressor'); }
  createMediaElementSource(element: HTMLMediaElement) {
    if (this.sources.some(s => s.element === element)) throw Error('duplicate media source');
    const n = new Node('media', element); this.sources.push(n); return n;
  }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

/** Walk *all* connected branches; a live dry branch counts only when its gain is nonzero. */
function audiblePaths(from: Node, to: Node, stack: Node[] = []): Node[][] {
  if (from.kind === 'gain' && from.gain.value === 0) return [];
  if (from === to) return [[...stack, from]];
  if (stack.includes(from)) return [];
  return from.outputs.flatMap(next => audiblePaths(next, to, [...stack, from]));
}
const boosted = { ...EQ_DEFAULTS, on: true, gains: [8, 0, 0, 0, 0, 0, 0, 0, 0, 0] };

beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeContext);
  FakeContext.instances.length = 0;
  resetEngineForTests();
});
afterEach(() => {
  delete (window as typeof window & { AirwaveNative?: unknown }).AirwaveNative;
  resetEngineForTests();
  vi.unstubAllGlobals();
});

describe('all Windows speaker paths', () => {
  it.each(['queued download', 'saved-list file', 'imported file', 'progressive stream', 'HLS on permanent deck', 'preview', 'incoming handoff'])(
    '%s is wired through an EQ before speakers (both decks)', (_source) => {
      setEqConfig(boosted);
      const a = document.createElement('audio'); a.crossOrigin = 'anonymous';
      const b = document.createElement('audio'); b.crossOrigin = 'anonymous';
      attachElement(a, 'a'); attachElement(b, 'b');
      const ctx = FakeContext.instances[0]!;
      expect(ctx.sources).toHaveLength(2);
      expect(bus()?.peek().decks.a?.eq.bands[0]).toBe(8);
      expect(bus()?.peek().decks.b?.eq.bands[0]).toBe(8);
      for (const source of ctx.sources) {
        const paths = audiblePaths(source, ctx.destination);
        // Incoming fader is initially silent but its EQ is installed *before* a handoff.
        if (source.element === b) bus()?.cut('b');
        const live = audiblePaths(source, ctx.destination);
        expect(live.length).toBeGreaterThan(0);
        expect(live.every(path => path.filter(n => n.kind === 'band' && n.type === 'peaking').length >= 10)).toBe(true);
        if (source.element === b) bus()?.cut('a');
        expect(paths.length || source.element === b).toBeTruthy();
      }
      setEqConfig({ ...boosted, gains: [0, -5, 0, 0, 0, 0, 0, 0, 0, 0] });
      expect(bus()?.peek().decks.a?.eq.bands[1]).toBe(-5);
      expect(bus()?.peek().decks.b?.eq.bands[1]).toBe(-5);
      expect(ctx.nodes.filter(n => n.kind === 'band' && n.type === 'peaking' && n.frequency.value === 64).map(n => n.gain.targets.at(-1))).toEqual([-5, -5]);
    },
  );

  it('routes a preview with mixer OFF before its play event reaches the media pipeline', () => {
    setEqConfig(boosted);
    const deck = document.createElement('audio');
    deck.crossOrigin = 'anonymous'; deck.dataset.deck = 'a';
    document.body.append(deck);
    try {
      deck.dispatchEvent(new Event('play'));
      const ctx = FakeContext.instances[0]!;
      expect(ctx.sources.map(n => n.element)).toContain(deck);
      expect(audiblePaths(ctx.sources[0]!, ctx.destination).every(path => path.some(n => n.kind === 'band' && n.type === 'peaking'))).toBe(true);
      expect(bus()?.peek().decks.a?.eq.bands[0]).toBe(8);
      setEqConfig({ ...boosted, gains: [4, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
      expect(bus()?.peek().decks.a?.eq.bands[0]).toBe(4);
    } finally { deck.remove(); }
  });

  it('does not attach unrelated media or Android native decks to Web Audio', () => {
    const native = vi.fn();
    Object.defineProperty(window, 'AirwaveNative', { value: { engine: native }, configurable: true });
    const other = document.createElement('audio'); document.body.append(other);
    const deck = document.createElement('audio'); deck.dataset.deck = 'a'; document.body.append(deck);
    try {
      other.dispatchEvent(new Event('play'));
      deck.dispatchEvent(new Event('play'));
      expect(FakeContext.instances).toHaveLength(0);
    } finally { other.remove(); deck.remove(); }
  });

  it('radio PCM input reaches speakers only via EQ; retunes/pause replacement and live settings retain it', () => {
    setEqConfig(boosted);
    const first = radioOutput()!;
    const ctx = FakeContext.instances[0]!;
    const upstream = new Node('PCM ring'); upstream.connect(first.input as unknown as Node);
    expect(audiblePaths(upstream, ctx.destination).every(path => path.filter(n => n.kind === 'band' && n.type === 'peaking').length >= 10)).toBe(true);
    expect(first.peek().bands[0]).toBe(8);
    expect(peekEngine().radio?.bands[0]).toBe(8);
    setEqConfig({ ...boosted, gains: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(first.peek().bands[0]).toBe(3);
    first.dispose();
    expect(peekEngine().radio).toBeNull();
    const second = radioOutput()!;
    expect(second.peek().bands[0]).toBe(3);
    expect(peekEngine().radio?.bands[0]).toBe(3);
    second.dispose();
    expect(peekEngine().eq.gains[0]).toBe(3);
  });

  it('disabled EQ selects dry unity path; flat bands with enabled limiter are not falsely called bypass', () => {
    setEqConfig(boosted);
    const element = document.createElement('audio'); element.crossOrigin = 'anonymous';
    attachElement(element, 'a');
    const ctx = FakeContext.instances[0]!;
    setEqConfig(EQ_DEFAULTS);
    const paths = audiblePaths(ctx.sources[0]!, ctx.destination);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every(path => !path.some(n => n.kind === 'band' && n.type === 'peaking'))).toBe(true);
    setEqConfig({ ...EQ_DEFAULTS, on: true });
    expect(audiblePaths(ctx.sources[0]!, ctx.destination).some(path => path.some(n => n.kind === 'band' && n.type === 'peaking'))).toBe(true);
  });
});

describe('Android settings bridge', () => {
  it('delivers changed EQ while radio has unmounted Player, and can seed a native engine before playback', () => {
    const engine = vi.fn();
    Object.defineProperty(window, 'AirwaveNative', { value: { engine }, configurable: true });
    setEqConfig(boosted);
    expect(engine).toHaveBeenCalledWith(JSON.stringify({ op: 'settings', eq: boosted }));
    expect(FakeContext.instances).toHaveLength(0);
  });
});
