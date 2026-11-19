// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SearchResponse, Track } from './api';
import type * as Api from './api';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/**
 * SRC-AUTO-001 (owner, 2026-11-19): "ensure refreshing sources works and does it automatically if any
 * sources go out". A source that failed is asked again on its own (only that source), twice at most.
 */
const track = (k: string, provider = 'ytmusic'): Track =>
  ({ key: k, title: `Song ${k}`, artist: 'Ken Carson', artists: ['Ken Carson'], album: null, duration: 136, artwork: null, preview: null,
    provider, platform_id: k, url: null, release: null }) as unknown as Track;
const answers: SearchResponse[] = [];
const search = vi.fn((_q: string, _s?: AbortSignal, _src?: readonly string[]) => Promise.resolve(answers.shift()!));
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, search: (q: string, s?: AbortSignal, src?: readonly string[]) => search(q, s, src), searchLyrics: () => Promise.reject(new Error('off')), genres: () => Promise.resolve({ items: {} }) } };
});
const { Search } = await import('./Search');

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); search.mockClear(); answers.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

const typeAndSearch = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await vi.advanceTimersByTimeAsync(20); });
};
const line = () => host.querySelector('.srcline')?.textContent ?? '';
const ans = (results: Track[], sources: Record<string, unknown>) => ({ query: 'k', results, sources, ms: 10, bytes: 0 }) as unknown as SearchResponse;

it('asks a source that went out again by itself, only that source, and adds what it brings', async () => {
  answers.push(
    ans([track('a')], { ytmusic: { state: 'ok', count: 1 }, deezer: { state: 'failed', detail: 'HTTP 503' } }),
    ans([track('d', 'deezer')], { deezer: { state: 'ok', count: 1 } }),
  );
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  await typeAndSearch('Ken Carson');
  expect(line()).toMatch(/Deezer · unavailable/);
  const before = search.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
  expect(search.mock.calls.length).toBe(before + 1);
  expect(search.mock.calls.at(-1)![2]).toEqual(['deezer']);
  expect(line()).toMatch(/Deezer · 1/);
  expect(host.querySelectorAll('ul.tracks li.track')).toHaveLength(2);
});

it('stops after two tries when the source stays out, and never retries a source out of allowance', async () => {
  const out = ans([track('a')], { ytmusic: { state: 'ok', count: 1 }, deezer: { state: 'failed' }, apple: { state: 'budget' } });
  answers.push(out, ans([], { deezer: { state: 'failed' } }), ans([], { deezer: { state: 'failed' } }), ans([], { deezer: { state: 'failed' } }));
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  await typeAndSearch('Ken Carson');
  const before = search.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
  await act(async () => { await vi.advanceTimersByTimeAsync(12100); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(search.mock.calls.length).toBe(before + 2);
  for (const c of search.mock.calls.slice(before)) expect(c[2]).toEqual(['deezer']);
});
