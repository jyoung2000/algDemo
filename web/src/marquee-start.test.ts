// @vitest-environment happy-dom
// MARQUEE-START-001 (owner, 2026-11-19): "In the discover, radio, and saved tabs song names should start at the
// beginning before they start scrolling". A long name only scrolls while it is on screen, and every time it
// comes into view (or its text changes) it starts again from its first letter.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { Marquee } from './Marquee';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Cb = (entries: { isIntersecting: boolean; target: Element }[]) => void;
let ios: { cb: Cb; els: Element[] }[] = [];
class FakeIO { cb: Cb; els: Element[] = []; constructor(cb: Cb) { this.cb = cb; ios.push(this); } observe(el: Element) { this.els.push(el); } unobserve() {} disconnect() { this.els = []; } takeRecords() { return []; } }
const realIO = globalThis.IntersectionObserver;
const show = (on: boolean) => act(() => { for (const io of ios) io.cb(io.els.map((target) => ({ isIntersecting: on, target }))); });

beforeEach(() => {
  ios = [];
  Object.assign(globalThis, { IntersectionObserver: FakeIO });
  // happy-dom lays nothing out: make every name 300px wide in a 100px box.
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('mq__inner') ? 300 : 100; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 100; } });
});
afterEach(() => {
  cleanup();
  Object.assign(globalThis, { IntersectionObserver: realIO });
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe('a long song name', () => {
  it('does not scroll while it is off screen, and starts from its first letter when it comes into view', () => {
    const { container } = render(createElement(Marquee, { title: 'A very long song name', children: 'A very long song name' }));
    const box = container.querySelector('.mq')!;
    expect(box.classList.contains('is-moving')).toBe(false);
    expect(box.classList.contains('is-long')).toBe(true);
    show(true);
    expect(box.classList.contains('is-moving')).toBe(true);
    show(false);
    expect(box.classList.contains('is-moving')).toBe(false);
    show(true);
    expect(box.classList.contains('is-moving')).toBe(true);
  });
  it('the scroll starts with a pause on the first letter, then glides', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'marquee.css'), 'utf8');
    expect(css).toMatch(/0%,\s*\d+%\s*\{\s*transform:\s*translateX\(0\)/);
    // Not moving = sitting at the start, never part-way.
    expect(css).toMatch(/\.mq__inner\s*\{[^}]*transform:\s*translateX\(0\)/);
  });
  it('without IntersectionObserver it still scrolls (older WebViews)', () => {
    Object.assign(globalThis, { IntersectionObserver: undefined });
    const { container } = render(createElement(Marquee, { children: 'A very long song name' }));
    expect(container.querySelector('.mq')!.classList.contains('is-moving')).toBe(true);
  });
});
