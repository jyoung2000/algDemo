// @vitest-environment happy-dom
/**
 * ALBUM-SEARCH-001 through the real Search box: a plain search asks for albums alongside the songs,
 * shows them as a list that opens an album, puts them first when the words name an album, and keeps
 * the songs when the album search fails.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type * as Api from './api';
import type { AlbumSearchResponse, SearchResponse, Track } from './api';

const track = (k: string, title: string, album: string | null): Track =>
  ({ key: k, title, artist: 'Ken Carson', artists: ['Ken Carson'], album, duration: 136, artwork: null, preview: null, provider: 'ytmusic', platform_id: k, url: null, release: null }) as unknown as Track;
const songs: SearchResponse = { results: [track('g', 'Green Room', 'A Great Chaos')], sources: { ytmusic: { state: 'ok', count: 1 } }, ms: 5, bytes: 0 } as unknown as SearchResponse;
const albums: AlbumSearchResponse = {
  query: 'q', sources: {},
  albums: [{ id: 'dz:1', provider: 'deezer', title: 'A Great Chaos', artist: 'Ken Carson', artwork: null, year: '2023', kind: 'album', count: 18, url: '' }],
};
const searchAlbums = vi.fn((_q: string, _s?: AbortSignal) => Promise.resolve(albums));
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return {
    ...real,
    api: { ...real.api, search: () => Promise.resolve(songs), searchLyrics: () => Promise.reject(new Error('off')), searchAlbums: (q: string, s?: AbortSignal) => searchAlbums(q, s) },
  };
});
const { Search, albumsLead } = await import('./Search');

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  searchAlbums.mockClear();
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
const order = () => [...host.querySelectorAll('[aria-label^="Albums for"], [aria-label^="Results for"]')].map((x) => (x.getAttribute('aria-label')!.startsWith('Albums') ? 'albums' : 'songs'));

it('shows the albums a search finds, and opens one', async () => {
  const open = vi.fn();
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} onOpenAlbumTarget={open} />));
  await typeAndSearch('ken carson green room');
  expect(searchAlbums).toHaveBeenCalledWith('ken carson green room', expect.anything());
  expect(order()).toEqual(['songs', 'albums']);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open the album A Great Chaos by Ken Carson"]')!.click());
  expect(open).toHaveBeenCalledWith({ id: 'dz:1' });
  // The song row's own album button opens the album that song is on.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open the album A Great Chaos"]')!.click());
  expect(open).toHaveBeenLastCalledWith({ track: songs.results[0] });
});

it('puts the albums first when the words name an album', async () => {
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} onOpenAlbumTarget={() => {}} />));
  await typeAndSearch('a great chaos');
  expect(order()).toEqual(['albums', 'songs']);
  expect(albumsLead('ken carson a great chaos', albums.albums)).toBe(true);
  expect(albumsLead('a great', albums.albums)).toBe(true);
  expect(albumsLead('green room', albums.albums)).toBe(false);
  expect(albumsLead('ch', albums.albums)).toBe(false);
});

it('keeps the songs when the album search fails, and asks for no albums without an album view', async () => {
  searchAlbums.mockRejectedValueOnce(new Error('offline'));
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} onOpenAlbumTarget={() => {}} />));
  await typeAndSearch('ken carson');
  expect(order()).toEqual(['songs']);
  await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} />));
  searchAlbums.mockClear();
  await typeAndSearch('ken carson again');
  expect(searchAlbums).not.toHaveBeenCalled();
});
