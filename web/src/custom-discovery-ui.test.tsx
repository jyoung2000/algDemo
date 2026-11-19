// @vitest-environment happy-dom
// NEXT-FAV-CUSTOM-001: the Customize discovery dialog (Astra design review, 2026-11-19).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';

vi.mock('./api', () => ({
  api: {
    searchArtists: vi.fn(async () => ({ query: 'ken', artists: [
      { id: 'dz:1', provider: 'deezer', name: 'Ken Carson', picture: 'k.jpg', detail: '1,000 fans', url: '' },
      { id: 'dz:2', provider: 'deezer', name: 'Kendrick Lamar', picture: null, detail: null, url: '' },
    ] })),
  },
}));

import { CUSTOM_KEY, CustomDiscovery, customSummary, eraLabel, familyDisplay } from './CustomDiscovery';
import { normaliseCriteria } from './engine/custom-discovery';

const props = (over: Record<string, unknown> = {}) => ({
  open: true, onClose: vi.fn(), defaults: { count: 20, adventurous: 0.3 }, status: { running: false, text: '' }, onRun: vi.fn(), onStop: vi.fn(), ...over,
});
const q = (c: HTMLElement, sel: string) => c.querySelector<HTMLElement>(sel)!;
const byLabel = (c: HTMLElement, label: string) => c.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('copy and defaults', () => {
  it('names families without slashes, and says what the run will do', () => {
    expect(familyDisplay('Soul/Jazz/Funk')).toBe('Soul, Jazz & Funk');
    expect(familyDisplay('R&B/Afro/Latin')).toBe('R&B, Afro & Latin');
    expect(eraLabel(0)).toBe('Any era');
    expect(eraLabel(0.6)).toBe('Newer bias: 60%');
    expect(eraLabel(-0.25)).toBe('Older bias: 25%');
    expect(customSummary(normaliseCriteria({ count: 40 }))).toBe('Any genre \u00B7 Your taste \u00B7 40 songs');
    expect(customSummary(normaliseCriteria({ genres: ['sub:trap', 'sub:rage'], artists: [{ name: 'A' }], count: 1 }))).toBe('2 genre tags \u00B7 1 artist \u00B7 1 song');
  });
  it('opens with Settings\u2019 song count and Discover\u2019s Familiar/Adventurous, three sections, one primary action', () => {
    const { container } = render(createElement(CustomDiscovery, props()));
    expect(q(container, '[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    expect([...container.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Genres', 'Artists', 'Discovery settings']);
    expect(byLabel(container, 'Number of songs').value).toBe('20');
    expect(byLabel(container, 'Familiar or adventurous').value).toBe('30');
    expect(q(container, '.cdisc__go').textContent).toBe('Find 20 songs');
    expect(container.textContent).toContain('Any era');
  });
});

describe('genres', () => {
  it('a whole family replaces its chosen subgenres and shows its subgenres ticked and locked', () => {
    const onRun = vi.fn();
    const { container } = render(createElement(CustomDiscovery, props({ onRun })));
    fireEvent.click(byLabel(container, 'Expand Hip-hop'));
    const trap = [...container.querySelectorAll<HTMLLabelElement>('.cdisc__check--sub')].find((l) => l.textContent === 'Trap')!;
    fireEvent.click(trap.querySelector('input')!);
    expect(q(container, '.cdisc__chips').textContent).toContain('Trap');
    fireEvent.click(byLabel(container, 'Select entire family Hip-hop'));
    const subInputs = [...container.querySelectorAll<HTMLInputElement>('.cdisc__check--sub input')];
    expect(subInputs.every((i) => i.checked && i.disabled)).toBe(true);
    fireEvent.click(q(container, '.cdisc__go'));
    expect(onRun.mock.calls[0]![0].genres).toEqual(['family:hip-hop']);
  });
  it('search narrows the families to matching subgenres, and says when nothing matches', () => {
    const { container } = render(createElement(CustomDiscovery, props()));
    fireEvent.change(byLabel(container, 'Search genres or subgenres'), { target: { value: 'drill' } });
    const names = [...container.querySelectorAll('.cdisc__check--sub .gchip')].map((n) => n.textContent);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => /drill/i.test(n!))).toBe(true);
    fireEvent.change(byLabel(container, 'Search genres or subgenres'), { target: { value: 'zzzz' } });
    expect(container.textContent).toContain('No matching genres.');
  });
});

describe('artists', () => {
  it('search, add with Own songs and Features on, keep at least one option, and remember it all', async () => {
    vi.useFakeTimers();
    const onRun = vi.fn();
    const { container } = render(createElement(CustomDiscovery, props({ onRun })));
    fireEvent.change(byLabel(container, 'Search artists'), { target: { value: 'ken' } });
    await act(async () => { vi.advanceTimersByTime(320); });
    vi.useRealTimers();
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(byLabel(container, 'Add Ken Carson'));
    expect(byLabel(container, 'Ken Carson added').disabled).toBe(true);
    const opts = () => [...container.querySelectorAll<HTMLLabelElement>('.cdisc__opt')];
    expect(opts().map((o) => [o.textContent, o.querySelector('input')!.checked])).toEqual([
      ['Own songs', true], ['Features', true], ['Frequent collaborators', false], ['Similar artists', false],
    ]);
    fireEvent.click(opts()[0]!.querySelector('input')!);
    fireEvent.click(opts()[1]!.querySelector('input')!);
    expect(container.textContent).toContain('Keep at least one option, or remove this artist.');
    expect(opts()[1]!.querySelector('input')!.checked).toBe(true);
    fireEvent.click(opts()[3]!.querySelector('input')!);
    fireEvent.click(q(container, '.cdisc__go'));
    expect(onRun.mock.calls[0]![0].artists).toEqual([{ id: 'dz:1', name: 'Ken Carson', own: false, features: true, collaborators: false, similar: true }]);
    expect(JSON.parse(window.localStorage.getItem(CUSTOM_KEY)!).artists[0].name).toBe('Ken Carson');
  });
});

describe('artist search that could not run', () => {
  it('says the allowance is used up instead of "No artists found"', async () => {
    const { api } = await import('./api');
    vi.mocked(api.searchArtists).mockResolvedValueOnce({ query: 'ken', artists: [], why: 'allowance' } as never);
    vi.useFakeTimers();
    const { container } = render(createElement(CustomDiscovery, props()));
    fireEvent.change(byLabel(container, 'Search artists'), { target: { value: 'ken' } });
    await act(async () => { vi.advanceTimersByTime(320); });
    vi.useRealTimers();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain('Today’s download allowance is used up, so artists cannot be searched. Raise it in Settings.');
    expect(container.textContent).not.toContain('No artists found');
  });
});

describe('sliders and running', () => {
  it('era snaps to Any era near the centre; while running the choices freeze and the action is Stop', () => {
    const onStop = vi.fn();
    const { container, rerender } = render(createElement(CustomDiscovery, props({ onStop })));
    fireEvent.change(byLabel(container, 'Release era'), { target: { value: '70' } });
    expect(container.textContent).toContain('Newer bias: 70%');
    fireEvent.change(byLabel(container, 'Release era'), { target: { value: '3' } });
    expect(byLabel(container, 'Release era').getAttribute('aria-valuetext')).toBe('Any era');
    fireEvent.change(byLabel(container, 'Number of songs'), { target: { value: '100' } });
    expect(q(container, '.cdisc__go').textContent).toBe('Find 100 songs');
    rerender(createElement(CustomDiscovery, props({ onStop, status: { running: true, text: 'Searching every platform for Trap\u2026' } })));
    expect((container.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(q(container, '.cdisc__summary').textContent).toContain('Searching every platform for Trap');
    fireEvent.click(q(container, '.cdisc__go'));
    expect(onStop).toHaveBeenCalled();
  });
  it('Escape and the close button close it', () => {
    const onClose = vi.fn();
    const { container } = render(createElement(CustomDiscovery, props({ onClose })));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(byLabel(container, 'Close custom discovery'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
