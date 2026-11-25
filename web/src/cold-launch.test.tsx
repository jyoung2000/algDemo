// @vitest-environment happy-dom
/**
 * SESSION-RESET-001 cold launch: the launch check runs at module load, so each case re-imports App with the
 * storage it needs already in place. A fresh launch must not throw, must keep or reset the play counts by the
 * stop marker's age, and must leave the marker consumed when it starts a new session.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_LIMIT_MS, SESSION_STOPPED_KEY } from './engine/session';
import { SESSION_PLAYS_KEY } from './engine/session-state';

vi.mock('./api', async (orig) => {
  const actual = await orig<typeof import('./api')>();
  return { ...actual, api: { ...actual.api,
    seeds: vi.fn().mockResolvedValue({ seeds: [] }), settings: vi.fn().mockResolvedValue(null),
    feedbackState: vi.fn(), feedback: vi.fn().mockResolvedValue({ recorded: true }),
    last: vi.fn(), playlists: vi.fn().mockResolvedValue({ lists: [] }), saved: vi.fn().mockResolvedValue({ items: [] }),
    impressions: vi.fn().mockResolvedValue({ recorded: 0 }),
    rerank: vi.fn(), mood: vi.fn(), health: vi.fn(() => new Promise(() => {})), status: vi.fn(() => new Promise(() => {})),
  }};
});

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);

/** Fresh module graph (so the module-load launch check runs again), storage seeded, then App mounted. */
async function coldLaunch(seed: Record<string, string>, lastRejects = false) {
  localStorage.clear();
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v);
  vi.resetModules();
  const { api } = await import('./api');
  vi.mocked(api.feedbackState).mockResolvedValue({ state: {}, events: 0, taste: null } as never);
  if (lastRejects) vi.mocked(api.last).mockRejectedValue(new Error('offline'));
  else vi.mocked(api.last).mockResolvedValue({ items: [], count: 0, asked: 0, phase: 'final', sources: {}, transfer: {} } as never);
  const { App } = await import('./App');
  const { render, cleanup, waitFor } = await import('@testing-library/react');
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
  window.addEventListener('error', onError);
  const stop = () => { window.removeEventListener('error', onError); cleanup(); };
  try {
    render(<App />);
    await waitFor(() => expect(vi.mocked(api.feedbackState)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
  } catch (e) {
    stop();
    throw e;
  }
  return { errors, cleanup: stop };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });
// Warm the module graph once so the per-case re-imports below are not dominated by the first transform.
beforeAll(async () => { await import('./App'); }, 60_000);



// The mount path's radio restore asks the native bridge for its state. A browser has no bridge, so the honest
// answer is "no native session". Only that one URL is answered here; every other request is left untouched.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/radio-native')) {
      return Promise.resolve(new Response(JSON.stringify({ native: false }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

describe('cold launch', () => {
  it('empty storage: no error, plays written as an empty map', async () => {
    const { errors, cleanup } = await coldLaunch({});
    expect(errors).toEqual([]);
    expect(localStorage.getItem(SESSION_PLAYS_KEY)).toBe('{}');
    cleanup();
  });

  it('stopped more than four minutes ago: counts reset and the marker is consumed', async () => {
    const stopped = NOW - IDLE_LIMIT_MS - 1000;
    const { errors, cleanup } = await coldLaunch({ [SESSION_STOPPED_KEY]: String(stopped), [SESSION_PLAYS_KEY]: '{"x":2}' });
    expect(errors).toEqual([]);
    expect(localStorage.getItem(SESSION_PLAYS_KEY)).toBe('{}');
    expect(localStorage.getItem(SESSION_STOPPED_KEY)).toBe(String(NOW));
    cleanup();
  });

  it('exactly four minutes: same session, counts survive', async () => {
    const stopped = NOW - IDLE_LIMIT_MS;
    const { errors, cleanup } = await coldLaunch({ [SESSION_STOPPED_KEY]: String(stopped), [SESSION_PLAYS_KEY]: '{"x":2}' });
    expect(errors).toEqual([]);
    expect(localStorage.getItem(SESSION_PLAYS_KEY)).toBe('{"x":2}');
    cleanup();
  });

  it('stopped a minute ago: counts survive', async () => {
    const { errors, cleanup } = await coldLaunch({ [SESSION_STOPPED_KEY]: String(NOW - 60_000), [SESSION_PLAYS_KEY]: '{"x":2}' });
    expect(errors).toEqual([]);
    expect(localStorage.getItem(SESSION_PLAYS_KEY)).toBe('{"x":2}');
    cleanup();
  });

  it('killed while idle: a launch that is not fresh refreshes the marker to this launch', async () => {
    const { errors, cleanup } = await coldLaunch({ [SESSION_STOPPED_KEY]: String(NOW - 60_000), [SESSION_PLAYS_KEY]: '{"x":2}' });
    expect(errors).toEqual([]);
    expect(localStorage.getItem(SESSION_STOPPED_KEY)).toBe(String(NOW));
    cleanup();
  });

  it('a malformed stop marker is ignored and does not throw', async () => {
    const { errors, cleanup } = await coldLaunch({ [SESSION_STOPPED_KEY]: 'not-a-time', [SESSION_PLAYS_KEY]: '{"x":2}' });
    expect(errors).toEqual([]);
    expect(localStorage.getItem(SESSION_PLAYS_KEY)).toBe('{"x":2}');
    cleanup();
  });

  it('a corrupt plays value is read as empty and does not throw', async () => {
    const { errors, cleanup } = await coldLaunch({ [SESSION_PLAYS_KEY]: '{not json' });
    expect(errors).toEqual([]);
    expect(localStorage.getItem(SESSION_PLAYS_KEY)).toBe('{}');
    cleanup();
  });

  it('a rejected last-queue request leaves the app mounted without an error', async () => {
    const { errors, cleanup } = await coldLaunch({}, true);
    expect(errors).toEqual([]);
    cleanup();
  });
});
