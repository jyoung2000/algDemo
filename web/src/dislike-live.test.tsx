// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { installMediaCommands } from './engine/media-native';
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
const bad = item('bad', 'Unwanted song'), good = item('good', 'Better song'), third = item('third', 'Third song');
const result = { items: [bad, good], count: 2, asked: 2, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult;
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  // The warning before removing has its own tests (confirm-remove.test.tsx); these cover what the dislike does.
  localStorage.setItem('airwave:confirm-remove', 'off');
  vi.mocked(api.last).mockResolvedValue(result);
  vi.mocked(api.feedback).mockResolvedValue({ recorded: true } as never);
  vi.mocked(api.rerank).mockResolvedValue({ ...result, items: [good], taste: { events: 1, positives: 0, negatives: 1, likes: [], avoids: [{ name: 'rage', label: 'Rage', score: -1.5, skips: 1 }], genres: [{ name: 'rage', label: 'Rage', score: -1.5, plays: 0, skips: 1 }] } } as never);
});

describe('explicit dislike immediately teaches the current queue', () => {
  it('saves the judgement before reranking, then applies the new order without a discovery run', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('dislike', expect.objectContaining({ key: 'bad' }), expect.objectContaining({ event_id: expect.any(String) })));
    await waitFor(() => expect(api.rerank).toHaveBeenCalled());
    expect(vi.mocked(api.feedback).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.rerank).mock.invocationCallOrder[0]!);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' })).toBeNull());
    expect(screen.getByText('Better song')).toBeTruthy();
  });
  it('does not rerank from unsaved feedback when the write fails', async () => {
    vi.mocked(api.feedback).mockRejectedValueOnce(new Error('Disk unavailable'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    await waitFor(() => expect(screen.getByText(/Could not save that: Disk unavailable/)).toBeTruthy());
    expect(api.rerank).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }).getAttribute('aria-pressed')).toBe('false');
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
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    await waitFor(() => expect(api.rerank).toHaveBeenCalled());
    await waitFor(() => expect(api.feedbackState).toHaveBeenCalledTimes(2));
  });
});

// REMOVE-X-001 (owner, 2026-11-24: "removing songs / the x button doesnt work"): the engine keeps a song already
// played in its answer (the history is protected), so the row used to stay, painted red. The X always takes it out.
describe('the X takes a song out of the queue even when the engine still holds it', () => {
  it('removes a row the re-rank answer still contains', async () => {
    vi.mocked(api.rerank).mockResolvedValue({ ...result, items: [bad, good], taste: null } as never);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    await waitFor(() => expect(api.rerank).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Unwanted song')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Undo dislike of Unwanted song' })).toBeNull();
    expect(screen.getByText('Better song')).toBeTruthy();
  });
  it('removes the row at once, before the engine has answered', async () => {
    vi.mocked(api.rerank).mockReturnValue(new Promise(() => {}) as never);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    await waitFor(() => expect(api.feedback).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Unwanted song')).toBeNull());
  });
  it('taking out the song playing moves on to the next one', async () => {
    const playable = (x: RecItem) => ({ ...x, playback: { kind: 'preview', preview: `https://cdn.test/${x.track.key}.mp3`, open: [] } } as unknown as RecItem);
    const both = { ...result, items: [playable(bad), playable(good)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(both);
    vi.mocked(api.rerank).mockResolvedValue({ ...both, taste: null } as never);
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Unwanted song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Unwanted song'));
    fireEvent.click(screen.getByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Better song'));
    expect(screen.queryByText('Unwanted song', { selector: 'ol.recs *' })).toBeNull();
  });  it('taking out the song playing moves on to the next one, through the confirm dialog', async () => {
    const playable = (x: RecItem) => ({ ...x, playback: { kind: 'preview', preview: `https://cdn.test/${x.track.key}.mp3`, open: [] } } as unknown as RecItem);
    const both = { ...result, items: [playable(bad), playable(good)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(both);
    vi.mocked(api.rerank).mockResolvedValue({ ...both, taste: null } as never);
    localStorage.removeItem('airwave:confirm-remove');
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Unwanted song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Unwanted song'));
    fireEvent.click(screen.getByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    fireEvent.click(await waitFor(() => { const b = document.querySelector('.confirm-remove__btn--danger'); expect(b).toBeTruthy(); return b!; }));
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Better song'));
    expect(screen.queryByText('Unwanted song', { selector: 'ol.recs *' })).toBeNull();
  });  it('taking out the last song playing goes back to the first one ready', async () => {
    const playable = (x: RecItem) => ({ ...x, playback: { kind: 'preview', preview: `https://cdn.test/${x.track.key}.mp3`, open: [] } } as unknown as RecItem);
    const both = { ...result, items: [playable(good), playable(bad)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(both);
    vi.mocked(api.rerank).mockResolvedValue({ ...both, taste: null } as never);
    localStorage.removeItem('airwave:confirm-remove');
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Unwanted song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Unwanted song'));
    fireEvent.click(screen.getByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    fireEvent.click(await waitFor(() => { const b = document.querySelector('.confirm-remove__btn--danger'); expect(b).toBeTruthy(); return b!; }));
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Better song'));
    expect(screen.queryByText('Unwanted song', { selector: 'ol.recs *' })).toBeNull();
  });  it('taking out the only song playing stops it', async () => {
    const playable = (x: RecItem) => ({ ...x, playback: { kind: 'preview', preview: `https://cdn.test/${x.track.key}.mp3`, open: [] } } as unknown as RecItem);
    const both = { ...result, items: [playable(bad)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(both);
    vi.mocked(api.rerank).mockResolvedValue({ ...both, taste: null } as never);
    localStorage.removeItem('airwave:confirm-remove');
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Unwanted song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Unwanted song'));
    fireEvent.click(screen.getByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    fireEvent.click(await waitFor(() => { const b = document.querySelector('.confirm-remove__btn--danger'); expect(b).toBeTruthy(); return b!; }));
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')).toBeNull());
    expect(container.querySelector('audio:not([paused])') === null || [...container.querySelectorAll('audio')].every((a) => a.paused)).toBe(true);
  });  it('taking out a song in the middle plays the one after it, not the first', async () => {
    const playable = (x: RecItem) => ({ ...x, playback: { kind: 'preview', preview: `https://cdn.test/${x.track.key}.mp3`, open: [] } } as unknown as RecItem);
    const both = { ...result, items: [playable(good), playable(bad), playable(third)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(both);
    vi.mocked(api.rerank).mockResolvedValue({ ...both, taste: null } as never);
    localStorage.removeItem('airwave:confirm-remove');
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Unwanted song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Unwanted song'));
    fireEvent.click(screen.getByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    fireEvent.click(await waitFor(() => { const b = document.querySelector('.confirm-remove__btn--danger'); expect(b).toBeTruthy(); return b!; }));
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Third song'));
    expect(screen.queryByText('Unwanted song', { selector: 'ol.recs *' })).toBeNull();
  });  it('taking out the only song playing stops it', async () => {
    const playable = (x: RecItem) => ({ ...x, playback: { kind: 'preview', preview: `https://cdn.test/${x.track.key}.mp3`, open: [] } } as unknown as RecItem);
    const both = { ...result, items: [playable(bad)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(both);
    vi.mocked(api.rerank).mockResolvedValue({ ...both, taste: null } as never);
    localStorage.removeItem('airwave:confirm-remove');
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Unwanted song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Unwanted song'));
    fireEvent.click(screen.getByRole('button', { name: 'Dislike Unwanted song and remove it from the queue' }));
    fireEvent.click(await waitFor(() => { const b = document.querySelector('.confirm-remove__btn--danger'); expect(b).toBeTruthy(); return b!; }));
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')).toBeNull());
    expect(container.querySelector('audio:not([paused])') === null || [...container.querySelectorAll('audio')].every((a) => a.paused)).toBe(true);
  });

});

// CAR-X-001 (owner, 2026-11-24): "ensure the X button works on android auto". The car names the song it is playing
// (which the page may not know); that song leaves the list and the one after it plays. The car's dislike alone never
// moves the music: the car's service already moved it.
describe('the car X', () => {
  beforeEach(() => { (window as unknown as { AirwaveNative?: unknown }).AirwaveNative = { media: vi.fn() }; installMediaCommands(); });
  afterEach(() => { delete (window as unknown as { AirwaveNative?: unknown }).AirwaveNative; });
  const playable = (x: RecItem) => ({ ...x, playback: { kind: 'preview', preview: `https://cdn.test/${x.track.key}.mp3`, open: [] } } as unknown as RecItem);
  const cmd = (o: unknown) => ((window as unknown as Record<string, (j: string) => void>)['__awMediaCmd'])!(JSON.stringify(o));
  it('takes out the song the car plays and plays the one after it, even when the page shows another', async () => {
    const all = { ...result, items: [playable(good), playable(bad), playable(third)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(all);
    vi.mocked(api.rerank).mockResolvedValue({ ...all, taste: null } as never);
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Better song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Better song'));
    await act(async () => { cmd({ type: 'leave', id: 'bad' }); });
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Third song'));
    expect(screen.queryByText('Unwanted song', { selector: 'ol.recs *' })).toBeNull();
  });
  it('a dislike from the car teaches but does not move the song', async () => {
    const all = { ...result, items: [playable(bad), playable(good), playable(third)] } as unknown as RecResult;
    vi.mocked(api.last).mockResolvedValue(all);
    vi.mocked(api.rerank).mockResolvedValue({ ...all, taste: null } as never);
    const { container } = render(<App />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play Unwanted song' }))[0]!);
    await waitFor(() => expect(container.querySelector('ol.recs > li.is-playing')?.textContent).toContain('Unwanted song'));
    await act(async () => { cmd({ type: 'feedback', id: 'bad', kind: 'dislike' }); });
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('dislike', expect.objectContaining({ key: 'bad' }), expect.anything()));
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('ol.recs > li.is-playing')).toBeNull();
    expect(container.querySelector('.player, .np, .dock')?.textContent ?? '').toContain('Unwanted song');
  });
});
