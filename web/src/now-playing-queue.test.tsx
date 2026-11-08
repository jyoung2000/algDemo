// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api, type RecResult, type Track } from './api';

// Mock persistence only: render the real shared app, headings, rows and clear control.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn(), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {} }), last: vi.fn(),
    playlists: vi.fn().mockResolvedValue({ lists: [] }),
    impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    clearQueue: vi.fn().mockResolvedValue({ ok: true }),
    health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  } };
});
const track = { key: 'queue-label-fixture', title: 'Queue label fixture', artist: 'Test artist', provider: 'deezer', platform_id: '1' } as Track;
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(api.clearQueue).mockClear();
  vi.mocked(api.seeds).mockResolvedValue({ seeds: [track] });
  vi.mocked(api.last).mockRejectedValue(new Error('No previous discovery'));
});

describe('Now playing queue shared Windows / Android UI', () => {
  it('uses the queue name in discovery help and the reset confirmation', async () => {
    render(<App />);
    await screen.findByText(track.title);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(document.getElementById('discovery-size-help')?.textContent).toMatch(/now playing queue ran low/);
    expect(document.getElementById('discovery-listening-help')?.textContent).toMatch(/finish one from your now playing queue/);
    fireEvent.click(screen.getByRole('button', { name: 'Reset the app to defaults' }));
    expect(screen.getByText(/Put everything back to default\?/).textContent).toMatch(/now playing queue/);
  });

  it.each(['starting songs', 'discovery results'] as const)('names the %s heading, list and clear action consistently', async (state) => {
    if (state === 'discovery results') {
      vi.mocked(api.last).mockResolvedValue({ items: [], count: 0, asked: 0, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult);
    }
    render(<App />);
    const list = await screen.findByRole('list', { name: 'Now playing queue' });
    expect(list.textContent).toContain(track.title);
    expect(screen.getByRole('heading', { name: /^Now playing queue\s+1$/ })).toBeTruthy();
    const clear = screen.getByRole('button', { name: 'Clear now playing queue' });
    expect(clear.title).toBe('Clear now playing queue. Your listening history and settings are kept.');
    expect(api.clearQueue).not.toHaveBeenCalled();
    fireEvent.click(clear);
    await waitFor(() => expect(api.clearQueue).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Now playing queue cleared. Your listening history and settings are kept.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Now playing queue' })).toBeNull();
  });
});
