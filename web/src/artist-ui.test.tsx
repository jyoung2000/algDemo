// @vitest-environment happy-dom
/**
 * ARTIST-PAGE-001 in the UI. Owner: "can we add artist pages where we can see all of an artist songs
 * and albums".
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type * as Api from './api';
import type { AlbumSummary, ArtistView as ArtistData, Track } from './api';

const artistCall = vi.fn();
const songsCall = vi.fn();
const albumCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, artist: (a: unknown) => artistCall(a), artistSongs: (a: unknown) => songsCall(a), album: (a: unknown) => albumCall(a) } };
});
const { ArtistView, ArtistNames, artistTargetsOf, namesArtist, SONGS_FOLDED } = await import('./Artists');
const { AlbumView } = await import('./Albums');
const { TrackList } = await import('./Search');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const song = (k: string, title: string, artists = ['Ken Carson']): Track =>
  ({ key: k, title, artist: artists.join(', '), artists, album: 'A Great Chaos', duration: 150, artwork: null, preview: null, provider: 'deezer', platform_id: k, release: null, tags: [], artist_ids: { deezer: '2568121' } }) as unknown as Track;
const album = (id: string, title: string, kind: AlbumSummary['kind'], year: string): AlbumSummary => ({ id, provider: 'deezer', title, artist: 'Ken Carson', artwork: null, year, kind, count: 10, url: '' });
const popular = Array.from({ length: 14 }, (_, i) => song(`p${i}`, `Popular ${i + 1}`));
const view: ArtistData = {
  id: 'dz:2568121', name: 'Ken Carson', picture: null, detail: '4.47M monthly audience', songs: popular,
  albums: [album('dz:1', 'xperiment', 'album', '2026'), album('dz:2', 'A Great Chaos', 'album', '2023'), album('dz:3', 'Teen X : Relapsed', 'ep', '2021')],
  singles: [album('dz:4', 'Possession', 'single', '2026')],
  links: { deezer: 'https://www.deezer.com/artist/2568121' }, sources: { deezer: { state: 'ok', count: 14 }, ytmusic: { state: 'ok', count: 0 } },
};
const every = [...popular, song('x1', 'Deep Cut One'), song('x2', 'Deep Cut Two')];

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
  artistCall.mockReset();
  songsCall.mockReset();
  albumCall.mockReset();
});
const draw = async (el: React.ReactElement) => act(async () => root.render(el));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(t));
const titles = (label: string) => [...host.querySelectorAll(`ul[aria-label="${label}"] .track__title`)].map((x) => x.textContent?.trim());
const page = (extra: Record<string, unknown> = {}) => (
  <ArtistView target={{ id: 'dz:2568121', name: 'Ken Carson' }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} {...extra} />
);

it('names each artist on a song as its own button; the first carries the song\u2019s artist id', async () => {
  expect(artistTargetsOf(song('a', 'deaf note', ['Ken Carson', 'Playboi Carti']))).toEqual([
    { name: 'Ken Carson', target: { id: 'dz:2568121', name: 'Ken Carson' } },
    { name: 'Playboi Carti', target: { name: 'Playboi Carti' } },
  ]);
  expect(artistTargetsOf({ ...song('b', 'x', ['Unknown artist']), artist_ids: {} } as never)).toEqual([{ name: 'Unknown artist', target: null }]);
  const open = vi.fn();
  await draw(<ArtistNames track={song('a', 'deaf note', ['Ken Carson', 'Playboi Carti'])} onOpen={open} />);
  expect(host.querySelector('.track__artist')!.textContent).toBe('Ken Carson, Playboi Carti');
  await act(async () => button('Open the artist Playboi Carti')!.click());
  expect(open).toHaveBeenCalledWith({ name: 'Playboi Carti' });
});

it('makes the artist on every song row a way to the artist page', async () => {
  const open = vi.fn();
  await draw(<TrackList tracks={[song('a', 'overseas')]} seedKeys={new Set()} onAdd={() => {}} onPreview={() => {}} label="Results" onOpenArtist={open} />);
  await act(async () => button('Open the artist Ken Carson')!.click());
  expect(open).toHaveBeenCalledWith({ id: 'dz:2568121', name: 'Ken Carson' });
});

it('opens on the most played songs, then offers every song once they are found', async () => {
  artistCall.mockResolvedValue({ artist: view });
  let release: (v: unknown) => void = () => {};
  songsCall.mockReturnValue(new Promise((r) => (release = r)));
  await draw(page());
  await flush();
  expect(host.querySelector('#artist-h')!.textContent).toBe('Ken Carson');
  expect(document.activeElement).toBe(button('Back'));
  expect(titles('Songs by Ken Carson')).toHaveLength(SONGS_FOLDED);
  expect(host.textContent).toContain('Most played');
  expect(host.textContent).toContain('Finding every song on Ken Carson\u2019s albums and singles');
  expect(songsCall).toHaveBeenCalledWith({ id: 'dz:2568121', name: 'Ken Carson' });

  await act(async () => { release({ songs: every, opened: 4, failed: 0 }); });
  await flush();
  expect(host.textContent).not.toContain('Finding every song');
  expect(host.querySelector('.album__meta')!.textContent).toBe('4.47M monthly audience · 16 songs · 3 albums');
  await act(async () => byText('Show all 16 songs')!.click());
  expect(titles('Songs by Ken Carson')).toEqual(every.map((t) => t.title));
  expect(host.textContent).toContain('All songs');
});

it('plays the whole list from its first song', async () => {
  artistCall.mockResolvedValue({ artist: view });
  songsCall.mockResolvedValue({ songs: every, opened: 4, failed: 0 });
  const play = vi.fn();
  await draw(page({ onPreview: play }));
  await flush();
  await act(async () => byText('Play songs')!.click());
  expect(play).toHaveBeenCalledWith(every[0], every);
});

it('lists albums and EPs apart from singles, and each opens as an album page', async () => {
  artistCall.mockResolvedValue({ artist: view });
  songsCall.mockResolvedValue({ songs: every, opened: 4, failed: 0 });
  const openAlbum = vi.fn();
  await draw(page({ onOpenAlbum: openAlbum }));
  await flush();
  const names = (label: string) => [...host.querySelectorAll(`ul[aria-label="${label}"] .track__title`)].map((x) => x.textContent);
  expect(names('Albums by Ken Carson')).toEqual(['xperiment', 'A Great Chaos', 'Teen X : Relapsed']);
  expect(names('Singles by Ken Carson')).toEqual(['Possession']);
  await act(async () => button('Open the album A Great Chaos by Ken Carson')!.click());
  expect(openAlbum).toHaveBeenCalledWith(view.albums[1]);
});

it('says so when only the most played songs could be listed, or some albums could not be read', async () => {
  artistCall.mockResolvedValue({ artist: view });
  songsCall.mockRejectedValue(new Error('offline'));
  await draw(page());
  await flush();
  expect(host.textContent).toContain('Only the most played songs could be listed');
  expect(byText('Show all 14 most played')).toBeTruthy();

  await act(async () => root.unmount());
  root = createRoot(host);
  songsCall.mockResolvedValue({ songs: every, opened: 4, failed: 2 });
  await draw(page());
  await flush();
  expect(host.textContent).toContain('2 albums could not be read, so their songs may be missing');
});

it('explains a failure to open, in words', async () => {
  const real = await vi.importActual<typeof Api>('./api');
  artistCall.mockRejectedValue(new real.ApiError('No artist named \u201cNobody\u201d was found on Deezer or YouTube Music.', 404, null));
  await draw(page());
  await flush();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('No artist named \u201cNobody\u201d was found');
});

it('opens the album artist\u2019s page from the album page, but not for Various Artists', async () => {
  const open = vi.fn();
  albumCall.mockResolvedValue({ album: { ...view.albums[1]!, tracks: [song('a', 'Green Room')], duration: 150, genres: [] } });
  await draw(<AlbumView target={{ id: 'dz:2' }} onBack={() => {}} onPreview={() => {}} seedKeys={new Set()} onAdd={() => {}} onOpenArtist={open} />);
  await flush();
  await act(async () => button('Open the artist Ken Carson')!.click());
  expect(open).toHaveBeenCalledWith({ name: 'Ken Carson' });

  await act(async () => root.unmount());
  root = createRoot(host);
  albumCall.mockResolvedValue({ album: { ...view.albums[1]!, artist: 'Various Artists', tracks: [song('a', 'Green Room')], duration: 150, genres: [] } });
  await draw(<AlbumView target={{ id: 'dz:9' }} onBack={() => {}} onPreview={() => {}} seedKeys={new Set()} onAdd={() => {}} onOpenArtist={open} />);
  await flush();
  expect(button('Open the artist Various Artists')).toBeNull();
});

it('shows an artist in a search only when the words are that artist\u2019s name', () => {
  expect(namesArtist('ken carson', { name: 'Ken Carson' })).toBe(true);
  expect(namesArtist('  BEYONCE ', { name: 'Beyonc\u00e9' })).toBe(true);
  expect(namesArtist('Tyler, The Creator', { name: 'Tyler The Creator' })).toBe(true);
  expect(namesArtist('ken carson overseas', { name: 'Ken Carson' })).toBe(false);
  expect(namesArtist('', { name: 'Ken Carson' })).toBe(false);
});

it('keeps artist names whole and their hit area out of the layout (CSS)', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8').replace(/\r/g, '');
  const rule = (sel: string) => new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[2] ?? '';
  expect(rule('.artistlink')).toMatch(/overflow-wrap: anywhere/);
  expect(rule('.artistlink')).toMatch(/margin: -6px 0;[\s\S]*padding: 6px 0/);
  expect(rule('.artistlink:focus-visible')).toMatch(/outline: 2px solid/);
  expect(rule('.artistlink--head')).toMatch(/min-height: 44px/);
  expect(rule('.artist__part')).toMatch(/white-space: nowrap/);
  expect(css).toMatch(/@media \(max-width: 480px\) \{\n {2}\.artist \.album__head \.artist-pic \.art \{\n {4}width: 72px !important;/);
});
