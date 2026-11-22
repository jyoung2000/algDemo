// @vitest-environment happy-dom
/**
 * SPEED-DATA-001 (owner, 2026-11-21: "On data search and song downloads, artis pages, and albums load way to slow").
 * Measured on the emulator with a cold cache: Deezer answered a search in 1.07 s and YouTube Music in 1.4 s, but the
 * rows appeared at 3.2-3.6 s, because the one search request waited for every service, and SoundCloud and Spotify
 * first download megabytes of script to get their keys. The quick services' rows now show as soon as they answer;
 * the slow ones join the same list when they do.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type * as Api from './api';
import type { SearchResponse, Track } from './api';

const track = (k: string, title: string, provider: string): Track =>
  ({ key: k, title, artist: 'OsamaSon', artists: ['OsamaSon'], album: null, duration: 136, artwork: null, preview: null, provider, platform_id: k, url: null, release: null }) as unknown as Track;
const quick: SearchResponse = { results: [track('osamason|habits', 'Habits', 'deezer')], sources: { deezer: { state: 'ok', count: 1 }, ytmusic: { state: 'ok', count: 0 }, apple: { state: 'ok', count: 0 } }, ms: 900, bytes: 0 } as unknown as SearchResponse;
const slowAnswer: SearchResponse = { results: [track('osamason|habits', 'Habits', 'soundcloud'), track('osamason|withdrawal', 'Withdrawal', 'soundcloud')], sources: { soundcloud: { state: 'ok', count: 2 }, spotify: { state: 'ok', count: 0 } }, ms: 3000, bytes: 0 } as unknown as SearchResponse;
let releaseSlow: (() => void) | null = null;
const asked: string[][] = [];
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return {
    ...real,
    api: {
      ...real.api,
      search: (_q: string, _s?: AbortSignal, sources: readonly string[] = []) => {
        asked.push([...sources]);
        if (sources.includes('soundcloud')) return new Promise<SearchResponse>((r) => { releaseSlow = () => r(slowAnswer); });
        return Promise.resolve(quick);
      },
      searchLyrics: () => Promise.reject(new Error('off')),
    },
  };
});
const { Search } = await import('./Search');

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { asked.length = 0; releaseSlow = null; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const rows = () => [...host.querySelectorAll('[aria-label^="Results for"] .track .track__title, [aria-label^="Results for"] .track [class*="title"]')].map((n) => n.textContent?.trim()).filter(Boolean);

it('shows the quick services’ rows before SoundCloud and Spotify answer, then adds theirs once', async () => {
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  const input = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'osamason');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(asked.map((s) => s.join(','))).toEqual(expect.arrayContaining(['ytmusic,deezer,apple', 'soundcloud,spotify']));
  expect(host.textContent).toContain('Habits');
  expect(host.textContent).not.toContain('Withdrawal');
  await act(async () => { releaseSlow!(); await new Promise((r) => setTimeout(r, 20)); });
  expect(host.textContent).toContain('Withdrawal');
  // The song both halves found is listed once.
  const titles = [...host.querySelectorAll('[aria-label^="Results for"] li')].map((li) => li.textContent ?? '').filter((t) => t.includes('Habits'));
  expect(titles.length).toBe(1);
  void rows;
});
