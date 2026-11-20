// @vitest-environment happy-dom
// RADIO-FIRST-START-001: on the phone the first station after an install waits while the bundled decoder unpacks.
// The page gave up at 15s and showed "signal is aborted without reason" while the native player went on to play.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { radioNative, radioNativeTimeout } from './radio-client';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('native radio request time limits', () => {
  it('start waits long enough for the decoder to unpack; lookups 20s; other calls 15s', () => {
    expect(radioNativeTimeout('start')).toBe(60000);
    expect(radioNativeTimeout('request')).toBe(20000);
    expect(radioNativeTimeout('metadata')).toBe(20000);
    expect(radioNativeTimeout('state')).toBe(15000);
  });

  it('a start answered after 30s still succeeds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_u: string, init: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('signal is aborted without reason')));
      setTimeout(() => resolve({ ok: true, json: async () => ({ id: 'x', state: 'buffering', error: null }) }), 30000);
    }));
    const p = radioNative({ op: 'start', url: 'https://example.org/s' });
    await vi.advanceTimersByTimeAsync(30001);
    await expect(p).resolves.toMatchObject({ id: 'x' });
  });
});
