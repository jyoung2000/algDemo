// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { api, type RecResult, type Track } from './api';

/**
 * QUEUE-SEED-001. Owner: "I should be able to add 1 song to the song list / now playing queue on
 * mobile then start getting recommendations / new discovery music." One song added by hand is a
 * starting song, and discovery runs from it without the listener hunting for another control.
 */
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }),
    putSeeds: vi.fn().mockResolvedValue({ seeds: [] }),
    settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {} }),
    feedback: vi.fn().mockResolvedValue({ ok: true }),
    last: vi.fn().mockRejectedValue(new Error('No previous discovery')),
    playlists: vi.fn().mockResolvedValue({ lists: [] }),
    impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    queueAdd: vi.fn(),
    recommend: vi.fn().mockResolvedValue({ job: '' }),
    search: vi.fn(), searchAlbums: vi.fn(), searchArtists: vi.fn(), searchLyrics: vi.fn(),
    health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  } };
});

const found = { key: 'found-1', title: 'Found song', artist: 'Found artist', artists: ['Found artist'], provider: 'deezer', platform_id: '77' } as Track;
const emptyResult = { items: [], count: 0, asked: 0, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult;
const queuedResult = { ...emptyResult, items: [{ track: found, rank: 1, added: true, playback: {} }], count: 1 } as unknown as RecResult;

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.seeds).mockResolvedValue({ seeds: [] });
  vi.mocked(api.putSeeds).mockResolvedValue({ seeds: [found] });
  vi.mocked(api.last).mockRejectedValue(new Error('No previous discovery'));
  vi.mocked(api.queueAdd).mockResolvedValue(queuedResult);
  vi.mocked(api.recommend).mockResolvedValue({ job: '' });
  vi.mocked(api.search).mockResolvedValue({ query: 'found', results: [found], sources: { deezer: { state: 'ok', count: 1, ms: 1 } }, ms: 1 } as never);
  vi.mocked(api.searchAlbums).mockRejectedValue(new Error('no albums here'));
  vi.mocked(api.searchArtists).mockRejectedValue(new Error('no artists here'));
  vi.mocked(api.searchLyrics).mockRejectedValue(new Error('no lyrics here'));
});

async function addOneSongToTheQueue() {
  render(<App />);
  const box = await screen.findByRole('searchbox');
  fireEvent.change(box, { target: { value: 'found song' } });
  fireEvent.submit(box.closest('form')!);
  const add = await screen.findByRole('button', { name: `Add ${found.title} to Now playing queue` });
  fireEvent.click(add);
}

describe('one song added to the now playing queue starts discovery (QUEUE-SEED-001)', () => {
  it('makes that song a starting song', async () => {
    await addOneSongToTheQueue();
    await waitFor(() => expect(api.putSeeds).toHaveBeenCalled());
    const sent = vi.mocked(api.putSeeds).mock.calls.at(-1)![0] as Track[];
    expect(sent.map((t) => t.key)).toEqual([found.key]);
  });

  it('asks for recommendations from it without a second press', async () => {
    await addOneSongToTheQueue();
    await waitFor(() => expect(api.recommend).toHaveBeenCalled());
  });

  it('still puts the song in the queue itself', async () => {
    await addOneSongToTheQueue();
    await waitFor(() => expect(api.queueAdd).toHaveBeenCalled());
  });

  it('does not repeat a song already among the starting songs', async () => {
    vi.mocked(api.seeds).mockResolvedValue({ seeds: [found] });
    await addOneSongToTheQueue();
    await waitFor(() => expect(api.queueAdd).toHaveBeenCalled());
    expect(api.putSeeds).not.toHaveBeenCalled();
  });

  it('leaves the find button usable rather than saying there is no starting song', async () => {
    await addOneSongToTheQueue();
    await waitFor(() => expect(api.putSeeds).toHaveBeenCalled());
    await waitFor(() => expect(document.getElementById('go-why')?.textContent ?? '').not.toMatch(/Add at least one starting song first/));
  });
});

/**
 * ALLOWANCE-SEEN-001. The day's download allowance stops discovery, genre reading and album colour
 * silently: on the owner's phone 104 MB of a 100 MB day was spent and the app simply found nothing.
 * Say it where the music would have appeared, with the way to raise it.
 */
describe('a discovery stopped by the day\u2019s allowance says so (ALLOWANCE-SEEN-001)', () => {
  const spentResult = { items: [], count: 0, asked: 4, phase: 'final', saved_at: 1_700_000_000,
    sources: { deezer: { state: 'budget', ms: 3 }, ytmusic: { state: 'budget', ms: 2 } }, transfer: {} } as unknown as RecResult;

  // ALLOWANCE-ARCH-001 (owner, 2026-11-20): only background work waits for the allowance now, it refills by itself
  // and does not apply on Wi-Fi. The note says that, and offers to carry on at once instead of "raise it in Settings".
  it('says finding new songs is paused, that it resumes by itself, and offers to continue now', async () => {
    vi.mocked(api.last).mockResolvedValue(spentResult);
    vi.mocked(api.health).mockResolvedValue({ providers: {}, audio: {} } as never);
    render(<App />);
    const note = await screen.findByRole('note', { name: 'Finding new songs is paused' });
    expect(note.textContent).toMatch(/to save mobile data/i);
    expect(note.textContent).toMatch(/by itself/i);
    expect(note.textContent).toMatch(/never limited on Wi-Fi/i);
    expect(note.textContent).not.toMatch(/tomorrow|used up/i);
    expect(screen.queryByRole('button', { name: 'Raise the allowance in Settings' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue finding new songs now' }));
    await waitFor(() => expect(api.health).toHaveBeenCalledWith(true));
    await waitFor(() => expect(api.recommend).toHaveBeenCalled());
  });

  it('stays quiet when the sources answered', async () => {
    vi.mocked(api.last).mockResolvedValue({ ...spentResult, sources: { deezer: { state: 'ok', count: 2, ms: 3 } } } as unknown as RecResult);
    render(<App />);
    await screen.findByRole('searchbox');
    expect(screen.queryByRole('note', { name: 'Finding new songs is paused' })).toBeNull();
  });
});
