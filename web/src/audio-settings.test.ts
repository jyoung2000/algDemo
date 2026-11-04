// @vitest-environment happy-dom
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AudioSettings } from './AudioSettings';
import { SettingsView } from './Settings';
import type { Settings } from './api';
import { EQ_BANDS_HZ, EQ_DEFAULTS, EQ_PRESETS, SOLFEGGIO, applyPreset, headroomTrimDb } from './engine/eq';
import { MIX_LABELS } from './engine/crossfade';

// The stylesheet is read from disk: a `?raw` import of a CSS file is processed, not returned verbatim.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'audio-settings.css'), 'utf8');

vi.mock('./api', () => ({ api: { health: () => new Promise(() => {}), status: () => new Promise(() => {}) } }));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
afterEach(cleanup);
const saved: Settings = { fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false };
const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement;
const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const panel = (settings: Settings | null = saved, onSettings = vi.fn()) => createElement(AudioSettings, { settings, onSettings });

describe('the equalizer rail on a phone (EQ-RAIL-002)', () => {
  // Observed at 412px: the rail holds 507px of faders in a 361px box, so the last band is cut
  // through the middle. It did scroll (a real swipe on the emulator moved it 146px and brought the
  // last band into reach), but nothing said so — a cut fader reads as a broken layout.
  it('shows a scrollbar on the rail instead of an invisible overlay one', () => {
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*?\.eqr::-webkit-scrollbar \{[^}]*height:/);
    expect(css).toMatch(/\.eqr::-webkit-scrollbar-thumb \{[^}]*background:/);
  });

  it('fades the edge the faders run under, so the cut band reads as more to come', () => {
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*?\.eqr \{[^}]*mask-image: linear-gradient/);
  });

  it('says in words that the rail slides, and only where it has to', () => {
    render(panel({ ...saved, eq: { ...EQ_DEFAULTS, on: true } }));
    const hint = screen.getByText(/slide the faders sideways/i);
    expect(hint.className).toContain('eqr__hint');
    // Hidden by default; shown only at the widths where the rail cannot fit — and the base rule has
    // to come FIRST, or it wins the cascade on equal specificity and the hint never appears (it
    // did not, at 412px, while both rules were present).
    const hidden = css.indexOf('.eqr__hint {');
    const narrow = css.search(/@media \(max-width: 560px\)/);
    expect(hidden).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(-1);
    expect(hidden).toBeLessThan(narrow);
    expect(css.slice(hidden, hidden + 120)).toMatch(/display: none;/);
    expect(css).toMatch(/@media \(max-width: 560px\)[\s\S]*?\.eqr__hint \{[^}]*display: block;/);
  });
});

describe('the solfeggio tones in the Audio panel (SOLFEGGIO-001)', () => {
  const groupNames = () => [...(screen.getByLabelText('EQ preset') as HTMLSelectElement).querySelectorAll('optgroup')].map((g) => g.label);

  it('keeps the nine tones in a group of their own, apart from the voicings', () => {
    // A flat list of thirty presets buries them, and a listener looking for 528 Hz is not looking
    // for a voicing. Two groups, each whole: no preset is dropped from the picker.
    render(panel());
    expect(groupNames()).toEqual(['Voicing', 'Solfeggio tones']);
    const options = [...(screen.getByLabelText('EQ preset') as HTMLSelectElement).options].map((o) => o.value);
    for (const p of EQ_PRESETS) expect(options, p.id).toContain(p.id);
    for (const t of SOLFEGGIO) {
      const option = [...(screen.getByLabelText('EQ preset') as HTMLSelectElement).options].find((o) => o.value === `solfeggio-${t.hz}`)!;
      expect(option, `${t.hz} Hz`).toBeTruthy();
      expect(option.text).toContain(`${t.hz} Hz`);
      expect(option.closest('optgroup')?.label).toBe('Solfeggio tones');
    }
  });

  it('chooses a tone by name and saves it as the frequency to lift', () => {
    const onSettings = vi.fn();
    render(panel({ ...saved, eq: { ...EQ_DEFAULTS, on: true } }, onSettings));
    fireEvent.change(screen.getByLabelText('EQ preset'), { target: { value: 'solfeggio-528' } });
    const patch = onSettings.mock.calls.at(-1)?.[0] as { eq: { toneHz: number | null; presetId: string } };
    expect(patch.eq.toneHz).toBe(528);
    expect(patch.eq.presetId).toBe('solfeggio-528');
  });

  it('says in hertz what is being lifted, and why the faders cannot do it', () => {
    render(panel({ ...saved, eq: applyPreset({ ...EQ_DEFAULTS, on: true }, 'solfeggio-528') }));
    const note = screen.getByText(/528 Hz is lifted/);
    expect(note.textContent).toMatch(/narrow filter at that exact/);
    expect(note.textContent).toContain('500 Hz'); // the nearest fader, which is not 528
  });

  it('says nothing about a tone when none is chosen', () => {
    render(panel({ ...saved, eq: applyPreset({ ...EQ_DEFAULTS, on: true }, 'rock') }));
    expect(screen.queryByText(/Hz is lifted/)).toBeNull();
  });
});

describe('Audio settings — MIXER-001 and EQ-001', () => {
  it('integrates in Settings without changing unrelated preferences', () => {
    render(createElement(SettingsView, { settings: saved, onSettings: vi.fn(), onReset: vi.fn(), onResetTaste: vi.fn() }));
    expect(screen.getByRole('region', { name: 'Audio' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'New songs per discovery' })).toBeTruthy();
    expect(screen.getByLabelText('Choose history file')).toBeTruthy();
  });

  it('defaults safely without writing on mount, then reflects saved settings', () => {
    const onSettings = vi.fn();
    const { rerender } = render(panel(null, onSettings));
    expect([slider('Blend length').min, slider('Blend length').max, slider('Blend length').step, slider('Blend length').value]).toEqual(['0', '100', '1', '0']);
    expect(checkbox('Equalizer on').checked).toBe(false);
    expect(checkbox('Safety limiter').checked).toBe(true);
    rerender(panel({ ...saved, mix: 67, eq: { ...EQ_DEFAULTS, on: true, preampDb: -3 } }, onSettings));
    expect(slider('Blend length').value).toBe('67');
    expect(slider('Preamp').value).toBe('-3');
    expect(checkbox('Equalizer on').checked).toBe(true);
    expect(onSettings).not.toHaveBeenCalled();
  });

  it.each([1, 24, 25, 26, 49, 50, 51, 74, 75, 76, 99, 100, 0])('saves granular mix %i immediately and only patches mix', (mix) => {
    const onSettings = vi.fn();
    render(panel({ ...saved, mix: mix === 0 ? 37 : 0 }, onSettings));
    fireEvent.change(slider('Blend length'), { target: { value: String(mix) } });
    expect(onSettings).toHaveBeenCalledExactlyOnceWith({ mix });
  });

  it('provides five plain labels, a linked readout and truthful playback limitations', () => {
    render(panel({ ...saved, mix: 100 }));
    const section = screen.getByRole('region', { name: 'Crossfader' });
    // Blend length, and (MIXER-PLAY-THROUGH-002) how much of a song plays before it starts.
    expect(within(section).getAllByRole('slider').map((s) => s.getAttribute('aria-label') ?? s.id.split('-').pop())).toEqual(['mix', 'pt']);
    for (const label of MIX_LABELS) expect(within(section).getByText(label, { exact: true })).toBeTruthy();
    expect(slider('Blend length').getAttribute('aria-valuetext')).toBe('100 — Long & Creative');
    const ids = slider('Blend length').getAttribute('aria-describedby')!.split(' ');
    const readout = document.getElementById(ids[0]!)!;
    expect(readout.tagName).toBe('OUTPUT');
    expect(readout.getAttribute('for')).toBe(slider('Blend length').id);
    const text = section.textContent!;
    // The owner's rule: the full song always plays. The mixer never trades it for a preview; it
    // reaches full songs by downloading them (LOCAL-AUDIO-001) and says so.
    expect(text).not.toMatch(/selects 30-second previews/);
    expect(text).toMatch(/full song/i);
    expect(text).toMatch(/download/i);
    // MIXER-PLAY-THROUGH-001: the panel tells the listener the blend is a tail, never a cut.
    expect(text).toMatch(/95%/); // the default, named in the help
    expect(text).toMatch(/bass handoff/);
    expect(text).toMatch(/filter/);
    expect(text).toMatch(/without reliable beat grids/i);
    expect(text).toMatch(/not beatmatching/i);
  });

  it('uses all ten engine bands and all engine presets', () => {
    render(panel());
    const bands = screen.getByRole('group', { name: 'Frequency bands' });
    expect(within(bands).getAllByRole('slider')).toHaveLength(10);
    for (const hz of EQ_BANDS_HZ) {
      const input = slider(`${hz} Hz`);
      expect([input.min, input.max, input.step, input.value]).toEqual(['-12', '12', '0.5', '0']);
    }
    const select = screen.getByRole('combobox', { name: 'EQ preset' });
    for (const preset of EQ_PRESETS) expect(within(select).getByRole('option', { name: preset.name })).toBeTruthy();
  });

  it('lays the bands out as a graphic equalizer: one rail of vertical faders, side by side', () => {
    // The owner's screenshot showed ten horizontal sliders in two columns, which reads as a form,
    // not an equalizer. The suite's own equalizer (music-player Equalizer.tsx, after the iTunes
    // window) is the reference: a dB scale, a preamp fader, then the ten bands as vertical faders
    // in one row, short labels in the EQ convention ("1K"), the full frequency as the accessible name.
    render(panel());
    const bank = screen.getByRole('group', { name: 'Frequency bands' });
    const rails = within(bank).getAllByRole('slider');
    expect(rails).toHaveLength(10);
    for (const input of rails) expect(input.getAttribute('aria-orientation')).toBe('vertical');
    // Order is low to high, left to right, as on every graphic equalizer.
    expect(rails.map((r) => r.getAttribute('aria-label'))).toEqual(EQ_BANDS_HZ.map((hz) => `${hz} Hz`));
    // Visible labels use the short form.
    const labels = [...bank.querySelectorAll('.eqr__label')].map((l) => l.textContent?.trim());
    expect(labels).toEqual(['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K']);
    // The preamp is its own vertical fader beside the bands, not a horizontal slider underneath.
    expect(slider('Preamp').getAttribute('aria-orientation')).toBe('vertical');
    // One row: the bank is a horizontal flex container and nothing stacks it into columns.
    expect(css).toMatch(/\.eqr\s*\{[^}]*display:\s*flex/);
    expect(css).not.toMatch(/\.audio-settings__band-grid/);
    // The rail keeps the 44px target while reading as vertical: the horizontal input is rotated.
    expect(css).toMatch(/\.eqr__rail input\s*\{[^}]*rotate\(-90deg\)/);
    expect(css).toMatch(/\.eqr__rail input\s*\{[^}]*height:\s*44px/);
    // A dB scale sits beside the rails so the eye has a reference for 0.
    expect(bank.closest('.eqr')?.querySelector('.eqr__scale')?.textContent).toMatch(/\+12.*0.*[−-]12/s);
  });

  it('offers a "Play before blending" slider, 95% by default, saved as play_through (MIXER-PLAY-THROUGH-002)', () => {
    const onSettings = vi.fn();
    render(panel({ ...saved, mix: 100 }, onSettings));
    const s = slider('Play before blending');
    expect(s.min).toBe('50');
    expect(s.max).toBe('100');
    expect(s.value).toBe('95');
    expect(s.getAttribute('aria-valuetext')).toBe('95% of each song');
    const ids = s.getAttribute('aria-describedby')!.split(' ');
    expect(document.getElementById(ids[0]!)!.tagName).toBe('OUTPUT');
    const help = ids.map((i) => document.getElementById(i)?.textContent ?? '').join(' ');
    expect(help).toMatch(/before the next one/i);
    expect(help).toMatch(/100%/);
    fireEvent.change(s, { target: { value: '80' } });
    expect(onSettings).toHaveBeenCalledWith({ play_through: 80 });
    cleanup();
    render(panel({ ...saved, play_through: 70 }, vi.fn()));
    expect(slider('Play before blending').value).toBe('70');
    expect(slider('Play before blending').getAttribute('aria-valuetext')).toBe('70% of each song');
  });

  it('explains mandatory local full-song playback and never offers an iframe fallback switch', () => {
    render(panel({ ...saved, local_mix: false }, vi.fn()));
    expect(screen.queryByLabelText(/Download full songs/i)).toBeNull();
    expect(screen.getByText(/Listening waits for the file instead of starting an iframe/i)).toBeTruthy();
  });

  it('preserves complete EQ state when toggling on or limiter', () => {
    const eq = { ...applyPreset(EQ_DEFAULTS, 'rock'), preampDb: -2 };
    const onSettings = vi.fn();
    render(panel({ ...saved, eq }, onSettings));
    fireEvent.click(checkbox('Equalizer on'));
    expect(onSettings).toHaveBeenLastCalledWith({ eq: { ...eq, on: true } });
    fireEvent.click(checkbox('Safety limiter'));
    expect(onSettings).toHaveBeenLastCalledWith({ eq: { ...eq, limiter: false } });
  });

  it('applies presets with engine logic, without enabling EQ or changing limiter', () => {
    const eq = { ...EQ_DEFAULTS, limiter: false, preampDb: -4 };
    const onSettings = vi.fn();
    render(panel({ ...saved, eq }, onSettings));
    fireEvent.change(screen.getByRole('combobox', { name: 'EQ preset' }), { target: { value: 'bass-booster' } });
    expect(onSettings).toHaveBeenCalledExactlyOnceWith({ eq: applyPreset(eq, 'bass-booster') });
  });

  it('changes only one gain and marks the preset Custom without mutating saved values', () => {
    const eq = applyPreset(EQ_DEFAULTS, 'rock');
    const original = [...eq.gains];
    const onSettings = vi.fn();
    const { rerender } = render(panel({ ...saved, eq }, onSettings));
    fireEvent.change(slider('125 Hz'), { target: { value: '-2.5' } });
    const gains = [...eq.gains];
    gains[2] = -2.5;
    const next = { ...eq, presetId: 'custom', gains };
    expect(onSettings).toHaveBeenCalledExactlyOnceWith({ eq: next });
    expect(eq.gains).toEqual(original);
    rerender(panel({ ...saved, eq: next }, onSettings));
    expect((screen.getByRole('combobox', { name: 'EQ preset' }) as HTMLSelectElement).value).toBe('custom');
  });

  it('changes preamp independently and shows the engine headroom trim only when EQ is on', () => {
    const eq = { ...applyPreset(EQ_DEFAULTS, 'bass-booster'), on: true };
    const onSettings = vi.fn();
    const { rerender } = render(panel({ ...saved, eq }, onSettings));
    expect(screen.getByText(`Headroom trim: ${headroomTrimDb(eq).toFixed(1)} dB`)).toBeTruthy();
    fireEvent.change(slider('Preamp'), { target: { value: '-6.5' } });
    expect(onSettings).toHaveBeenLastCalledWith({ eq: { ...eq, presetId: 'custom', preampDb: -6.5 } });
    rerender(panel({ ...saved, eq: { ...eq, on: false } }, onSettings));
    expect(screen.getByText('Headroom trim: 0.0 dB')).toBeTruthy();
  });

  it('normalizes corrupt stored values without overwriting storage on mount', () => {
    const onSettings = vi.fn();
    render(panel({ ...saved, mix: 999, eq: { ...EQ_DEFAULTS, gains: [99], preampDb: -99 } }, onSettings));
    expect(slider('Blend length').value).toBe('100');
    expect(slider('32 Hz').value).toBe('12');
    expect(slider('64 Hz').value).toBe('0');
    expect(slider('Preamp').value).toBe('-12');
    expect(onSettings).not.toHaveBeenCalled();
  });

  it('keeps Aqua checkbox art, scoped 44px targets and visible focus — UX-TOUCH-001 / UX-FOCUS-001', () => {
    const { container } = render(panel());
    for (const input of container.querySelectorAll('.chk input')) expect(input.nextElementSibling?.classList.contains('box')).toBe(true);
    // Every slider has an in-flow 44px target: the crossfader on its .dial, each fader on its rail.
    for (const input of screen.getAllByRole('slider')) expect(input.closest('.dial') ?? input.closest('.eqr__rail')).toBeTruthy();
    expect(css).toMatch(/\.audio-settings__range input\s*\{[^}]*height: 44px;/);
    expect(css).toMatch(/\.audio-settings__toggle\s*\{[^}]*min-height: 44px;/);
    expect(css).toMatch(/\.audio-settings__preset\s*\{[^}]*min-height: 44px;/);
    expect(css).toContain('minmax(0, 1fr)');
    expect(css).toContain('min-width: 0');
    expect(css).toMatch(/:focus-visible[^}]*outline:/);
  });
});
