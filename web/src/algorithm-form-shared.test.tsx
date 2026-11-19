// @vitest-environment happy-dom
/**
 * ALGO-FORM-001 (owner, 2026-11-18: "consistent ui and consistent algorithm forms so if it changes 1
 * place it changes on the other places"). The Profile's algorithm card, the Profile's Recommendation
 * formula card and Settings' Discovery algorithm are one form over one algorithm and one unsaved
 * draft. Backed by a real LocalApi, so what is saved is what the engine accepted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BUILT_IN_ALGORITHM, PARAM_FIELDS, createFrom, type Algorithm } from './engine/algorithms';

const h = vi.hoisted(() => ({ local: null as null | { handle: (m: string, p: string, b?: Record<string, unknown> | null) => Promise<{ status: number; body: unknown }> } }));
const call = async (m: string, p: string, b?: unknown) => {
  const r = await h.local!.handle(m, p, b as Record<string, unknown> | undefined);
  if (r.status >= 400) throw new Error(String((r.body as { detail?: string }).detail ?? r.status));
  return r.body;
};
vi.mock('./api', () => ({
  api: {
    settings: () => call('GET', '/api/settings'),
    putSettings: (patch: unknown) => call('PUT', '/api/settings', patch),
    profile: () => call('GET', '/api/profile'),
    health: () => new Promise(() => {}),
    status: () => new Promise(() => {}),
  },
}));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));

import { LocalApi } from './engine/local-api';
import { MemoryBackend, Store } from './engine/store';
import type { HttpPort } from './engine/net';
import { ProfileView } from './Profile';
import { SettingsView } from './Settings';
import { clearAlgorithmDrafts } from './useAlgorithmDraft';
import type { Settings } from './api';

const port = { request: async () => { throw new Error('UI tests must not contact providers'); } } as HttpPort;
const saved: Settings = { fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false };
let store: Store;
const mine: Algorithm = createFrom(BUILT_IN_ALGORITHM, 'Mine', 'user-mine');
async function boot(active = 'user-mine') {
  store = await Store.open(new MemoryBackend());
  await store.put('settings', { ...saved, algorithms: [mine], active_algorithm: active });
  h.local = new LocalApi({ store, port, encoder: null });
}
const stored = () => (store.get<Record<string, unknown>>('settings') ?? {}) as { algorithms?: Algorithm[]; active_algorithm?: string };

const onProfile = () => screen.getByRole('region', { name: 'Recommendation algorithm' });
const inSettings = () => screen.getByRole('region', { name: 'Discovery algorithm' });
const lower = () => screen.getByRole('region', { name: 'Recommendation formula' });
const forms = () => [onProfile(), inSettings()];
const pre = (el: HTMLElement) => el.querySelector('pre.formula')!.textContent;
const rowHeads = (el: HTMLElement) => [...el.querySelector('table.algo__table')!.querySelectorAll('tbody th[scope="row"]')].map((x) => x.textContent);
const colHeads = (el: HTMLElement) => [...el.querySelector('table.algo__table')!.querySelectorAll('thead th')].map((x) => x.textContent);
const meanings = (el: HTMLElement) => [...el.querySelector('table.algo__table')!.querySelectorAll('tbody tr')].map((r) => r.lastElementChild!.textContent);

async function renderBoth() {
  const fresh = (await call('GET', '/api/settings')) as Settings;
  render(<><ProfileView /><SettingsView settings={fresh} onSettings={vi.fn()} onReset={vi.fn()} onResetTaste={vi.fn()} /></>);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your profile', level: 2 })).toBeTruthy());
  await waitFor(() => expect((within(onProfile()).getByRole('combobox', { name: 'Algorithm' }) as HTMLSelectElement).disabled).toBe(false));
}

beforeEach(async () => { clearAlgorithmDrafts(); await boot(); });
afterEach(cleanup);

describe('one algorithm form in every place', () => {
  it('draws the same controls on Profile and in Settings', async () => {
    await renderBoth();
    const controls = (el: HTMLElement) => ({
      select: [...(within(el).getByRole('combobox', { name: 'Algorithm' }) as HTMLSelectElement).options].map((o) => o.textContent),
      toolbar: [...el.querySelectorAll('.algo__toolbar > .algo__buttons > button')].map((b) => `${b.textContent}|${b.className}`),
      columns: colHeads(el), rows: rowHeads(el), meanings: meanings(el),
      values: within(el).getAllByRole('spinbutton').map((i) => `${i.getAttribute('aria-label')}=${(i as HTMLInputElement).value}`),
      final: (within(el).getByRole('textbox', { name: 'Discovery ranking formula' }) as HTMLTextAreaElement).value,
      finalButtons: ['Save formula', 'Copy formula', 'Paste formula', 'Use default formula'].map((n) => within(el).getByRole('button', { name: n }).className),
      formula: pre(el),
      notes: [...el.querySelectorAll('.algo__notes li')].map((li) => li.textContent),
      subheads: [...el.querySelectorAll('.algo__subhead')].map((x) => x.textContent),
    });
    const [a, b] = forms().map(controls);
    expect(b).toEqual(a);
    expect(a!.toolbar.map((t) => t.split('|')[0])).toEqual(['Create', 'Reset', 'Import', 'Export']);
    expect(a!.rows).toEqual(PARAM_FIELDS.map((f) => f.label));
    expect(a!.columns).toEqual(['Parameter', 'Value', 'Meaning']);
  });

  it('writes the lower Recommendation formula card from the same rows, labels and meanings', async () => {
    await renderBoth();
    expect(rowHeads(lower())).toEqual([...PARAM_FIELDS.map((f) => f.label), 'Final step']);
    expect(colHeads(lower())).toEqual(['Parameter', 'Value', 'Now', 'Meaning']);
    expect(meanings(lower()).slice(0, PARAM_FIELDS.length)).toEqual(meanings(onProfile()));
    expect(within(lower()).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(pre(lower())).toBe(pre(onProfile()));
  });

  it('shows a value typed in one place in every other place before it is saved, and Cancel anywhere clears it everywhere', async () => {
    await renderBoth();
    const sound = (el: HTMLElement) => within(el).getByRole('spinbutton', { name: 'Sound (seed fit)' }) as HTMLInputElement;
    fireEvent.change(sound(onProfile()), { target: { value: '0.5' } });
    expect(sound(inSettings()).value).toBe('0.5');
    for (const el of [...forms(), lower()]) expect(pre(el)).toContain('[0.5·audio');
    for (const el of forms()) expect(within(el).getByRole('heading', { name: 'Formula (unsaved changes)' })).toBeTruthy();
    expect(within(lower()).getByText(/unsaved changes/i)).toBeTruthy();
    expect(lower().querySelector('tbody tr')!.children[1]!.textContent).toBe('0.5');
    expect(stored().algorithms![0]!.params.seedWeights.audio).toBe(0.35);

    fireEvent.click(within(inSettings()).getByRole('button', { name: 'Cancel' }));
    expect(sound(onProfile()).value).toBe('0.35');
    for (const el of [...forms(), lower()]) expect(pre(el)).toContain('[0.35·audio');
    expect(within(lower()).queryByText(/unsaved changes/i)).toBeNull();
  });

  it('saves from Settings what was typed on Profile, and every place then shows the saved value', async () => {
    await renderBoth();
    fireEvent.change(within(onProfile()).getByRole('spinbutton', { name: 'Coverage floor' }), { target: { value: '0.4' } });
    fireEvent.click(within(inSettings()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stored().algorithms![0]!.params.coverageFloor).toBe(0.4));
    await waitFor(() => { for (const el of [...forms(), lower()]) expect(pre(el)).toContain('(0.4 + (1 − 0.4) × coverage)'); });
    for (const el of forms()) expect(within(el).queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('edits the final step on Profile too: the draft and the save reach Settings', async () => {
    await renderBoth();
    const box = (el: HTMLElement) => within(el).getByRole('textbox', { name: 'Discovery ranking formula' }) as HTMLTextAreaElement;
    fireEvent.change(box(onProfile()), { target: { value: 'affinity * 0.7' } });
    expect(box(inSettings()).value).toBe('affinity * 0.7');
    for (const el of [...forms(), lower()]) expect(pre(el)).toContain('final = affinity * 0.7');
    fireEvent.click(within(onProfile()).getByRole('button', { name: 'Save formula' }));
    await waitFor(() => expect(stored().algorithms![0]!.finalFormula).toBe('affinity * 0.7'));
    expect(box(inSettings()).value).toBe('affinity * 0.7');
    expect((within(inSettings()).getByRole('button', { name: 'Save formula' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps unsaved values through a final-step save, so one save never discards the other half of the form', async () => {
    await renderBoth();
    fireEvent.change(within(onProfile()).getByRole('spinbutton', { name: 'Tempo (seed fit)' }), { target: { value: '0.2' } });
    fireEvent.change(within(inSettings()).getByRole('textbox', { name: 'Discovery ranking formula' }), { target: { value: 'affinity * 0.9' } });
    fireEvent.click(within(inSettings()).getByRole('button', { name: 'Save formula' }));
    await waitFor(() => expect(stored().algorithms![0]!.finalFormula).toBe('affinity * 0.9'));
    expect(stored().algorithms![0]!.params.seedWeights.tempo).toBe(0.05);
    for (const el of forms()) expect((within(el).getByRole('spinbutton', { name: 'Tempo (seed fit)' }) as HTMLInputElement).value).toBe('0.2');
  });
});
