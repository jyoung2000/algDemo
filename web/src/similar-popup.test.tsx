// @vitest-environment happy-dom
/**
 * SIMILAR-NOTICE-001 (owner, 2026-11-20): "find similar songs needs a pop up or indicator on how many new similar songs
 * it found and added on all platforms". Before, the count was one line of text inside the Discover queue: from the
 * player on another page, or with the queue scrolled away, nothing showed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api, type RecResult, type Track } from './api';

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }),
    putSeeds: vi.fn().mockResolvedValue({ seeds: [] }),
    settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {} }),
    feedback: vi.fn().mockResolvedValue({ ok: true }),
    last: vi.fn(),
    playlists: vi.fn().mockResolvedValue({ lists: [] }),
    impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    recommend: vi.fn().mockResolvedValue({ job: '' }),
    similar: vi.fn(),
    job: vi.fn(),
    cancelJob: vi.fn().mockResolvedValue({}),
    health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  } };
});

const t = (i: number) => ({ key: `k${i}`, title: `Song ${i}`, artist: 'A', artists: ['A'], provider: 'deezer', platform_id: `${i}`, tags: [] }) as unknown as Track;
const result = (n: number) => ({ items: Array.from({ length: n }, (_, i) => ({ track: t(i), rank: i + 1, playback: {}, reasons: [] })), count: n, asked: 0, phase: 'final', sources: {}, transfer: {} }) as unknown as RecResult;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.last).mockResolvedValue(result(3));
  vi.mocked(api.similar).mockResolvedValue({ job: 's1' });
});
const card = () => screen.findByRole('status', { name: 'Find similar songs' });

describe('Find similar shows what it found in a card over the page', () => {
  it('says it is looking, then how many new songs it added; the card is not inside the queue', async () => {
    vi.mocked(api.job)
      .mockResolvedValueOnce({ done: false, progress: 'Comparing song 2 of 9' } as never)
      .mockResolvedValue({ done: true, result: { added: 2, reached: 2, minimum: 65, queue: result(5) } } as never);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Find similar sound to Song 1' }));
    const c = await card();
    await waitFor(() => expect(c.textContent).toContain('Finding songs like “Song 1”'));
    await waitFor(() => expect(c.textContent).toContain('2 new similar songs added'), { timeout: 4000 });
    expect(c.textContent).toContain('+2');
    expect(c.closest('section.queue')).toBeNull();
  });
  it('stays in view on another page, and Show brings back the queue at the first new song', async () => {
    vi.mocked(api.job).mockResolvedValue({ done: true, result: { added: 2, reached: 2, minimum: 65, queue: result(5) } } as never);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Find similar sound to Song 1' }));
    fireEvent.click(screen.getAllByRole('button', { name: /^Settings$/ })[0]!);
    const c = await card();
    await waitFor(() => expect(c.textContent).toContain('2 new similar songs added'), { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /^Show the 2 new similar songs/ }));
    await waitFor(() => expect(document.querySelector('section.queue')).toBeTruthy());
    await waitFor(() => expect(document.querySelector('[aria-current="true"], .is-focus, .rec--focus')?.textContent ?? '').toContain('Song 3'));
  });
  it('says so when nothing new was found', async () => {
    vi.mocked(api.job).mockResolvedValue({ done: true, result: { added: 0, minimum: 70, reason: 'No new songs reached 70% sound match. The list is unchanged.' } } as never);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Find similar sound to Song 1' }));
    const c = await card();
    await waitFor(() => expect(c.textContent).toContain('No new similar songs found'), { timeout: 4000 });
  });
});
