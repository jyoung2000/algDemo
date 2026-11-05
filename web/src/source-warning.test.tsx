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
import searchSource from './Search.tsx?raw';
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

/**
 * Checking App.tsx alone missed a second copy of the line in the no-results message, which only
 * turned up by grepping the built bundle. Every user-facing surface is checked here instead.
 */
it('no user-facing surface carries the line, including the no-results message', () => {
  for (const [name, source] of [['App.tsx', appSource], ['Search.tsx', searchSource]] as const) {
    expect(source, `${name} still names quiet sources to the listener`).not.toMatch(/sources did not answer/i);
  }
});

it('a search that found nothing still suggests trying again', () => {
  // Dropping the warning must not drop the actionable part: when a provider was quiet, the reason
  // the list is empty is that the run was incomplete, so the retry hint has to survive.
  expect(searchSource).toMatch(/try again in a moment/i);
});

it('hands the per-source outcome to Settings instead of dropping it', () => {
  expect(appSource).toMatch(/<SettingsView[\s\S]{0,500}sources=\{/);
});

it('Settings names the sources that did not answer', () => {
  render(<SettingsView {...props} sources={{ deezer: { state: 'ok' }, musicbrainz: { state: 'error' } }} />);
  expect(screen.getByText(/did not answer/i).textContent).toMatch(/musicbrainz/);
});

/**
 * Found on the packaged 0.7.3 desktop app: the live keys are "provider:query" pairs, not provider
 * names, so a real run printed 40+ entries like "apple-search:luther, mba:justin bieber, ..." in one
 * unreadable paragraph. Group by provider and cap the list.
 */
it('groups the quiet sources by provider instead of listing every query', () => {
  render(<SettingsView {...props} sources={{
    'apple-search:luther': { state: 'error' },
    'apple-search:snooze': { state: 'error' },
    'apple-search:halo': { state: 'error' },
    'ytmusic-radio:luther': { state: 'error' },
    'ytmusic-radio:snooze': { state: 'error' },
    'mba:justin bieber': { state: 'error' },
  }} />);
  const line = screen.getByText(/did not answer/i).textContent ?? '';
  expect(line).toMatch(/apple-search/);
  expect(line).toMatch(/ytmusic-radio/);
  expect(line).toMatch(/mba/);
  // Each provider is named once, not once per query.
  expect(line.match(/apple-search/g)).toHaveLength(1);
  expect(line).not.toMatch(/luther|snooze|halo|justin bieber/);
  expect(line.length).toBeLessThan(200);
});

it('caps a very long provider list rather than printing a paragraph', () => {
  const sources: Record<string, { state: string }> = {};
  for (let i = 0; i < 25; i++) sources[`provider${i}:some query`] = { state: 'error' };
  render(<SettingsView {...props} sources={sources} />);
  const line = screen.getByText(/did not answer/i).textContent ?? '';
  expect(line.length).toBeLessThan(200);
  expect(line).toMatch(/more/);
});

it('a skipped source is not a failure', () => {
  // The banner this replaced excluded 'skipped'; a source the run deliberately did not use has not
  // "failed to answer", and calling it out would invent a problem.
  render(<SettingsView {...props} sources={{ deezer: { state: 'ok' }, genius: { state: 'skipped' } }} />);
  expect(screen.queryByText(/did not answer/i)).toBeNull();
});

it('Settings stays quiet when every source answered', () => {
  render(<SettingsView {...props} sources={{ deezer: { state: 'ok' } }} />);
  expect(screen.queryByText(/did not answer/i)).toBeNull();
});
