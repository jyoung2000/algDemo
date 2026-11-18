// RADIO-ART-003: the passive re-pull schedule — fast first retry, bounded backoff in seconds,
// one pending attempt per id, and a hard stop after a few attempts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundRetry, RETRY_DELAYS } from './radio';

describe('BackgroundRetry (RADIO-ART-003)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries fast first, then backs off on the bounded schedule and stops', () => {
    expect(RETRY_DELAYS[0]).toBeLessThanOrEqual(1000); // fast first retry
    expect(Math.max(...RETRY_DELAYS)).toBeLessThanOrEqual(30000); // seconds, never minutes
    const runs: number[] = []; const start = Date.now();
    const r = new BackgroundRetry(() => runs.push(Date.now() - start));
    for (let i = 0; i < RETRY_DELAYS.length; i++) { expect(r.ask('st')).toBe(true); vi.runAllTimers(); }
    expect(runs).toEqual([500, 3000, 8000, 23000]); // cumulative: 500/2500/5000/15000 gaps
    expect(r.ask('st')).toBe(false); // spent: no further background pulls
    vi.runAllTimers();
    expect(runs).toHaveLength(RETRY_DELAYS.length);
  });

  it('keeps one pending attempt per id; asking again while pending is a no-op', () => {
    const run = vi.fn(); const r = new BackgroundRetry(run);
    expect(r.ask('a')).toBe(true);
    expect(r.ask('a')).toBe(true);
    vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('settle cancels the pending attempt and forgets the history so a later gap starts fresh', () => {
    const run = vi.fn(); const r = new BackgroundRetry(run);
    r.ask('a'); r.settle('a'); vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
    for (let i = 0; i < RETRY_DELAYS.length; i++) { r.ask('a'); vi.runAllTimers(); }
    expect(r.ask('a')).toBe(false);
    r.settle('a'); // the data arrived; a later gap begins a new schedule
    expect(r.ask('a')).toBe(true);
    r.stop();
  });

  it('stop cancels everything', () => {
    const run = vi.fn(); const r = new BackgroundRetry(run);
    r.ask('a'); r.ask('b'); r.stop(); vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
  });
});
