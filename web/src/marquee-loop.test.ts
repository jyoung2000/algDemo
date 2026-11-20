// @vitest-environment happy-dom
// MARQUEE-LOOP-001 (owner, 2026-11-20): "Ensure the marquis / scroll effect fully loops and scrolls". Cut-off song
// names and tag strips glided to the end and back, and the last letters ended under the edge fade. Now the text rests
// on its first letter, scrolls all the way through, and a second copy follows a gap behind it, so when the first copy
// has gone the second sits exactly where the first began: the loop comes round to the start with no jump.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marquee, MARQUEE_GAP, marqueeLoopSeconds } from './Marquee';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'marquee.css'), 'utf8');
let wide = 300;
beforeEach(() => {
  Object.assign(globalThis, { IntersectionObserver: undefined });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('mq__inner') ? wide : 100; } });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 100; } });
});
afterEach(() => {
  cleanup(); wide = 300;
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
  delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
});

describe('a cut-off name loops all the way round', () => {
  it('a second, hidden copy follows the text so the loop wraps with no jump', () => {
    const { container } = render(createElement(Marquee, { children: 'A very long song name' }));
    const box = container.querySelector('.mq') as HTMLElement;
    const echo = box.querySelector(':scope > .mq__echo');
    expect(echo?.textContent).toBe('A very long song name');
    expect(echo?.getAttribute('aria-hidden')).toBe('true');
    // One copy plus the gap: where the second copy starts.
    expect(box.style.getPropertyValue('--mq-loop')).toBe(`-${300 + MARQUEE_GAP}px`);
    expect(box.style.getPropertyValue('--mq-time')).toBe(`${marqueeLoopSeconds(300 + MARQUEE_GAP).toFixed(1)}s`);
  });
  it('text that fits has no copy and never moves', () => {
    wide = 90;
    const { container } = render(createElement(Marquee, { children: 'Short' }));
    expect(container.querySelector('.mq__echo')).toBeNull();
    expect(container.querySelector('.mq')!.classList.contains('is-moving')).toBe(false);
  });
  it('it travels the whole way forward and never glides back; both copies move together', () => {
    expect(css).toMatch(/@keyframes mq-loop\s*\{\s*0%,\s*\d+%\s*\{\s*transform:\s*translateX\(0\);?\s*\}\s*100%\s*\{\s*transform:\s*translateX\(var\(--mq-loop/);
    expect(css).not.toMatch(/mq-glide/);
    expect(css).toMatch(/\.mq\.is-moving \.mq__inner,\s*\.mq\.is-moving \.mq__echo\s*\{[^}]*animation:\s*mq-loop var\(--mq-time/);
    expect(css).toMatch(/\.mq__echo\s*\{[^}]*padding-left:\s*var\(--mq-gap/);
  });
  it('reads at 30 px a second plus a rest on the first letter', () => {
    expect(marqueeLoopSeconds(300)).toBeCloseTo(300 / 30 / 0.8, 5);
    expect(marqueeLoopSeconds(30)).toBeCloseTo(4 / 0.8, 5); // never a dash
  });
  it('tag strips lay the copy out like the tags', () => {
    const tags = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tag-strip.css'), 'utf8');
    expect(tags).toMatch(/\.tag-strip \.mq__inner,\s*\.tag-strip \.mq__echo \{[^}]*display: inline-flex;/);
  });
});
