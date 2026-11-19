// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SettingsView } from './Settings';
import { api, type Settings } from './api';
import { DEFAULT_RANKING_FORMULA } from './engine/ranking-formula';
import { clearAlgorithmDrafts } from './useAlgorithmDraft';
vi.mock('./api', () => ({ api: { health: () => new Promise(() => {}), status: () => new Promise(() => {}), putSettings: vi.fn() } }));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
const saved: Settings = { fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false };
const props = () => ({ settings: saved, onSettings: vi.fn(), onReset: vi.fn(), onResetTaste: vi.fn(), onFormulaSaved: vi.fn() });
const input = () => screen.getByRole('textbox', { name: 'Discovery ranking formula' }) as HTMLTextAreaElement;
beforeEach(() => { clearAlgorithmDrafts(); vi.mocked(api.putSettings).mockReset().mockImplementation(async patch => ({ ...saved, ...patch })); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue('0.7 * genre + 0.3 * novelty') } }); });
afterEach(cleanup);
it('makes the existing algorithm editable and previews labelled example scores', () => {
  render(<SettingsView {...props()} />);
  expect(input().value).toBe(DEFAULT_RANKING_FORMULA);
  expect(screen.getByRole('button', { name: 'Save formula' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(/Example scores.*not actual songs/i)).toBeTruthy();
  fireEvent.change(input(), { target: { value: 'genre +' } });
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Save formula' }).hasAttribute('disabled')).toBe(true);
  expect(api.putSettings).not.toHaveBeenCalled();
});
it('saves explicitly, awaits persistence and tells the parent the accepted settings', async () => {
  const p = props(); render(<SettingsView {...p} />);
  fireEvent.change(input(), { target: { value: '0.7 * genre + 0.3 * novelty' } });
  expect(api.putSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save formula' }));
  // ALGO-MANAGER-001: the built-in is read-only, so the formula lands in a new active copy "My formula".
  await waitFor(() => expect(p.onFormulaSaved).toHaveBeenCalledWith(expect.objectContaining({
    active_algorithm: expect.stringMatching(/^user-/),
    algorithms: [expect.objectContaining({ name: 'My formula', finalFormula: '0.7 * genre + 0.3 * novelty' })],
  })));
  expect(api.putSettings).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/saved as a new algorithm “My formula”, which is now active/)).toBeTruthy();
});
it('copies edited text and pastes a replacement without silently applying it', async () => {
  render(<SettingsView {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy formula' }));
  await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(DEFAULT_RANKING_FORMULA));
  fireEvent.click(screen.getByRole('button', { name: 'Paste formula' }));
  await waitFor(() => expect(input().value).toBe('0.7 * genre + 0.3 * novelty'));
  expect(api.putSettings).not.toHaveBeenCalled();
});
it('resets a custom formula to the default final step only after Save', async () => {
  // A legacy ranking_formula reads as the migrated active algorithm "My formula" (id my-formula).
  render(<SettingsView {...props()} settings={{ ...saved, ranking_formula: 'genre' }} />);
  expect(input().value).toBe('genre');
  fireEvent.click(screen.getByRole('button', { name: 'Use default formula' }));
  expect(input().value).toBe(DEFAULT_RANKING_FORMULA); expect(api.putSettings).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save formula' }));
  await waitFor(() => expect(api.putSettings).toHaveBeenCalledWith({ algorithms: [expect.objectContaining({ id: 'my-formula', name: 'My formula', finalFormula: DEFAULT_RANKING_FORMULA })] }));
});
it('keeps the draft and reports a rejected save, not a false Saved message', async () => {
  vi.mocked(api.putSettings).mockRejectedValue(new Error('Storage unavailable'));
  const p = props(); render(<SettingsView {...p} />);
  fireEvent.change(input(), { target: { value: 'genre' } }); fireEvent.click(screen.getByRole('button', { name: 'Save formula' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Storage unavailable'));
  expect(input().value).toBe('genre'); expect(p.onFormulaSaved).not.toHaveBeenCalled();
});
it('does not report Saved when an older engine ignores the formula', async () => {
  vi.mocked(api.putSettings).mockResolvedValue(saved);
  const p = props(); render(<SettingsView {...p} />);
  fireEvent.change(input(), { target: { value: 'genre' } }); fireEvent.click(screen.getByRole('button', { name: 'Save formula' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('did not accept'));
  expect(p.onFormulaSaved).not.toHaveBeenCalled(); expect(input().value).toBe('genre');
});
it('leaves normal native paste available when clipboard read permission is denied', async () => {
  vi.mocked(navigator.clipboard.readText).mockRejectedValue(new Error('Permission denied'));
  render(<SettingsView {...props()} />); fireEvent.click(screen.getByRole('button', { name: 'Paste formula' }));
  await waitFor(() => expect(screen.getByText(/paste.*directly|directly.*paste/i)).toBeTruthy());
  expect(document.activeElement).toBe(input()); expect(input().value).toBe(DEFAULT_RANKING_FORMULA);
});
