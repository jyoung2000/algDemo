// @vitest-environment happy-dom
// TASTE-SPIN-001 (owner, 2026-11-19): "replace the black dot with a grey semi circle arrow that spins as you listen
// to music and spins slightly faster when new songs are added". The dot was the 12px info glyph before the
// "Learned from N songs you played" line.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasteSpinner, SPIN_FAST_MS } from './TasteSpinner';

const src = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');
const rule = (css: string, sel: string) => { const i = css.indexOf(sel + ' {'); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i, css.indexOf('}', i)); };
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('the taste line spinner', () => {
  it('is a grey half-circle arrow, decorative only', () => {
    const { container } = render(<TasteSpinner playing={false} songs={3} />);
    const svg = container.querySelector('svg.taste-spin')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('path.taste-spin__arc')).not.toBeNull();
    expect(svg.querySelector('path.taste-spin__head')).not.toBeNull();
  });

  it('spins only while music plays', () => {
    const { container, rerender } = render(<TasteSpinner playing={false} songs={3} />);
    const svg = () => container.querySelector('svg.taste-spin')!;
    expect(svg().classList.contains('is-on')).toBe(false);
    rerender(<TasteSpinner playing songs={3} />);
    expect(svg().classList.contains('is-on')).toBe(true);
  });

  it('spins faster for a moment when songs are added, then settles', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<TasteSpinner playing songs={3} />);
    const svg = () => container.querySelector('svg.taste-spin')!;
    expect(svg().classList.contains('is-fast')).toBe(false);
    rerender(<TasteSpinner playing songs={5} />);
    expect(svg().classList.contains('is-fast')).toBe(true);
    act(() => { vi.advanceTimersByTime(SPIN_FAST_MS + 50); });
    expect(svg().classList.contains('is-fast')).toBe(false);
    rerender(<TasteSpinner playing songs={4} />); // a removal is not an addition
    expect(svg().classList.contains('is-fast')).toBe(false);
  });

  it('grey, a steady turn, a slightly quicker one, and still for reduced motion', () => {
    const css = src('taste-spinner.css');
    expect(rule(css, '.taste-spin')).toMatch(/color:\s*var\(--ink-3\)/);
    const on = rule(css, '.taste-spin.is-on'), fast = rule(css, '.taste-spin.is-on.is-fast');
    const sec = (r: string) => Number(/animation-duration:\s*([\d.]+)s/.exec(r)![1]);
    expect(sec(fast)).toBeLessThan(sec(on));
    expect(sec(fast)).toBeGreaterThan(sec(on) / 2); // slightly faster, not frantic
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.taste-spin(\.is-on)? \{\s*animation: none/);
  });

  it('replaces the info dot on the taste line; it follows the player and the queue size', () => {
    const app = src('App.tsx');
    const line = app.slice(app.indexOf('<p className="note note--taste"'), app.indexOf('{tasteLine}'));
    expect(line).toMatch(/<TasteSpinner playing=\{songPlaying\} songs=\{queueSongCount\} \/>/);
    expect(line).not.toMatch(/Glyph name="info"/);
    expect(app).toMatch(/onPausedChange=\{\(p\) => setSongPlaying\(!p\)\}/);
    const player = src('Player.tsx');
    expect(player).toMatch(/onPausedChange\?: \(paused: boolean\) => void/);
    expect(player).toMatch(/useEffect\(\(\) => \{ onPausedChange\?\.\(paused\); \}, \[paused\]\)/);
  });
});
