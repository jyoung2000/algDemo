// @vitest-environment happy-dom
// ALLOWANCE-ARCH-001: when the engine says background look-ups are paused to save mobile data, the queue asks again
// by itself at the time the engine named, rather than waiting for the queue to change (or for tomorrow).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type * as Api from './api';
import type { RecItem, RecResult } from './api';

const genresCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, queueGenres: () => genresCall() } };
});
const { useQueueGenres } = await import('./useQueueGenres');

const row = (key: string): RecItem => ({ rank: 1, track: { key, title: key, tags: [] } }) as unknown as RecItem;
const result = (...items: RecItem[]): RecResult => ({ phase: 'final', items, count: items.length }) as unknown as RecResult;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-20T18:00:00Z')); });
afterEach(() => { cleanup(); genresCall.mockReset(); vi.useRealTimers(); });

function mount() {
  return renderHook(() => {
    const [r, setR] = useState<RecResult | null>(result(row('a'), row('b')));
    useQueueGenres(r, false, setR);
    return r;
  });
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

describe('paused look-ups resume by themselves', () => {
  it('asks again when the engine said it would resume, not before', async () => {
    const at = Date.now() / 1000 + 600;
    genresCall.mockResolvedValueOnce({ items: [], left: 2, spent: true, resumes_at: at }).mockResolvedValue({ items: [], left: 0 });
    mount();
    await flush();
    expect(genresCall).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(590_000); });
    await flush();
    expect(genresCall).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(15_000); });
    await flush();
    expect(genresCall).toHaveBeenCalledTimes(2);
  });
  it('a stop with no time named waits for the queue to change, as before', async () => {
    genresCall.mockResolvedValue({ items: [], left: 2, spent: true });
    mount();
    await flush();
    await act(async () => { vi.advanceTimersByTime(3_600_000); });
    await flush();
    expect(genresCall).toHaveBeenCalledTimes(1);
  });
  it('never waits less than half a minute or more than half an hour', async () => {
    genresCall.mockResolvedValueOnce({ items: [], left: 2, spent: true, resumes_at: Date.now() / 1000 + 1 }).mockResolvedValueOnce({ items: [], left: 2, spent: true, resumes_at: Date.now() / 1000 + 86_400 }).mockResolvedValue({ items: [], left: 0 });
    mount();
    await flush();
    await act(async () => { vi.advanceTimersByTime(20_000); });
    await flush();
    expect(genresCall).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(11_000); });
    await flush();
    expect(genresCall).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(30 * 60_000 + 1000); });
    await flush();
    expect(genresCall).toHaveBeenCalledTimes(3);
  });
});
