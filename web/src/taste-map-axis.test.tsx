// @vitest-environment happy-dom
// TASTE-MAP-AXIS-001 / TASTE-MAP-POP-001 (owner, 2026-11-19): "on the profile tab give the taste map a Y axis legend
// just like it has a legend on X for genre, the text on the Y axis should be on its side, let the user tap on cover
// arts on the taste map to see the song information in a pop up modal next to the cover art."
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TastePicker, type TrailPoint } from './TastePicker';

const src = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');
const rule = (css: string, sel: string) => { const i = css.indexOf(sel + ' {'); expect(i, sel).toBeGreaterThanOrEqual(0); return css.slice(i, css.indexOf('}', i)); };
beforeAll(() => {
  if (!window.matchMedia) Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }) });
  if (!(globalThis as { ResizeObserver?: unknown }).ResizeObserver) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
});
afterEach(cleanup);

const trail: TrailPoint[] = [
  { hue: 30, bpm: 90, label: 'Spend Dat (90 BPM)', title: 'Spend Dat', artist: 'Yung Miami', genres: ['Rap', 'Trap'], art: 'https://example.org/a.jpg', kind: 'Finished', when: 'Today 6:20 PM' },
  { hue: 200, bpm: 128, label: 'Strobe (128 BPM)', title: 'Strobe', artist: 'deadmau5', genres: ['Electronic'], art: null, kind: 'Skipped', when: 'Today 6:25 PM', radio: true },
];

describe('the taste map Y axis', () => {
  it('has a tempo legend beside the field, written on its side, with as many tempos as genre columns (TASTE-MAP-AXIS-002)', () => {
    const { container } = render(<TastePicker trail={trail} />);
    const y = container.querySelector('.tpick__yaxis')!;
    expect(y).not.toBeNull();
    expect(y.getAttribute('aria-hidden')).toBe('true');
    expect(y.querySelector('.tpick__ytitle')!.textContent).toBe('Tempo (BPM)');
    const ticks = [...y.querySelectorAll('.tpick__ytick')].map((t) => t.textContent);
    // the owner: "as many numbers as genres in the x axis" — eight families, eight tempos, top to bottom
    expect(ticks).toHaveLength(container.querySelectorAll('.tpick__fams > span').length);
    expect(ticks).toHaveLength(8);
    ticks.forEach((t) => expect(t).toMatch(/^\d+$/));
    const n = ticks.map(Number);
    n.slice(1).forEach((v, i) => expect(v).toBeLessThan(n[i]!));
    expect(n[0]).toBe(220);
    expect(n[7]).toBe(40);
    // the Y legend sits beside the field only; the genre legend sits under the field in the same column
    const plot = container.querySelector('.tpick__plot')!;
    expect(plot.querySelector(':scope > .tpick__yaxis + .tpick__area > .tpick__field')).not.toBeNull();
    expect(plot.querySelector(':scope > .tpick__area + .tpick__fams')).not.toBeNull();
  });

  it('the Y title is turned on its side and the plot is a two-column grid', () => {
    const css = src('taste-map-axis.css');
    expect(rule(css, '.tpick__ytitle')).toMatch(/writing-mode:\s*vertical-rl/);
    expect(rule(css, '.tpick__ytitle')).toMatch(/transform:\s*rotate\(180deg\)/);
    expect(rule(css, '.tpick__plot')).toMatch(/grid-template-columns:\s*auto minmax\(0, 1fr\)/);
    expect(rule(css, '.tpick__plot > .tpick__fams')).toMatch(/grid-column:\s*2/);
  });
});

describe('tapping a cover on the taste map', () => {
  it('opens a song card next to the cover and does not move the cursor', () => {
    const { container } = render(<TastePicker trail={trail} />);
    const readout = () => container.querySelector('.tpick__readout')!.textContent;
    const before = readout();
    const cover = screen.getByRole('button', { name: /Spend Dat by Yung Miami/ });
    fireEvent.pointerDown(cover);
    fireEvent.click(cover);
    const pop = screen.getByRole('dialog', { name: 'Spend Dat' });
    expect(pop.textContent).toMatch(/Yung Miami/);
    expect(pop.textContent).toMatch(/Rap, Trap/);
    expect(pop.textContent).toMatch(/90 BPM/);
    expect(pop.textContent).toMatch(/Finished · Today 6:20 PM/);
    expect(cover.getAttribute('aria-expanded')).toBe('true');
    expect(readout()).toBe(before);
    // placed by measurement (taste-pop.test.ts covers where), in the same box as the field
    expect(pop.parentElement).toBe(container.querySelector('.tpick__area'));
    expect(['right', 'left', 'below', 'above']).toContain(pop.getAttribute('data-side'));
    expect((pop as HTMLElement).style.visibility).not.toBe('hidden');
  });

  it('closes with Escape, the close button, or a tap elsewhere; another cover swaps the card', () => {
    render(<TastePicker trail={trail} />);
    fireEvent.click(screen.getByRole('button', { name: /Spend Dat/ }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Spend Dat/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close song details' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Spend Dat/ }));
    fireEvent.click(screen.getByRole('button', { name: /Strobe by deadmau5/ }));
    expect(screen.getByRole('dialog', { name: 'Strobe' }).textContent).toMatch(/Skipped · Today 6:25 PM · radio/);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Profile passes the song details to the map', () => {
    const p = src('Profile.tsx');
    expect(p).toMatch(/trail\.push\(\{ hue: at\.hue, bpm: at\.bpm, label: [^\n]*artist: s\.artist[^\n]*genres: s\.genres[^\n]*kind: PLAYED_AS\[s\.kind\] \?\? KIND_LABEL\[s\.kind\] \?\? s\.kind, when: fmtWhen\(s\.ts\), radio: s\.radio/);
  });
});

void vi;
