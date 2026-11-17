// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type * as Api from './api';
import type { RecItem, RecResult } from './api';
import type { GenreAnswer } from './useQueueGenres';

/**
 * GENRE-LOAD-001 — owner: "ensure genre & sub genre tags load on both apps".
 *
 * The queue asks the engine for the genres of its rows that have none, a few at a time, until nothing is
 * left to ask. It asks only when there is something to ask, never during a discovery run, and it stops
 * when the engine says nothing more can be found, so it can never loop.
 */
const genresCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, queueGenres: () => genresCall() } };
});
const { useQueueGenres, mergeGenres, rowPlaced } = await import('./useQueueGenres');

const row = (key: string, genres: string[] = []): RecItem =>
  ({ rank: 1, track: { key, title: key, tags: [] }, ...(genres.length ? { characteristics: { genres, family: null } } : {}) }) as unknown as RecItem;
const result = (...items: RecItem[]): RecResult => ({ phase: 'final', items, count: items.length }) as unknown as RecResult;
const answer = (key: string, genres: string[]) => ({ key, tags: [{ name: genres[0]!.toLowerCase(), label: genres[0]! }], characteristics: { genres, family: 'Pop', subgenre: null } }) as unknown as GenreAnswer;
afterEach(() => { cleanup(); genresCall.mockReset(); });

function mount(first: RecResult | null, running = false) {
  return renderHook(({ busy }: { busy: boolean }) => {
    const [r, setR] = useState<RecResult | null>(first);
    useQueueGenres(r, busy, setR);
    return { r, setR };
  }, { initialProps: { busy: running } });
}

describe('rowPlaced / mergeGenres', () => {
  it('counts a row as placed once it names a genre or a family', () => {
    expect(rowPlaced(row('a'))).toBe(false);
    expect(rowPlaced(row('a', ['Pop']))).toBe(true);
    expect(rowPlaced({ ...row('a'), characteristics: { genres: [], family: 'Pop' } } as unknown as RecItem)).toBe(true);
  });

  it('puts the engine\u2019s answer on its row and leaves every other row untouched', () => {
    const before = result(row('a'), row('b', ['Rock']));
    const after = mergeGenres(before, [answer('a', ['Pop'])]);
    expect(after.items[0]!.characteristics?.genres).toEqual(['Pop']);
    expect(after.items[0]!.track.tags).toEqual([{ name: 'pop', label: 'Pop' }]);
    expect(after.items[1]).toBe(before.items[1]);
    // Nothing to change: the same object, so nothing redraws.
    expect(mergeGenres(before, [])).toBe(before);
    expect(mergeGenres(before, [answer('zzz', ['Pop'])])).toBe(before);
  });
});

describe('the queue asks for the genres it lacks (GENRE-LOAD-001)', () => {
  it('asks, shows the answer, and asks again while songs are left', async () => {
    genresCall.mockResolvedValueOnce({ items: [answer('a', ['Pop'])], left: 1 }).mockResolvedValueOnce({ items: [answer('b', ['Soul'])], left: 0 });
    const h = mount(result(row('a'), row('b')));
    await waitFor(() => expect(h.result.current.r!.items.map((x) => x.characteristics?.genres)).toEqual([['Pop'], ['Soul']]));
    expect(genresCall).toHaveBeenCalledTimes(2);
  });

  it('asks about a row whose only genre is a guess, and stops if the guess is all there is', async () => {
    const guessed = { ...row('a', ['pop']), track: { key: 'a', title: 'a', tags: [{ name: 'pop', inferred: true }] } } as unknown as RecItem;
    expect(rowPlaced(guessed)).toBe(false);
    genresCall.mockResolvedValue({ items: [], left: 0 });
    mount(result(guessed));
    await waitFor(() => expect(genresCall).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(genresCall).toHaveBeenCalledTimes(1);
  });

  it('asks about a row the engine says a lookup can still improve, even though it has a genre (GENRE-ALL-001)', async () => {
    const pending = { ...row('a', ['Pop']), characteristics: { genres: ['Pop'], family: 'Pop', subgenre: null, genre_pending: true } } as unknown as RecItem;
    expect(rowPlaced(pending)).toBe(false);
    expect(rowPlaced(row('b', ['Pop']))).toBe(true);
    genresCall.mockResolvedValue({ items: [], left: 0 });
    mount(result(pending));
    await waitFor(() => expect(genresCall).toHaveBeenCalledTimes(1));
  });

  it('takes the engine\u2019s word that a row is done, replacing the pending mark', () => {
    const pending = { ...row('a', ['Pop']), characteristics: { genres: ['Pop'], family: 'Pop', subgenre: null, genre_pending: true } } as unknown as RecItem;
    const done = mergeGenres(result(pending), [{ key: 'a', tags: [{ name: 'pop', label: 'Pop' }], characteristics: { genres: ['Pop'], family: 'Pop', subgenre: null, styles: ['Sophisti-pop'], fill: [] } } as unknown as GenreAnswer]);
    expect(done.items[0]!.characteristics!.genre_pending).toBeUndefined();
    expect(done.items[0]!.characteristics!.styles).toEqual(['Sophisti-pop']);
  });

  it('asks nothing when every row has its genres, or there is no queue', async () => {
    mount(result(row('a', ['Pop'])));
    mount(null);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(genresCall).not.toHaveBeenCalled();
  });

  it('waits for a discovery run to finish', async () => {
    genresCall.mockResolvedValue({ items: [answer('a', ['Pop'])], left: 0 });
    const h = mount(result(row('a')), true);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(genresCall).not.toHaveBeenCalled();
    h.rerender({ busy: false });
    await waitFor(() => expect(genresCall).toHaveBeenCalledTimes(1));
  });

  it('keeps asking while the engine has songs left, even when a batch placed none', async () => {
    genresCall.mockResolvedValueOnce({ items: [], left: 3 }).mockResolvedValueOnce({ items: [answer('a', ['Pop'])], left: 0 });
    const h = mount(result(row('a')));
    await waitFor(() => expect(h.result.current.r!.items[0]!.characteristics?.genres).toEqual(['Pop']));
    expect(genresCall).toHaveBeenCalledTimes(2);
  });

  it('stops when nothing more can be found, when the allowance is spent, and when the request fails', async () => {
    for (const reply of [{ items: [], left: 0 }, { items: [], left: 4, spent: true }, new Error('offline')]) {
      genresCall.mockReset();
      if (reply instanceof Error) genresCall.mockRejectedValue(reply); else genresCall.mockResolvedValue(reply);
      const h = mount(result(row('a')));
      await waitFor(() => expect(genresCall).toHaveBeenCalledTimes(1));
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      expect(genresCall).toHaveBeenCalledTimes(1);
      h.unmount();
    }
  });

  it('asks again when a new song with no genre joins the queue', async () => {
    genresCall.mockResolvedValue({ items: [], left: 0 });
    const h = mount(result(row('a')));
    await waitFor(() => expect(genresCall).toHaveBeenCalledTimes(1));
    genresCall.mockResolvedValue({ items: [answer('new', ['Jazz'])], left: 0 });
    act(() => h.result.current.setR(result(row('a'), row('new'))));
    await waitFor(() => expect(h.result.current.r!.items[1]!.characteristics?.genres).toEqual(['Jazz']));
  });
});
