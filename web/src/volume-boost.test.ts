// @vitest-environment happy-dom
// VOLUME-BOOST-001 (owner, 2026-11-19): "Add a slider to increase the volume past the stock limits ... up to 200%
// with a slider or android auto and the audio still sound crisp and audible."
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { Volume } from './Volume';
import { VOLUME_MAX, boostGain, elementVolume, nextCarLevel, readVolume, softClipCurve, SOFT_CLIP_FROM } from './engine/volume-boost';
import { createAudioBus, type BusContext } from './engine/audio-bus';
import { LIMITER, LIMITER_BOOST } from './engine/eq';

afterEach(cleanup);

describe('the volume range', () => {
  it('goes to 200%: the element plays at most at its own 100%, the rest is the boost', () => {
    expect(VOLUME_MAX).toBe(2);
    expect(elementVolume(0.4)).toBe(0.4);
    expect(elementVolume(1.6)).toBe(1);
    expect(boostGain(0.4)).toBe(1);
    expect(boostGain(1.6)).toBeCloseTo(1.6);
    expect(boostGain(5)).toBe(2);
  });
  it('a saved volume up to 200% is kept; anything else falls back to 80%', () => {
    expect(readVolume(JSON.stringify({ value: 1.5, muted: false }))).toEqual({ value: 1.5, muted: false });
    expect(readVolume(JSON.stringify({ value: 2.5 })).value).toBe(0.8);
    expect(readVolume('nope').value).toBe(0.8);
  });
  it('the car button steps 100 → 125 → 150 → 175 → 200 → 100%', () => {
    expect([0.6, 1, 1.25, 1.5, 1.75, 2].map(nextCarLevel)).toEqual([1, 1.25, 1.5, 1.75, 2, 1]);
    expect(nextCarLevel(1.3)).toBe(1.5);
  });
  it('the soft ceiling leaves everything below -1 dBFS untouched and never reaches full scale', () => {
    const c = softClipCurve(2049);
    const at = (x: number) => c[Math.round(((x + 1) / 2) * (c.length - 1))]!;
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(at(-0.8)).toBeCloseTo(-0.8, 3);
    expect(Math.abs(at(1))).toBeLessThan(1);
    expect(Math.abs(at(1))).toBeGreaterThan(SOFT_CLIP_FROM);
  });
});

describe('the slider', () => {
  it('runs from 0 to 200%, marks where the boost begins, and reports 150% as 1.5', () => {
    const onChange = vi.fn();
    vi.useFakeTimers();
    const { container } = render(createElement(Volume, { value: 1.5, max: 2, muted: false, onChange, onToggleMute: () => {} }));
    fireEvent.click(container.querySelector('.vol__btn')!);
    act(() => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();
    const bar = container.querySelector<HTMLInputElement>('.vol__bar')!;
    expect(bar.max).toBe('200');
    expect(bar.value).toBe('150');
    expect(container.querySelector('.vol__n')!.textContent).toBe('150%');
    expect(container.querySelector('.vol')!.classList.contains('is-boosted')).toBe(true);
    expect(bar.style.getPropertyValue('--pct')).toBe('75%');
    expect(container.querySelector('.vol__mark')).not.toBeNull();
    fireEvent.change(bar, { target: { value: '175' } });
    expect(onChange).toHaveBeenLastCalledWith(1.75);
  });
  it('where the audio cannot be boosted (max 1) it is the old 0..100% slider with no mark', () => {
    vi.useFakeTimers();
    const { container } = render(createElement(Volume, { value: 1.5, muted: false, onChange: () => {}, onToggleMute: () => {} }));
    fireEvent.click(container.querySelector('.vol__btn')!);
    act(() => { vi.advanceTimersByTime(400); });
    vi.useRealTimers();
    expect(container.querySelector<HTMLInputElement>('.vol__bar')!.max).toBe('100');
    expect(container.querySelector('.vol__n')!.textContent).toBe('100%');
    expect(container.querySelector('.vol__mark')).toBeNull();
  });
});

// The same fake graph the bus tests use, reduced to what the boost touches.
class Param { value: number; constructor(v: number) { this.value = v; } setValueAtTime(v: number) { this.value = v; } linearRampToValueAtTime(v: number) { this.value = v; } exponentialRampToValueAtTime(v: number) { this.value = v; } setValueCurveAtTime(v: number[]) { this.value = v[v.length - 1]!; } cancelScheduledValues() {} cancelAndHoldAtTime() {} }
class N { outputs: N[] = []; gain = new Param(1); frequency = new Param(0); Q = new Param(0); threshold = new Param(0); knee = new Param(0); ratio = new Param(0); attack = new Param(0); release = new Param(0); type = ''; curve: Float32Array | null = null; oversample = 'none'; constructor(public label: string) {} connect(n: N) { this.outputs.push(n); return n; } disconnect() { this.outputs = []; } }
function ctx() {
  const created: N[] = [];
  const mk = (l: string) => { const n = new N(l); created.push(n); return n; };
  const destination = new N('destination');
  const c = { currentTime: 1, sampleRate: 48000, destination, createGain: () => mk('gain'), createBiquadFilter: () => mk('biquad'), createDynamicsCompressor: () => mk('comp'), createWaveShaper: () => mk('shaper'), createMediaElementSource: () => mk('source') } as unknown as BusContext;
  return { c, created, destination };
}

describe('the mix bus boost (Windows)', () => {
  it('above 100% the master gain goes past 1, the limiter holds longer and the soft ceiling is in; at or below 100% it is as before', () => {
    const { c, created, destination } = ctx();
    const bus = createAudioBus(c);
    const comp = created.find((n) => n.label === 'comp')!;
    const shaper = created.find((n) => n.label === 'shaper')!;
    expect(comp.outputs).toContain(shaper);
    expect(shaper.outputs).toContain(destination);
    expect(shaper.curve).toBeNull();
    bus.setMasterGain(1.8);
    expect(bus.masterGain()).toBeCloseTo(1.8);
    expect(comp.threshold.value).toBe(LIMITER_BOOST.thresholdDb);
    expect(comp.release.value).toBe(LIMITER_BOOST.releaseSeconds);
    expect(shaper.curve).not.toBeNull();
    bus.setMasterGain(0.7);
    expect(bus.masterGain()).toBeCloseTo(0.7);
    expect(comp.threshold.value).toBe(LIMITER.thresholdDb);
    expect(comp.release.value).toBe(LIMITER.releaseSeconds);
    expect(shaper.curve).toBeNull();
    bus.setMasterGain(9);
    expect(bus.masterGain()).toBe(2);
  });
  it('an audio context without WaveShaper still gets the gain and limiter', () => {
    const { c } = ctx();
    delete (c as unknown as { createWaveShaper?: unknown }).createWaveShaper;
    const bus = createAudioBus(c);
    bus.setMasterGain(1.5);
    expect(bus.masterGain()).toBeCloseTo(1.5);
  });
});

describe('boost is visible (seen on Windows: fill stayed blue, the tick vanished on it)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/volume-pop.css'), 'utf8');
  it('past the normal maximum the fill itself turns amber, not just the number', () => {
    expect(css).toMatch(/\.vol\.is-boosted \.vol__pop \.vol__bar\s*\{[^}]*background:\s*linear-gradient\(to right, #0071e3 var\(--at, 50%\), #e8890c var\(--at, 50%\) var\(--pct/);
  });
  it('the tick sits above the fill in a colour that shows on blue and on grey', () => {
    const mark = /\.vol__mark\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(mark).toMatch(/z-index:\s*1/);
    expect(mark).toMatch(/background:\s*#fff/);
    expect(mark).toMatch(/box-shadow:/);
    expect(mark).not.toMatch(/opacity/);
  });
  it('the track carries the mark position so the fill can use it', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/Volume.tsx'), 'utf8');
    expect(src).toMatch(/className="vol__track" style=\{[^\n]*--at/);
  });
});
