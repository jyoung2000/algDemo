// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { SearchResponse, Track } from './api';
import type * as Api from './api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// happy-dom gives import.meta.url a non-file scheme, so read from the package root vitest runs in.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

/**
 * SRC-REFRESH-001. The owner: "add a button to quick refresh sources". A source marked unavailable in
 * the search list only means that one request failed, and the search keeps each answer for five
 * minutes, so typing the words again showed the same failure. The button asks every source again,
 * straight away, for the words on screen, and the list stays (dimmed) until the new answer lands.
 */
const track = (k: string): Track =>
  ({ key: k, title: `Song ${k}`, artist: 'Ken Carson', artists: ['Ken Carson'], album: null, duration: 136, artwork: null, preview: null,
    provider: 'ytmusic', platform_id: k, url: null, release: null }) as unknown as Track;

const answers: SearchResponse[] = [];
const search = vi.fn((_q: string, _s?: AbortSignal) => Promise.resolve(answers.shift()!));
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, search: (q: string, s?: AbortSignal) => search(q, s), searchLyrics: () => Promise.reject(new Error('off')) } };
});
const { Search } = await import('./Search');

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  search.mockClear();
  answers.length = 0;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const typeAndSearch = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
};
const refresh = () => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh sources"]');
const line = () => host.querySelector('.srcline')?.textContent ?? '';

it('asks every source again for the same words, past the five-minute memory', async () => {
  answers.push(
    { query: 'k', results: [track('a')], sources: { ytmusic: { state: 'ok', count: 1 }, deezer: { state: 'failed', detail: 'HTTP 503' } }, ms: 10, bytes: 0 } as unknown as SearchResponse,
    { query: 'k', results: [track('a'), track('b')], sources: { ytmusic: { state: 'ok', count: 1 }, deezer: { state: 'ok', count: 1 } }, ms: 10, bytes: 0 } as unknown as SearchResponse,
  );
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  await typeAndSearch('Ken Carson');
  expect(line()).toMatch(/Deezer · unavailable/);
  const b = refresh()!;
  expect(b).toBeTruthy();
  expect(b.title).toBe('Ask every source again');
  // Beside the wrapping labels, not among them: inside, the 44px button made its wrapped row taller than the rest.
  expect(b.closest('.srcline__items')).toBeNull();
  expect(b.parentElement!.querySelector(':scope > .srcline__items')).toBeTruthy();
  await act(async () => {
    b.click();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(search).toHaveBeenCalledTimes(2);
  expect(search.mock.calls[1]![0]).toBe('Ken Carson');
  expect(line()).toMatch(/Deezer · 1/);
  expect(host.querySelectorAll('ul.tracks li.track')).toHaveLength(2);
});

it('offers the same refresh when a short run found nothing at all', async () => {
  answers.push(
    { query: 'k', results: [], sources: { ytmusic: { state: 'failed', detail: 'offline' }, deezer: { state: 'failed', detail: 'offline' } }, ms: 10, bytes: 0 } as unknown as SearchResponse,
    { query: 'k', results: [track('a')], sources: { ytmusic: { state: 'ok', count: 1 }, deezer: { state: 'ok', count: 0 } }, ms: 10, bytes: 0 } as unknown as SearchResponse,
  );
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  await typeAndSearch('Ken Carson');
  expect(host.textContent).toMatch(/try again in a moment/i);
  await act(async () => {
    refresh()!.click();
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(search).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll('ul.tracks li.track')).toHaveLength(1);
});

it('is a 44px round icon button, busy while the sources are being asked', async () => {
  let release!: (r: SearchResponse) => void;
  answers.push({ query: 'k', results: [track('a')], sources: { ytmusic: { state: 'ok', count: 1 } }, ms: 10, bytes: 0 } as unknown as SearchResponse);
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  await typeAndSearch('Ken Carson');
  search.mockImplementationOnce(() => new Promise<SearchResponse>((r) => { release = r; }));
  const b = refresh()!;
  expect(b.className).toMatch(/iconbtn/);
  await act(async () => b.click());
  expect(refresh()!.getAttribute('aria-busy')).toBe('true');
  expect(refresh()!.disabled).toBe(true);
  expect(host.querySelectorAll('ul.tracks li.track')).toHaveLength(1);
  await act(async () => {
    release({ query: 'k', results: [track('a')], sources: { ytmusic: { state: 'ok', count: 1 } }, ms: 10, bytes: 0 } as unknown as SearchResponse);
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(refresh()!.getAttribute('aria-busy')).toBe('false');
});

it('draws the button as a full 44px target and dims the list on screen while it works', () => {
  const rule = /\.srcline__refresh \{([^}]*)\}/.exec(css)![1]!;
  expect(rule).toMatch(/width: 36px/);
  expect(rule).toMatch(/height: 36px/);
  expect(rule).toMatch(/border: 4px solid transparent/);
  expect(rule).toMatch(/box-sizing: content-box/);
  // The title results sit in their own wrapper: a child selector (.is-refreshing > .tracks) never dimmed them.
  expect(css).toMatch(/\.is-refreshing \.tracks,\s*\.is-refreshing \.srcline \{\s*opacity: 0\.55/);
  expect(css).not.toMatch(/\.is-refreshing > \.tracks/);
});

/**
 * SRC-BUDGET-001. Owner: say the allowance was all used up. Sources refused because today's download
 * allowance is spent read as such, one line says why and how to change it, and the refresh is not
 * offered, because asking again cannot help until tomorrow or a higher allowance.
 */
it('says the allowance is all used up, offers Settings, and no refresh', async () => {
  const openSettings = vi.fn();
  answers.push({ query: 'k', results: [track('a')], sources: { ytmusic: { state: 'budget' }, deezer: { state: 'budget' }, spotify: { state: 'ok', count: 1 } }, ms: 10, bytes: 0 } as unknown as SearchResponse);
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} onOpenSettings={openSettings} />));
  await typeAndSearch('Ken Carson');
  expect(line()).toMatch(/YouTube Music · allowance used up/);
  expect(line()).toMatch(/Deezer · allowance used up/);
  expect(line()).toMatch(/Spotify · 1/);
  expect(host.textContent).toMatch(/Today’s download allowance is all used up/);
  expect(refresh()).toBeNull();
  const go = host.querySelector<HTMLButtonElement>('button[aria-label="Raise the allowance in Settings"]')!;
  expect(go).toBeTruthy();
  await act(async () => go.click());
  expect(openSettings).toHaveBeenCalled();
});

it('still offers the refresh when only some failures are the allowance', async () => {
  answers.push({ query: 'k', results: [track('a')], sources: { ytmusic: { state: 'budget' }, deezer: { state: 'failed', detail: 'HTTP 503' } }, ms: 10, bytes: 0 } as unknown as SearchResponse);
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  await typeAndSearch('Ken Carson');
  expect(refresh()).toBeTruthy();
  expect(host.textContent).toMatch(/all used up/);
});

it('says the allowance is used up, not "try again", when nothing could be searched', async () => {
  answers.push({ query: 'k', results: [], sources: { ytmusic: { state: 'budget' }, deezer: { state: 'budget' } }, ms: 10, bytes: 0 } as unknown as SearchResponse);
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} onOpenSettings={() => {}} />));
  await typeAndSearch('Ken Carson');
  expect(host.textContent).toMatch(/Today’s download allowance is all used up/);
  expect(host.textContent).not.toMatch(/try again in a moment/i);
  expect(refresh()).toBeNull();
  expect(host.querySelector('button[aria-label="Raise the allowance in Settings"]')).toBeTruthy();
});
