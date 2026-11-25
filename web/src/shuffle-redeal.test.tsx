// @vitest-environment happy-dom
/**
 * WP5 (S8): the App wiring behind the tail re-deal. A star or a dislike (learnFeedback) arms an active signal, and the
 * next mood answer re-deals the unheard tail of the Discover queue's shuffled order; a song finishing is a passive
 * signal and never re-deals on its own. The engine side of the same rule is engine/shuffle-redeal.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { FeedbackKind, MoodAnswer, RecItem, RecResult, Track } from './api';
import type { ListenTelemetry } from './Player';
import { api } from './api';
import { App } from './App';
import { resetShuffleNextForTests } from './util';

// Sixteen songs, sixteen artists: ARTIST-RUN-001 and the WP4 artist rule never have to move a song here, so a change
// in the shown order is the re-deal and nothing else.
const letters = 'abcdefghijklmnop'.split('');
const tracks = letters.map((key, i) => ({ key, title: key.toUpperCase(), artists: [`Artist ${i}`], provider: 'deezer', platform_id: key, preview: `/fixture/${key}`, tags: [] } as unknown as Track));
const rows = tracks.map((track, i) => ({ track, rank: i + 1, reasons: [], playback: { preview: track.preview, embed: null, open: [] }, characteristics: {} } as unknown as RecItem));
vi.mock('./engine/downloads', async orig => ({ ...await orig<typeof import('./engine/downloads')>(), downloadsAvailable: () => false }));
vi.mock('./engine/queue-audio', () => ({ queueAudio: {
  subscribe: () => () => {}, expiredKeys: () => new Set<string>(), cardOf: () => null,
  isReady: () => false, readyUrl: () => null, sourceHint: () => null,
} }));
vi.mock('./QueuePreparation', () => ({ QueuePreparation: () => null }));
vi.mock('./ListDownloadBar', () => ({ ListDownloadBar: () => null, ListDownloadButton: () => null, ListFolderButton: () => null, ListLoadedNote: () => null }));
vi.mock('./api', async orig => {
  const real = await orig<typeof import('./api')>();
  return { ...real, api: { ...real.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn().mockResolvedValue({ state: {}, events: 0, taste: null }), last: vi.fn(),
    playlists: vi.fn().mockResolvedValue({ lists: [] }), saved: vi.fn().mockResolvedValue({ items: [] }),
    impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
    mood: vi.fn(), feedback: vi.fn().mockResolvedValue({}),
    // A hand-made queue has no discovery pool to re-rank; both callers handle that and the shown order stands.
    rerank: vi.fn().mockRejectedValue(new Error('no pool')),
  } };
});
vi.mock('./Player', () => ({ Player: (p: { playing: { track: Track } | null; upNext: { key: string }[]; onNext: () => void; canNext: boolean; onListen: (k: 'complete', t: Track, s: number, m: ListenTelemetry) => void }) => <div>
  <output data-testid="current">{p.playing?.track.key ?? '-'}</output>
  <output data-testid="upnext">{p.upNext.map(x => x.key).join(',')}</output>
  <button onClick={p.onNext} disabled={!p.canNext}>Fixture Next</button>
  <button onClick={() => p.playing && p.onListen('complete', p.playing.track, 180, { instance: 1, medium: 'preview', coverage: 1, duration: 180 } as unknown as ListenTelemetry)}>Fixture Finished</button>
</div> }));
vi.mock('./SavedView', () => ({ SavedView: () => null }));
vi.mock('./Search', async orig => ({ ...await orig<typeof import('./Search')>(), Search: () => null }));
vi.mock('./Results', async orig => ({ ...await orig<typeof import('./Results')>(), Results: (p: { onPlay: (r: RecItem) => void; onFeedback: (r: RecItem, kind: FeedbackKind) => Promise<void>; items?: RecItem[] }) => {
  const shown = p.items?.length ? p.items : rows;
  return <div>
    <output data-testid="shown">{shown.map(x => x.track.key).join(',')}</output>
    {shown.map(r => <span key={r.track.key}>
      <button onClick={() => p.onPlay(r)}>Queue {r.track.key}</button>
      <button onClick={() => void p.onFeedback(r, 'like')}>Star {r.track.key}</button>
      <button onClick={() => void p.onFeedback(r, 'dislike')}>Remove {r.track.key}</button>
    </span>)}
  </div>;
} }));

const shown = () => screen.getByTestId('shown').textContent!.split(',').filter(Boolean);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
/** The songs still to come in the order the queue shows: everything after the song playing. */
const tailOf = (order: string[], playing: string) => order.slice(order.indexOf(playing) + 1);
const plan = (fit: Record<string, number>): MoodAnswer => ({ order: [], changed: false, moved: [], leading: [], confidence: 1, fit });
/** An answer that says every song fits the mood equally: a mood that leans on nothing. */
const even = () => plan(Object.fromEntries(letters.map(k => [k, 0.5])));
/** An answer that turns the tail over: the back half now fits, the front half does not (a change well over 0.15). */
const turned = (tail: string[]) => plan(Object.fromEntries(tail.map((k, i) => [k, i < Math.floor(tail.length / 2) ? 0 : 1])));

const MOOD_WAIT = 2500;
/** Wait for the next /api/mood answer to have been asked for and applied. */
const nextAnswer = async (answer: MoodAnswer) => {
  const before = vi.mocked(api.mood).mock.calls.length;
  vi.mocked(api.mood).mockResolvedValue(answer);
  await waitFor(() => expect(vi.mocked(api.mood).mock.calls.length).toBeGreaterThan(before), { timeout: MOOD_WAIT });
  // The answer lands in a promise callback; let the re-render and the shuffle effect that follows it run.
  await waitFor(async () => { await new Promise(r => setTimeout(r, 20)); }, { timeout: MOOD_WAIT });
};

beforeEach(() => {
  vi.clearAllMocks(); resetShuffleNextForTests(); localStorage.clear();
  localStorage.setItem('airwave.shuffle', 'on');
  vi.mocked(api.last).mockResolvedValue({ items: rows, count: rows.length, asked: rows.length, phase: 'final', sources: {}, transfer: {} } as unknown as RecResult);
  vi.mocked(api.mood).mockResolvedValue(even());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

/** Start the Discover queue on `key` and settle the first mood answer, which may itself re-deal once (WP5 step 3). */
const start = async (key: string) => {
  render(<App />);
  await waitFor(() => expect(api.feedbackState).toHaveBeenCalled());
  await screen.findByRole('button', { name: `Queue ${key}` });
  await new Promise(r => setTimeout(r, 0));
  click(`Queue ${key}`);
  expect(screen.getByTestId('current').textContent).toBe(key);
  await nextAnswer(even());
};

describe('WP5 (S8): a star or a dislike makes the next mood answer re-deal the unheard tail', () => {
  it('a star, then a mood answer: the unheard tail is dealt again, the song playing and the next two stay', async () => {
    await start('a');
    const before = shown();
    const tailBefore = tailOf(before, 'a');
    expect(tailBefore.length).toBeGreaterThan(4);
    click('Star c');
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('like', expect.objectContaining({ key: 'c' }), expect.anything()));
    await nextAnswer(turned(tailBefore));
    const after = shown();
    const tailAfter = tailOf(after, 'a');
    expect(after[0]).toBe('a');
    expect(tailAfter.slice(0, 2)).toEqual(tailBefore.slice(0, 2));
    expect(tailAfter).not.toEqual(tailBefore);
    expect([...tailAfter].sort()).toEqual([...tailBefore].sort());
  });

  it('a dislike works the same way (the removed song aside)', async () => {
    await start('a');
    const tailBefore = tailOf(shown(), 'a');
    const gone = tailBefore[tailBefore.length - 1]!;
    click(`Remove ${gone}`);
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('dislike', expect.objectContaining({ key: gone }), expect.anything()));
    await nextAnswer(turned(tailBefore));
    const tailAfter = tailOf(shown(), 'a');
    expect(tailAfter).not.toEqual(tailBefore.filter(k => k !== gone));
    expect(tailAfter).not.toContain(gone);
  });

  it('a song finishing is a passive signal: the mood answer after it keeps the order', async () => {
    await start('a');
    const tailBefore = tailOf(shown(), 'a');
    click('Fixture Finished');
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith('complete', expect.objectContaining({ key: 'a' }), expect.anything()));
    await nextAnswer(turned(tailBefore));
    const tailAfter = tailOf(shown(), screen.getByTestId('current').textContent!);
    expect(tailAfter).toEqual(tailBefore.filter(k => tailAfter.includes(k)));
  });
});
