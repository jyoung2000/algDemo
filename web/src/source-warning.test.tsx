// @vitest-environment happy-dom
/**
 * SRC-WARN-001: the "some sources did not answer" line belongs in Settings, not over the songs.
 *
 * Owner: "get rid of the some sources did not answer or move this warning to the settings panel".
 * It sat above the results on every run where one provider was slow, telling the listener nothing
 * they could act on. Settings already carries the runtime status panel, so it goes there and the
 * discovery list stays about music.
 */
import appSource from './App.tsx?raw';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SettingsView } from './Settings';

vi.mock('./api', () => ({ api: { health: () => new Promise(() => {}), status: () => new Promise(() => {}) } }));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
afterEach(cleanup);

const props = { settings: null, onSettings: vi.fn(), onReset: vi.fn(), onResetTaste: vi.fn() };

it('does not warn about quiet sources over the discovery list', () => {
  expect(appSource).not.toMatch(/Some sources did not answer/);
});

it('hands the per-source outcome to Settings instead of dropping it', () => {
  expect(appSource).toMatch(/<SettingsView[\s\S]{0,500}sources=\{/);
});

it('Settings names the sources that did not answer', () => {
  render(<SettingsView {...props} sources={{ deezer: { state: 'ok' }, musicbrainz: { state: 'error' } }} />);
  expect(screen.getByText(/did not answer/i).textContent).toMatch(/musicbrainz/);
});

it('Settings stays quiet when every source answered', () => {
  render(<SettingsView {...props} sources={{ deezer: { state: 'ok' } }} />);
  expect(screen.queryByText(/did not answer/i)).toBeNull();
});
