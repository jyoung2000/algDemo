// @vitest-environment happy-dom
// CUSTOM-INPUTS-001 (owner, 2026-11-20): "On the artist search on mobile the keyboard instantly closes and I can't search
// by artist, ensure all the customize setting inputs work on all platforms". Cause: the dialog's focus effect listed the
// artist search text (and the parent's onClose) as dependencies, so every letter — and any redraw of the page behind —
// ran its clean-up (focus back to the opener) and set-up (focus to Close): the field lost focus and the phone keyboard
// closed. Focus now moves only when the dialog opens and closes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';

vi.mock('./api', () => ({
  api: { searchArtists: vi.fn(async () => ({ query: 'ke', artists: [{ id: 'dz:1', provider: 'deezer', name: 'Ken Carson', picture: null, detail: null, url: '' }] })) },
}));
import { CustomDiscovery } from './CustomDiscovery';

const props = (over: Record<string, unknown> = {}) => ({
  open: true, onClose: vi.fn(), defaults: { count: 20, adventurous: 0.3 }, status: { running: false, text: '' }, onRun: vi.fn(), onStop: vi.fn(), ...over,
});
const byLabel = (c: HTMLElement, label: string) => c.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
beforeEach(() => { window.localStorage.clear(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Customize inputs keep focus while used', () => {
  it('typing in the artist search keeps the field focused, through the results arriving', async () => {
    const { container } = render(createElement(CustomDiscovery, props()));
    const input = byLabel(container, 'Search artists');
    input.focus();
    for (const v of ['k', 'ke', 'ken']) {
      fireEvent.change(input, { target: { value: v } });
      expect(document.activeElement).toBe(input);
    }
    await act(async () => { vi.advanceTimersByTime(400); await Promise.resolve(); });
    expect(container.textContent).toContain('Ken Carson');
    expect(document.activeElement).toBe(input);
  });
  it('a redraw of the page behind (a new onClose each time) never takes focus from any input', () => {
    const { container, rerender } = render(createElement(CustomDiscovery, props()));
    for (const label of ['Search genres or subgenres', 'Search artists', 'Number of songs', 'Familiar or adventurous', 'Release era']) {
      const el = byLabel(container, label);
      el.focus();
      rerender(createElement(CustomDiscovery, props()));
      rerender(createElement(CustomDiscovery, props({ status: { running: false, text: 'Ready' } })));
      expect(document.activeElement, label).toBe(el);
    }
  });
  it('Escape still clears an artist search first, then closes; focus still goes to Close on open', () => {
    const p = props();
    const { container } = render(createElement(CustomDiscovery, p));
    expect(document.activeElement?.className).toContain('cdisc__close');
    const input = byLabel(container, 'Search artists');
    input.focus();
    fireEvent.change(input, { target: { value: 'ken' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
