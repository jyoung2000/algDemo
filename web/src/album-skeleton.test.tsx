// @vitest-environment happy-dom
/**
 * ALBUM-SKELETON-001 (owner, 2026-11-19): "add a skeleton loader to the album pages".
 * While an album opens, the page shows its own shape (cover, title lines, the action pills and song rows) with one
 * status label, instead of a sentence; the loaded page then develops into focus where the skeleton stood.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Api from './api';
import type { AlbumView as AlbumData, Track } from './api';

let resolveAlbum: (a: { album: AlbumData }) => void = () => {};
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, album: () => new Promise<{ album: AlbumData }>((r) => { resolveAlbum = r; }) } };
});
const { AlbumView } = await import('./Albums');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const song = (k: string): Track =>
  ({ key: k, title: `Song ${k}`, artist: 'Ken Carson', artists: ['Ken Carson'], album: 'Lost Files', duration: 150, artwork: null, preview: null, provider: 'deezer', platform_id: k, release: null, tags: [] }) as unknown as Track;
const album: AlbumData = { id: 'dz:2', provider: 'deezer', title: 'Lost Files', artist: 'Ken Carson', artwork: null, year: '2019', kind: 'ep', count: 2, url: '', tracks: [song('a'), song('b')], duration: 300, genres: [] } as unknown as AlbumData;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

function mount(): HTMLDivElement {
  const host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(AlbumView, { target: { id: 'dz:2', title: 'Lost Files', artist: 'Ken Carson' } as never, onBack: () => {}, onPreview: () => {}, seedKeys: new Set<string>(), onAdd: () => {} } as never)));
  return host;
}

it('shows the album page’s own shape while it loads, labelled once for screen readers', () => {
  const host = mount();
  const status = host.querySelector('.album-skel[role="status"]');
  expect(status).not.toBeNull();
  expect(status!.getAttribute('aria-label')).toBe('Opening the album…');
  // Cover the size of the real one, the kind/title/artist/meta lines, the action pills and song rows.
  const cover = host.querySelector('.album-skel .skel--art') as HTMLElement;
  expect(cover.style.width).toBe('112px');
  expect(host.querySelectorAll('.album-skel .album__head .skel--line').length).toBe(4);
  expect(host.querySelectorAll('.album-skel .album__actions .skel--pill').length).toBe(3);
  expect(host.querySelectorAll('.album-skel .skel-list .skel-row').length).toBeGreaterThanOrEqual(5);
  // No sentence-only loader, and every placeholder shape is hidden from screen readers.
  expect(host.querySelector('.sdot--busy')).toBeNull();
  expect(host.querySelector('section')!.getAttribute('aria-busy')).toBe('true');
});

it('the loaded album develops in where the skeleton stood', async () => {
  const host = mount();
  await act(async () => { resolveAlbum({ album }); await Promise.resolve(); });
  expect(host.querySelector('.album-skel')).toBeNull();
  expect(host.querySelector('.skel-develop .album__title')?.textContent).toBe('Lost Files');
  expect(host.querySelector('section')!.getAttribute('aria-busy')).toBe('false');
});
