// @vitest-environment happy-dom
// MARQUEE-STEADY-001 (owner, 2026-11-20): "Ensure the marquis or scroll effect keeps scrolling all the way through
// instead of just snapping back ... I'd rather it speed to finish the marquis to get back to the start than snap back
// to the beginning of the title". Cause: the marquee restarted whenever the screen around it redrew (the player
// redraws every second, the queue on every update), because it watched the React children's identity, not the text.
// Now it restarts only for new text, and even then a scroll under way speeds up to finish its loop instead of jumping.
// TAG-SPEED-001 (owner, same day): "Tags should marquis faster than they do now, not crazy fast but faster".
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marquee, MARQUEE_FINISH_RATE, MARQUEE_SPEED, TAG_MARQUEE_SPEED, marqueeLoopSeconds, marqueeRestart } from './Marquee';

type Cb = (entries: { isIntersecting: boolean; target: Element }[]) => void;
let ios: { cb: Cb; els: Element[] }[] = [];
class FakeIO { cb: Cb; els: Element[] = []; constructor(cb: Cb) { this.cb = cb; ios.push(this); } observe(el: Element) { this.els.push(el); } unobserve() {} disconnect() { this.els = []; } takeRecords() { return []; } }
const realIO = globalThis.IntersectionObserver;
const show = (on: boolean) => act(() => { for (const io of ios) io.cb(io.els.map((target) => ({ isIntersecting: on, target }))); });
const src = (f: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), f), 'utf8');

beforeEach(() => {
  ios = [];
  Object.assign(globalThis, { IntersectionObserver: FakeIO });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('mq__inner') ? 300 : 100; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 100; } });
});
afterEach(() => {
  cleanup();
  Object.assign(globalThis, { IntersectionObserver: realIO });
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe('a scrolling name is not restarted by a redraw', () => {
  it('re-rendering with the same text (new element objects) never stops the scroll', () => {
    const tags = () => createElement('span', null, createElement('b', null, 'Hip-hop'), createElement('b', null, 'Trap'), createElement('b', null, 'Rage'));
    const { container, rerender } = render(createElement(Marquee, null, tags()));
    show(true);
    const box = container.querySelector('.mq')!;
    expect(box.classList.contains('is-moving')).toBe(true);
    const stops: string[] = [];
    const mo = new MutationObserver(() => { if (!box.classList.contains('is-moving')) stops.push(box.className); });
    mo.observe(box, { attributes: true, attributeFilter: ['class'] });
    for (let i = 0; i < 5; i++) rerender(createElement(Marquee, null, tags()));
    for (const r of mo.takeRecords()) if (!(r.target as Element).classList.contains('is-moving')) stops.push('record');
    mo.disconnect();
    expect(box.classList.contains('is-moving')).toBe(true);
    expect(stops).toEqual([]);
    expect(ios.reduce((n, io) => n + io.els.length, 0)).toBe(1); // still the one observer, never re-made
  });
});

describe('a restart while scrolling finishes the loop fast instead of jumping', () => {
  it('resting on the first letter: restart at once; part-way through: finish first', () => {
    expect(marqueeRestart(0)).toBe('now');
    expect(marqueeRestart(0.15)).toBe('now');
    expect(marqueeRestart(0.21)).toBe('finish');
    expect(marqueeRestart(0.97)).toBe('finish');
    expect(MARQUEE_FINISH_RATE).toBeGreaterThanOrEqual(3);
  });
  it('speeds the running animation up and applies the new text\'s loop when the loop comes round', () => {
    const m = src('Marquee.tsx');
    expect(m).toMatch(/playbackRate = MARQUEE_FINISH_RATE/);
    expect(m).toMatch(/animationiteration/);
  });
});

describe('tags scroll faster than song names', () => {
  it('tags at 48 px a second, names at 30', () => {
    expect(MARQUEE_SPEED).toBe(30);
    expect(TAG_MARQUEE_SPEED).toBe(48);
    expect(marqueeLoopSeconds(480, TAG_MARQUEE_SPEED)).toBeCloseTo(10 / 0.8, 5);
    expect(src('TagStrip.tsx')).toMatch(/<Marquee speed=\{TAG_MARQUEE_SPEED\}>/);
  });
});
