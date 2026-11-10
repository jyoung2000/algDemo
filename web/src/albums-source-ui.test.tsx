// @vitest-environment happy-dom
/**
 * ALBUM-SEARCH-002 in the UI. Owner: "can we add album search for soundcloud and youtubr music". Each
 * album row and album page says which service it came from; a SoundCloud set uploaded by someone other
 * than the artist says so.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Api from './api';
import type { AlbumSummary, AlbumView as AlbumData, Track } from './api';

const albumCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, album: (a: unknown) => albumCall(a), playlistEdit: vi.fn() } };
});
const { AlbumShelf, AlbumView, albumSource } = await import('./Albums');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const albums: AlbumSummary[] = [
  { id: 'yt:MPREb_h61jplJoXNf', provider: 'ytmusic', title: 'X', artist: 'Ken Carson', artwork: null, year: '2022', kind: 'album', count: null, url: '' },
  { id: 'sc:1843556490', provider: 'soundcloud', title: 'A Great Chaos (Deluxe)', artist: 'Ken Carson', artwork: null, year: '2024', kind: 'album', count: 25, url: '', official: true },
  { id: 'sc:1918477227', provider: 'soundcloud', title: 'A Great Chaos Unreleased', artist: 'Ken Carson!', artwork: null, year: '2024', kind: 'album', count: 5, url: '', official: false },
];
const song = (k: string, title: string): Track =>
  ({ key: k, title, artist: 'Ken Carson', artists: ['Ken Carson'], album: 'X', album_id: 'yt:MPREb_h61jplJoXNf', duration: 150, artwork: null, preview: null, provider: 'ytmusic', platform_id: k, release: null, tags: [] }) as unknown as Track;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  albumCall.mockReset();
});

it('names the service each album came from, and marks a fan upload', async () => {
  await act(async () => root.render(<AlbumShelf albums={albums} query="ken carson" onOpen={() => {}} />));
  const metas = [...host.querySelectorAll('.album-row .track__meta')].map((m) => m.textContent);
  expect(metas).toEqual(['Album · 2022 · YouTube Music', 'Album · 2024 · 25 songs · SoundCloud', 'Album · 2024 · 5 songs · SoundCloud fan upload']);
  // On a phone the line wraps before "· YouTube Music" as one piece, never inside it.
  expect([...host.querySelectorAll('.album-row__src')].map((x) => x.textContent)).toEqual(['· YouTube Music', '· SoundCloud', '· SoundCloud fan upload']);
  expect(albumSource({ provider: 'deezer' })).toBe('Deezer');
  expect(albumSource({ provider: 'apple' })).toBe('Apple Music');
});

it('says on the album page where the album is from', async () => {
  const full: AlbumData = { ...albums[0]!, count: 2, tracks: [song('a', 'Yale'), song('b', 'Fighting My Demons')], duration: 300, genres: [] };
  albumCall.mockResolvedValue({ album: full });
  await act(async () => root.render(<AlbumView target={{ id: full.id }} onBack={() => {}} onPreview={() => {}} onLists={() => {}} seedKeys={new Set()} onAdd={() => {}} playingKey={null} />));
  await act(async () => undefined);
  expect(albumCall).toHaveBeenCalledWith({ id: 'yt:MPREb_h61jplJoXNf' });
  const src = host.querySelector('.album__src');
  expect(src?.textContent?.trim()).toBe('From YouTube Music');
  expect(src?.querySelector('svg')).toBeTruthy();
  expect([...host.querySelectorAll('.tracks .track__title')].map((x) => x.textContent)).toEqual(['Yale', 'Fighting My Demons']);
});

it('says a SoundCloud set by someone else is a fan upload, in plain words', async () => {
  const fan: AlbumData = { ...albums[2]!, tracks: [song('c', 'blk')], duration: 127, genres: [] };
  albumCall.mockResolvedValue({ album: fan });
  await act(async () => root.render(<AlbumView target={{ id: fan.id }} onBack={() => {}} onPreview={() => {}} onLists={() => {}} seedKeys={new Set()} onAdd={() => {}} playingKey={null} />));
  await act(async () => undefined);
  expect(host.querySelector('.album__src')?.textContent?.trim()).toBe('Fan upload on SoundCloud');
});

it('lays the album row’s line out as text, so it wraps between words, not into columns', async () => {
  // .track__meta is a flex row elsewhere; there the service name became its own column at 320 px
  // and "30 songs" split across lines (served-surface gate, 2026-11-10).
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8').replace(/\r/g, '');
  const rule = /\.album-row \.track__meta \{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(rule).toMatch(/display: block;/);
  expect(rule).toMatch(/white-space: normal;/);
  expect(/\.album-row__src \{([^}]*)\}/.exec(css)?.[1]).toMatch(/white-space: nowrap;/);
});
