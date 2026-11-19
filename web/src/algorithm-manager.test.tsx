// @vitest-environment happy-dom
/**
 * ALGO-MANAGER-001: the Profile toolbar (create / select / reset / import / export / edit) and
 * Settings' Discovery algorithm, both backed by one real LocalApi so they are checked against the
 * engine's own settings handling, not a stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BUILT_IN_ALGORITHM, BUILT_IN_ID, MIGRATED_ID, createFrom, formulaLines, formulaNotes, serializeAlgorithm, setParam, type Algorithm } from './engine/algorithms';

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
import { clearAlgorithmDrafts } from './useAlgorithmDraft';
import { SettingsView } from './Settings';
import type { Settings } from './api';

const port = { request: async () => { throw new Error('UI tests must not contact providers'); } } as HttpPort;
let store: Store;
async function boot(settings?: Record<string, unknown>) {
  clearAlgorithmDrafts();
  store = await Store.open(new MemoryBackend());
  if (settings) await store.put('settings', settings);
  h.local = new LocalApi({ store, port, encoder: null });
}
const stored = () => (store.get<Record<string, unknown>>('settings') ?? {}) as { algorithms?: Algorithm[]; active_algorithm?: string };
const profileSelect = () => within(manager()).getByRole('combobox', { name: 'Algorithm' }) as HTMLSelectElement;
const settingsSelect = () => within(screen.getByRole('region', { name: 'Discovery algorithm' })).getByRole('combobox', { name: 'Algorithm' }) as HTMLSelectElement;
const manager = () => screen.getByRole('region', { name: 'Recommendation algorithm' });
const optionNames = (s: HTMLSelectElement) => [...s.options].map((o) => o.textContent);
const user = (name: string, id: string, over: Partial<Algorithm> = {}): Algorithm => ({ ...createFrom(BUILT_IN_ALGORITHM, name, id), ...over });

beforeEach(async () => { await boot(); });
afterEach(cleanup);

async function renderProfile() {
  render(<ProfileView />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your profile', level: 2 })).toBeTruthy());
  await waitFor(() => expect(profileSelect().disabled).toBe(false));
}

describe('Profile algorithm toolbar', () => {
  it('sits at the very top, lists the built-in first and shows its read-only data and formula', async () => {
    await renderProfile();
    const page = document.querySelector('.profile')!;
    expect(page.firstElementChild).toBe(manager());
    expect(optionNames(profileSelect())).toEqual(['jPlay default (built-in)']);
    expect(profileSelect().value).toBe(BUILT_IN_ID);
    expect(within(manager()).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(manager()).getByText(/built-in algorithm is read-only/)).toBeTruthy();
    expect(within(manager()).getByLabelText('Formula of jPlay default').textContent).toBe(formulaLines(BUILT_IN_ALGORITHM).join('\n'));
    // The existing Recommendation formula section reads the same algorithm.
    const formulaCard = screen.getByRole('region', { name: 'Recommendation formula' });
    await waitFor(() => expect(formulaCard.querySelector('pre.formula')!.textContent).toBe(formulaLines(BUILT_IN_ALGORITHM).join('\n')));
    for (const b of ['Create', 'Reset', 'Import', 'Export']) expect(within(manager()).getByRole('button', { name: b }).className).toBe('push');
  });

  it('lists, under the formula, how the engine applies it (FORMULA-NOTES-001)', async () => {
    await renderProfile();
    const notes = within(manager()).getByRole('list', { name: 'How the engine applies this formula' });
    expect(within(notes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(formulaNotes(BUILT_IN_ALGORITHM));
    // The formula itself is still exactly the six lines.
    expect(within(manager()).getByLabelText('Formula of jPlay default').textContent).toBe(formulaLines(BUILT_IN_ALGORITHM).join('\n'));
  });

  it('Create copies the selected algorithm under an inline name, selects it and makes it editable', async () => {
    await renderProfile();
    fireEvent.click(within(manager()).getByRole('button', { name: 'Create' }));
    const name = screen.getByRole('textbox', { name: 'Name for the new algorithm' }) as HTMLInputElement;
    expect(name.value).toBe('jPlay default copy');
    fireEvent.change(name, { target: { value: 'Late night' } });
    const create = screen.getByRole('button', { name: 'Create algorithm' });
    expect(create.className).toBe('push push--default');
    fireEvent.click(create);
    await waitFor(() => expect(optionNames(profileSelect())).toEqual(['jPlay default (built-in)', 'Late night']));
    expect(profileSelect().selectedOptions[0]!.textContent).toBe('Late night');
    expect(stored().active_algorithm).toBe(stored().algorithms![0]!.id);
    expect(stored().algorithms![0]!.params).toEqual(BUILT_IN_ALGORITHM.params);
    // Edit a value; Save/Cancel appear only when dirty, and the saved value drives the formula everywhere.
    const audio = within(manager()).getByRole('spinbutton', { name: 'Sound (seed fit)' }) as HTMLInputElement;
    expect(within(manager()).queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(audio, { target: { value: '0.5' } });
    expect(within(manager()).getByLabelText('Formula of Late night').textContent).toContain('0.5·audio');
    fireEvent.click(within(manager()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(stored().algorithms![0]!.params.seedWeights.audio).toBe(0.5));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Recommendation formula' }).querySelector('pre.formula')!.textContent).toContain('[0.5·audio'));
  });

  it('rejects invalid edits inline and Cancel restores the saved values', async () => {
    await boot({ algorithms: [user('Mine', 'user-mine')], active_algorithm: 'user-mine' });
    await renderProfile();
    const floor = within(manager()).getByRole('spinbutton', { name: 'Coverage floor' }) as HTMLInputElement;
    fireEvent.change(floor, { target: { value: '1.4' } });
    expect(within(manager()).getByRole('alert').textContent).toContain('Coverage floor must be between 0 and 1.');
    expect((within(manager()).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(manager()).getByRole('button', { name: 'Cancel' }));
    expect(floor.value).toBe('0.55');
  });

  it('selecting makes an algorithm active immediately', async () => {
    await boot({ algorithms: [user('Mine', 'user-mine')] });
    await renderProfile();
    expect(profileSelect().value).toBe(BUILT_IN_ID);
    fireEvent.change(profileSelect(), { target: { value: 'user-mine' } });
    await waitFor(() => expect(stored().active_algorithm).toBe('user-mine'));
    expect(profileSelect().value).toBe('user-mine');
  });

  it('Reset offers the built-in or a value reset inline, without window.confirm', async () => {
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    const tweaked = user('Mine', 'user-mine', { params: setParam(BUILT_IN_ALGORITHM.params, 'tasteWeight', 0.4), finalFormula: 'affinity * 0.9' });
    await boot({ algorithms: [tweaked], active_algorithm: 'user-mine' });
    await renderProfile();
    fireEvent.click(within(manager()).getByRole('button', { name: 'Reset' }));
    const options = screen.getByRole('group', { name: 'Reset options' });
    fireEvent.click(within(options).getByRole('button', { name: 'Reset “Mine” to built-in values' }));
    await waitFor(() => expect(stored().algorithms![0]).toMatchObject({ id: 'user-mine', params: BUILT_IN_ALGORITHM.params, finalFormula: BUILT_IN_ALGORITHM.finalFormula }));
    expect(stored().active_algorithm).toBe('user-mine');
    fireEvent.click(within(manager()).getByRole('button', { name: 'Reset' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Reset options' })).getByRole('button', { name: 'Use jPlay default' }));
    await waitFor(() => expect(stored().active_algorithm).toBe(BUILT_IN_ID));
    expect(profileSelect().value).toBe(BUILT_IN_ID);
    expect(stored().algorithms).toHaveLength(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Import accepts pasted JSON or a .json file, validates, adds and selects it', async () => {
    await renderProfile();
    const shared = user('Shared groove', 'user-ignored', { params: setParam(BUILT_IN_ALGORITHM.params, 'globalWeights.novelty', 0.3) });
    fireEvent.click(within(manager()).getByRole('button', { name: 'Import' }));
    const box = screen.getByRole('textbox', { name: 'Or paste algorithm JSON' });
    fireEvent.change(box, { target: { value: '{"format":"other"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import algorithm' }));
    expect(within(manager()).getByRole('alert').textContent).toBe('This is not a jPlay algorithm file.');
    expect(stored().algorithms ?? []).toHaveLength(0);
    fireEvent.change(box, { target: { value: serializeAlgorithm(shared) } });
    fireEvent.click(screen.getByRole('button', { name: 'Import algorithm' }));
    await waitFor(() => expect(profileSelect().selectedOptions[0]!.textContent).toBe('Shared groove'));
    expect(stored().algorithms![0]).toMatchObject({ name: 'Shared groove', params: shared.params });
    expect(stored().algorithms![0]!.id).not.toBe('user-ignored');
    // File route: the same file again gets a distinct name.
    fireEvent.click(within(manager()).getByRole('button', { name: 'Import' }));
    const file = new File([serializeAlgorithm(shared)], 'shared.json', { type: 'application/json' });
    await act(async () => { fireEvent.change(screen.getByLabelText('Algorithm file (.json)'), { target: { files: [file] } }); });
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Or paste algorithm JSON' }) as HTMLTextAreaElement).value).toContain('Shared groove'));
    fireEvent.click(screen.getByRole('button', { name: 'Import algorithm' }));
    await waitFor(() => expect(optionNames(profileSelect())).toEqual(['jPlay default (built-in)', 'Shared groove', 'Shared groove 2']));
    expect(profileSelect().selectedOptions[0]!.textContent).toBe('Shared groove 2');
  });

  it('Export downloads the selected algorithm as versioned JSON', async () => {
    await boot({ algorithms: [user('Mine', 'user-mine')], active_algorithm: 'user-mine' });
    const urls: Blob[] = [];
    Object.assign(URL, { createObjectURL: vi.fn((b: Blob) => { urls.push(b); return 'blob:algo'; }), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { expect(this.download).toBe('mine.airwave-algorithm.json'); });
    await renderProfile();
    fireEvent.click(within(manager()).getByRole('button', { name: 'Export' }));
    expect(click).toHaveBeenCalledTimes(1);
    const data = JSON.parse(await urls[0]!.text());
    expect(data).toMatchObject({ format: 'airwave-algorithm', version: 1, algorithm: { name: 'Mine', params: BUILT_IN_ALGORITHM.params } });
    click.mockRestore();
  });
});

describe('Settings and Profile agree', () => {
  const saved: Settings = { fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false };
  function Both({ settings }: { settings: Settings }) {
    return <><ProfileView /><SettingsView settings={settings} onSettings={vi.fn()} onReset={vi.fn()} onResetTaste={vi.fn()} /></>;
  }
  const settingsPre = () => document.querySelector('[data-algorithm-form="settings"] pre.formula')!;
  const profilePre = () => manager().querySelector('pre.formula')!;

  it('migrates a legacy formula and shows the same active algorithm and formula in both places', async () => {
    await boot({ ...saved, ranking_formula: 'affinity * 0.8', weights: { audio: 0.3 } });
    const fresh = (await call('GET', '/api/settings')) as Settings;
    render(<Both settings={fresh} />);
    await waitFor(() => expect(profileSelect().value).toBe(MIGRATED_ID));
    expect(settingsSelect().value).toBe(MIGRATED_ID);
    expect(optionNames(settingsSelect())).toEqual(optionNames(profileSelect()));
    expect(settingsPre().textContent).toBe(profilePre().textContent);
    expect(profilePre().textContent).toContain('final = affinity * 0.8 (custom final step');
    expect(profilePre().textContent).toContain('[0.3·audio');
  });

  it('a choice in either place and a formula save from Settings show up in both', async () => {
    await boot({ ...saved, algorithms: [user('Mine', 'user-mine', { params: setParam(BUILT_IN_ALGORITHM.params, 'coverageFloor', 0.4) })] });
    render(<Both settings={saved} />);
    await waitFor(() => expect(profileSelect().disabled).toBe(false));
    fireEvent.change(profileSelect(), { target: { value: 'user-mine' } });
    await waitFor(() => expect(settingsSelect().value).toBe('user-mine'));
    expect(settingsPre().textContent).toBe(profilePre().textContent);
    expect(settingsPre().textContent).toContain('(0.4 + (1 − 0.4) × coverage)');
    fireEvent.change(settingsSelect(), { target: { value: BUILT_IN_ID } });
    await waitFor(() => expect(profileSelect().value).toBe(BUILT_IN_ID));
    // Saving a final step while the built-in is active creates and activates "My formula", in both.
    fireEvent.change(within(screen.getByRole('region', { name: 'Discovery algorithm' })).getByRole('textbox', { name: 'Discovery ranking formula' }), { target: { value: 'affinity * 0.7' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Discovery algorithm' })).getByRole('button', { name: 'Save formula' }));
    await waitFor(() => expect(profileSelect().selectedOptions[0]!.textContent).toBe('My formula'));
    expect(settingsSelect().selectedOptions[0]!.textContent).toBe('My formula');
    expect(within(screen.getByRole('region', { name: 'Discovery algorithm' })).getByText(/saved as a new algorithm “My formula”/)).toBeTruthy();
    expect(settingsPre().textContent).toBe(profilePre().textContent);
    expect(profilePre().textContent).toContain('final = affinity * 0.7');
    expect(stored().algorithms!.map((a) => a.name)).toEqual(['Mine', 'My formula']);
  });
});
