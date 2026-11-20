// @vitest-environment happy-dom
// REMOVE-CONFIRM-001 (owner, 2026-11-20): "On the discover page the x button should have a disclaimer or a warning
// modal". The X dislikes the song and removes it for good (REMOVE-FOREVER-001), so it now asks first and says what
// will happen; "Don't ask again" is remembered. Undoing a dislike never asks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api, type RecItem, type RecResult, type Track } from './api';
import { CONFIRM_REMOVE_KEY } from './ConfirmRemove';
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {}, taste: null }), feedback: vi.fn().mockResolvedValue({ recorded: true }),
    last: vi.fn(), playlists: vi.fn().mockResolvedValue({ lists: [] }), impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    rerank: vi.fn().mockRejectedValue(new Error('no pool')), health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  }};
});
const track = (key: string, title: string) => ({ key, title, artists: ['Test artist'], provider: 'deezer', platform_id: key, tags: [] } as unknown as Track);
const item = (key: string, title: string) => ({ track: track(key, title), rank: 1, reasons: [], playback: { kind: 'none' }, characteristics: {} } as unknown as RecItem);
const result = { items: [item('bad', 'Unwanted song'), item('good', 'Better song')], count: 2, asked: 2, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult;
const X = 'Dislike Unwanted song and remove it from the queue';
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.mocked(api.last).mockResolvedValue(result); });

describe('the Discover X asks before removing', () => {
  it('opens a warning that says what removing does; nothing is sent until Remove', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: X }));
    const dialog = await screen.findByRole('alertdialog', { name: /Remove .Unwanted song./ });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toMatch(/won.t be recommended again/i);
    expect(dialog.textContent).toMatch(/similar songs/i);
    expect(dialog.textContent).toMatch(/downloaded copy/i);
    expect(dialog.textContent).toMatch(/like or star it/i);
    expect(api.feedback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('dislike', expect.objectContaining({ key: 'bad' }), expect.anything()));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('Cancel, Escape and the backdrop keep the song', async () => {
    render(<App />);
    for (const close of [() => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })), () => fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' }), () => fireEvent.click(document.querySelector('.confirm-remove__backdrop')!)]) {
      fireEvent.click(await screen.findByRole('button', { name: X }));
      await screen.findByRole('alertdialog');
      close();
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    }
    expect(api.feedback).not.toHaveBeenCalled();
    expect(screen.getByText('Unwanted song')).toBeTruthy();
  });
  it('"Don\'t ask again" is remembered: the next X removes straight away', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: X }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Don.t ask again/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(CONFIRM_REMOVE_KEY)).toBe('off');
  });
  it('the Cancel button has focus when it opens, so Enter never removes by accident', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: X }));
    await screen.findByRole('alertdialog');
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
  });
});
