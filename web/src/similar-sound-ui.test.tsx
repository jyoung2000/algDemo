// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Results } from './Results';
import { SettingsView } from './Settings';
import { makeTrack } from './engine/track';
import type { Track } from './api';

vi.mock('./api', async () => ({ api: { health: () => new Promise(() => {}), status: () => new Promise(() => {}), settings: () => Promise.resolve({}) } }));
vi.mock('./MicSettings', () => ({ MicSettings: () => null }));
vi.mock('./QueueDownloadSettings', () => ({ QueueDownloadSettings: () => null }));
vi.mock('./AudioSettings', () => ({ AudioSettings: () => null }));
vi.mock('./RankingFormulaSettings', () => ({ RankingFormulaSettings: () => null }));
const seed = makeTrack({ provider: 'deezer', platformId: '1', title: 'Alpha Song', artists: ['Real'], url: 'https://example.invalid/a', duration: 120 });
const other = makeTrack({ provider: 'audius', platformId: '2', title: 'Beta Song', artists: ['Real'], url: 'https://example.invalid/b', duration: 120 });
const noop = () => {};
const props = { seeds: [seed as unknown as Track], onRemoveSeed: noop, onEmphasis: noop, items: [{ track: other, rank: 1, score: 0.5, reasons: [], coverage: 0, evidence: 'some', tier: 'related', sources: [], characteristics: {}, playback: {} }] as never,
  focusKey: null, playingKey: null, flags: {}, onFocus: noop, onPlay: noop, onPlayTrack: noop, onFeedback: noop };
afterEach(cleanup);
describe('similar sound on the song list and in Settings', () => {
  it('puts a separate accessible button on starting and discovered songs; the selected song is sent, never a global seed', () => {
    const onSimilar = vi.fn();
    render(<Results {...props} onSimilar={onSimilar} />);
    const list = screen.getByRole('list', { name: 'Now playing queue' });
    const a = within(list).getByRole('button', { name: 'Find similar sound to Alpha Song' });
    const b = within(list).getByRole('button', { name: 'Find similar sound to Beta Song' });
    expect(a.className).toBe(b.className);
    // SIMILAR-ICON-001 (owner, 2026-11-19): an icon in the row of buttons; the Why and Hide buttons it replaces are gone.
    expect(a.closest('.rec__actions')).not.toBeNull();
    expect(a.textContent?.trim()).toBe('');
    fireEvent.click(b); expect(onSimilar).toHaveBeenCalledWith(other);
    fireEvent.click(a); expect(onSimilar).toHaveBeenCalledWith(seed);
  });
  it('does not offer a real provider search for sample-only rows', () => {
    render(<Results {...props} />);
    expect(screen.queryAllByRole('button', { name: /Find similar sound to/ })).toHaveLength(0);
  });
  it('disables the action on every row while one search runs', () => {
    render(<Results {...props} onSimilar={vi.fn()} similarBusy />);
    expect(screen.getAllByRole('button', { name: /Find similar sound to/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /Find similar sound to/ }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
  it('shows the persisted percentage and sends the new threshold through the Settings callback', () => {
    const onSettings = vi.fn();
    render(<SettingsView settings={{ fresh: false, adventurous: 0.5, audio: true, daily_mb: 100, request_mb: 20, sample_mode: false, similar_percent: 85 }}
      onSettings={onSettings} onReset={noop} onResetTaste={noop} />);
    const section = screen.getByRole('region', { name: 'Similar sound' });
    expect(within(section).getByText('85%')).toBeTruthy();
    const slider = within(section).getByRole('slider', { name: 'Minimum sound match' }) as HTMLInputElement;
    expect([slider.min,slider.max,slider.step,slider.value]).toEqual(['40','95','1','85']);
    fireEvent.change(slider, { target: { value: '91' } });
    expect(onSettings).toHaveBeenCalledWith({ similar_percent: 91 });
  });
});
