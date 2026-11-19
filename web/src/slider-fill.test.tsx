// @vitest-environment happy-dom
// SLIDER-FILL-001 (owner, 2026-11-19: "ensure the sliders and the blue bars update appropriately"): every
// slider's blue fill (--pct) sits where its thumb is, and moves when the value changes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SettingsView } from './Settings';

vi.mock('./api', async () => ({ api: { health: () => new Promise(() => {}), status: () => new Promise(() => {}), settings: () => Promise.resolve({}) } }));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
vi.mock('./RankingFormulaSettings', () => ({ RankingFormulaSettings: () => null }));
afterEach(cleanup);

const base = { fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false };
const noop = () => {};
function fills(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLInputElement>('input[type="range"]')].map((el) => {
    const min = Number(el.min || 0); const max = Number(el.max || 100);
    const want = ((Number(el.value) - min) / (max - min)) * 100;
    const got = parseFloat(el.style.getPropertyValue('--pct'));
    return { id: el.id || el.getAttribute('aria-label') || el.className, want: Math.round(want * 10) / 10, got: Math.round(got * 10) / 10 };
  });
}

describe('slider fills follow their values', () => {
  it('every Settings slider draws its blue fill at its value', () => {
    const { container } = render(<SettingsView settings={{ ...base, similar_percent: 72 }} onSettings={noop} onReset={noop} onResetTaste={noop} />);
    const all = fills(container);
    expect(all.length).toBeGreaterThan(2);
    for (const f of all) expect(f, f.id).toEqual({ ...f, got: f.want });
  });
  it('the minimum sound match fill moves with the value', () => {
    const { container, rerender } = render(<SettingsView settings={{ ...base, similar_percent: 72 }} onSettings={noop} onReset={noop} onResetTaste={noop} />);
    const slider = container.querySelector<HTMLInputElement>('#similar-percent')!;
    expect(slider.style.getPropertyValue('--pct')).toBe(`${((72 - 40) / 55) * 100}%`);
    rerender(<SettingsView settings={{ ...base, similar_percent: 95 }} onSettings={noop} onReset={noop} onResetTaste={noop} />);
    expect(slider.style.getPropertyValue('--pct')).toBe('100%');
  });
});
