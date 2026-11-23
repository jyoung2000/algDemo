// @vitest-environment happy-dom
/**
 * CAR-SAVE-HIDDEN-001: while the phone's screen was away, the car starred songs and added them to playlists (the
 * playback service's engine saved them). Coming back to the front, the page reads the stars and the lists again,
 * so the phone shows what the car did and never pushes an older set of playlists back to the car.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api, type RecItem, type RecResult, type Track } from './api';
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn(), feedback: vi.fn().mockResolvedValue({ recorded: true }),
    last: vi.fn(), playlists: vi.fn(), impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    rerank: vi.fn(), mood: vi.fn(), health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  }};
});
const track = (key: string, title: string) => ({ key, title, artists: ['Test artist'], provider: 'deezer', platform_id: key, tags: [] } as unknown as Track);
const item = (key: string, title: string) => ({ track: track(key, title), rank: 1, reasons: [], playback: { kind: 'none' }, characteristics: { genres: [] } } as unknown as RecItem);
const result = { items: [item('a', 'Alpha song'), item('b', 'Bravo song')], count: 2, asked: 2, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult;

const show = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => { cleanup(); show('visible'); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.last).mockResolvedValue(result);
  vi.mocked(api.feedbackState).mockResolvedValue({ state: {}, events: 0, taste: null } as never);
  vi.mocked(api.playlists).mockResolvedValue({ lists: [] } as never);
});

describe('coming back to the front after the car saved things', () => {
  it('reads the stars and the playlists again, and shows the star the car gave', async () => {
    render(<App />);
    await screen.findByText('Alpha song');
    await waitFor(() => expect(api.playlists).toHaveBeenCalled());
    expect(screen.getAllByRole('button', { name: /^Like Alpha song/ }).length).toBeGreaterThan(0);
    const stars = vi.mocked(api.feedbackState).mock.calls.length;
    const reads = vi.mocked(api.playlists).mock.calls.length;

    // Away: nothing is read for a screen nobody sees.
    show('hidden');
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(api.feedbackState).mock.calls.length).toBe(stars);

    // The car starred Alpha meanwhile.
    vi.mocked(api.feedbackState).mockResolvedValue({ state: { a: { like: true } }, events: 1, taste: null } as never);
    show('visible');
    await waitFor(() => expect(vi.mocked(api.feedbackState).mock.calls.length).toBe(stars + 1));
    await waitFor(() => expect(vi.mocked(api.playlists).mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Liked: choose lists for Alpha song/ }).length).toBeGreaterThan(0));
  });
});
