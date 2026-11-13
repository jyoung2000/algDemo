// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api, type RecItem, type RecResult, type Track } from './api';
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {}, taste: null }), feedback: vi.fn().mockResolvedValue({ recorded: true }),
    last: vi.fn(), playlists: vi.fn().mockResolvedValue({ lists: [] }), impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    rerank: vi.fn(), health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  }};
});
const track = (key: string, title: string) => ({ key, title, artists: ['Test artist'], provider: 'deezer', platform_id: key, tags: [] } as unknown as Track);
const item = (key: string, title: string) => ({ track: track(key, title), rank: 1, reasons: [], playback: { kind: 'none' }, characteristics: {} } as unknown as RecItem);
const bad = item('bad', 'Unwanted song'), good = item('good', 'Better song');
const result = { items: [bad, good], count: 2, asked: 2, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult;
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.last).mockResolvedValue(result);
  vi.mocked(api.feedback).mockResolvedValue({ recorded: true } as never);
  vi.mocked(api.rerank).mockResolvedValue({ ...result, items: [good], taste: { events: 1, positives: 0, negatives: 1, likes: [], avoids: [{ name: 'rage', label: 'Rage', score: -1.5, skips: 1 }], genres: [{ name: 'rage', label: 'Rage', score: -1.5, plays: 0, skips: 1 }] } } as never);
});

describe('explicit dislike immediately teaches the current queue', () => {
  it('saves the judgement before reranking, then applies the new order without a discovery run', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song' }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('dislike', expect.objectContaining({ key: 'bad' }), expect.objectContaining({ event_id: expect.any(String) })));
    await waitFor(() => expect(api.rerank).toHaveBeenCalled());
    expect(vi.mocked(api.feedback).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.rerank).mock.invocationCallOrder[0]!);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dislike Unwanted song' })).toBeNull());
    expect(screen.getByText('Better song')).toBeTruthy();
  });
  it('does not rerank from unsaved feedback when the write fails', async () => {
    vi.mocked(api.feedback).mockRejectedValueOnce(new Error('Disk unavailable'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song' }));
    await waitFor(() => expect(screen.getByText(/Could not save that: Disk unavailable/)).toBeTruthy());
    expect(api.rerank).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Dislike Unwanted song' }).getAttribute('aria-pressed')).toBe('false');
  });
  it('undo teaches and reranks too', async () => {
    vi.mocked(api.feedbackState).mockResolvedValueOnce({ state: { bad: { dislike: true } }, taste: null } as never);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo dislike of Unwanted song' }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('undislike', expect.anything(), expect.anything()));
    await waitFor(() => expect(api.rerank).toHaveBeenCalled());
  });
  it('still refreshes taste when there is no pool to rerank yet', async () => {
    vi.mocked(api.rerank).mockRejectedValueOnce(new Error('Find recommendations first'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song' }));
    await waitFor(() => expect(api.rerank).toHaveBeenCalled());
    await waitFor(() => expect(api.feedbackState).toHaveBeenCalledTimes(2));
  });
});
