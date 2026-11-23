// @vitest-environment happy-dom
/** MOOD-QUEUE-001: the now playing queue follows the listening mood, with the engine's answer applied on screen. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api, type RecItem, type RecResult, type Track } from './api';
vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {}, taste: null }), feedback: vi.fn().mockResolvedValue({ recorded: true }),
    last: vi.fn(), playlists: vi.fn().mockResolvedValue({ lists: [] }), impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    rerank: vi.fn(), mood: vi.fn(), health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  }};
});
const track = (key: string, title: string) => ({ key, title, artists: ['Test artist'], provider: 'deezer', platform_id: key, tags: [] } as unknown as Track);
const item = (key: string, title: string) => ({ track: track(key, title), rank: 1, reasons: [], playback: { kind: 'none' }, characteristics: { genres: [] } } as unknown as RecItem);
const rap = item('rap', 'Rap song'), jazz = item('jazz', 'Jazz song'), elec = item('elec', 'Electronic song');
const result = { items: [rap, jazz, elec], count: 3, asked: 3, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult;
const titles = () => screen.getAllByText(/^(Rap|Jazz|Electronic) song$/).map((e) => e.closest('.rec__title')).filter(Boolean).map((e) => e!.textContent); // MARQUEE-001: the text sits inside the scrolling span

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.last).mockResolvedValue(result);
  vi.mocked(api.settings).mockResolvedValue(null as never);
  vi.mocked(api.rerank).mockResolvedValue({ ...result, taste: null } as never);
  vi.mocked(api.mood).mockResolvedValue({ order: ['rap', 'elec', 'jazz'], changed: true, moved: ['elec', 'jazz'], gain: 0.1, leading: ['Rap', 'Electronic'], confidence: 0.8 } as never);
});

describe('the listening mood re-arranges the now playing queue', () => {
  it('starring a song asks the engine for the mood order and shows it, with a note saying why', async () => {
    render(<App />);
    await screen.findByText('Jazz song');
    expect(titles()).toEqual(['Rap song', 'Jazz song', 'Electronic song']);
    fireEvent.click(screen.getAllByRole('button', { name: /^Like Rap song/ })[0]!);
    await waitFor(() => expect(api.mood).toHaveBeenCalled(), { timeout: 3000 });
    const body = vi.mocked(api.mood).mock.calls.at(-1)![0] as { upcoming: { track: Track }[] };
    expect(body.upcoming.map((u) => u.track.key)).toEqual(['rap', 'jazz', 'elec']);
    // SAVE-MENU-STAY-001: the like opened the playlist menu, and the rows hold still under it. The new order shows
    // the moment the menu is closed.
    expect(titles()).toEqual(['Rap song', 'Jazz song', 'Electronic song']);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(titles()).toEqual(['Rap song', 'Electronic song', 'Jazz song']));
    expect(screen.getByRole('status', { name: /Queue re-arranged for your mood/ }).textContent).toMatch(/Rap · Electronic/);
  });

  it('asks nothing when Listening mood is off in Settings', async () => {
    vi.mocked(api.settings).mockResolvedValue({ mood_queue: false } as never);
    render(<App />);
    await screen.findByText('Jazz song');
    fireEvent.click(screen.getAllByRole('button', { name: /^Like Rap song/ })[0]!);
    await waitFor(() => expect(api.feedback).toHaveBeenCalled());
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    expect(api.mood).not.toHaveBeenCalled();
    expect(titles()).toEqual(['Rap song', 'Jazz song', 'Electronic song']);
  });
});
