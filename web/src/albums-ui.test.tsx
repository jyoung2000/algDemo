// @vitest-environment happy-dom
/**
 * ALBUM-SEARCH-001 / ALBUM-OPEN-001 in the UI. Owner: "add a feature or button to search albums ... open
 * albums like i would playlist or song list ... a button on the individual song listing that lets you
 * see / open the full album if the song is from an album, ep, mixtape or long body of work".
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import type * as Api from './api';
import type { AlbumSummary, AlbumView as AlbumData, Track } from './api';

const albumCall = vi.fn();
const editCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, album: (a: unknown) => albumCall(a), playlistEdit: (...a: unknown[]) => editCall(...a) } };
});
const { TrackList } = await import('./Search');
const { AlbumShelf, AlbumView } = await import('./Albums');
const { Results } = await import('./Results');
const { SavedView } = await import('./SavedView');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const song = (k: string, title: string, album: string | null): Track =>
  ({ key: k, title, artist: 'Ken Carson', artists: ['Ken Carson'], album, duration: 150, artwork: null, preview: null, provider: 'deezer', platform_id: k, release: null, tags: [] }) as unknown as Track;
const onAlbum = song('g', 'Green Room', 'A Great Chaos');
const single = song('r', 'Rock N Roll', 'Rock N Roll');
const albums: AlbumSummary[] = [
  { id: 'dz:1', provider: 'deezer', title: 'A Great Chaos', artist: 'Ken Carson', artwork: null, year: '2023', kind: 'album', count: 18, url: '' },
  { id: 'dz:2', provider: 'deezer', title: 'Lost Files', artist: 'Ken Carson', artwork: null, year: '2019', kind: 'ep', count: 5, url: '' },
  { id: 'ap:3', provider: 'apple', title: 'Project X', artist: 'Ken Carson', artwork: null, year: '2021', kind: 'mixtape', count: 15, url: '' },
  { id: 'dz:4', provider: 'deezer', title: 'Teen X', artist: 'Ken Carson', artwork: null, year: '2018', kind: 'album', count: 12, url: '' },
];
const full: AlbumData = { ...albums[1]!, tracks: [song('a', 'First', 'Lost Files'), song('b', 'Second', 'Lost Files')], duration: 300, genres: ['Rap/Hip Hop'] };

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
  editCall.mockReset();
});
const draw = async (el: React.ReactElement) => act(async () => root.render(el));
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(t));

it('opens albums and same-title singles from album text beneath the search song title', async () => {
  const open = vi.fn();
  const play = vi.fn();
  await draw(<TrackList tracks={[onAlbum, single]} seedKeys={new Set()} onAdd={() => {}} onPreview={play} label="Results" onOpenAlbum={open} />);
  const rows = [...host.querySelectorAll('.track')];
  for (const [i, track] of [onAlbum, single].entries()) {
    const row = rows[i]!;
    const text = row.querySelector('.track__text')!;
    const album = text.querySelector<HTMLButtonElement>('button.song-credits__album');
    expect(album).toBeTruthy();
    expect(album!.textContent).toBe(track.album);
    expect(album!.classList.contains('iconbtn')).toBe(false);
    expect(album!.querySelector('svg')).toBeNull();
    expect(row.querySelector('.track__actions [aria-label^="Open the album"]')).toBeNull();
    expect(row.querySelector('.album-gap')).toBeNull();
    expect(text.textContent!.indexOf(track.album!)).toBeLessThan(text.textContent!.lastIndexOf('Ken Carson'));
    await act(async () => album!.click());
    expect(open).toHaveBeenLastCalledWith(track);
  }
  expect(open).toHaveBeenCalledTimes(2);
  expect(play).not.toHaveBeenCalled();
});

it('lists albums found by a search, opens one, and folds a long list', async () => {
  const open = vi.fn();
  await draw(<AlbumShelf albums={albums} query="ken carson" onOpen={open} />);
  const rows = [...host.querySelectorAll('[aria-label="Albums for ken carson"] li')];
  expect(rows).toHaveLength(3);
  expect(rows[1]!.textContent).toContain('EP · 2019 · 5 songs');
  expect(rows[2]!.textContent).toContain('Mixtape');
  await act(async () => button('Open the album Lost Files by Ken Carson')!.click());
  expect(open).toHaveBeenCalledWith(albums[1]);
  await act(async () => byText('Show all 4 albums')!.click());
  expect(host.querySelectorAll('[aria-label="Albums for ken carson"] li')).toHaveLength(4);
});

it('opens an album like a list: its songs in order, played as one list, and saved', async () => {
  albumCall.mockResolvedValue({ album: full });
  editCall.mockResolvedValue({ lists: [{ id: 'L9', name: 'Lost Files', count: 2 }] });
  const play = vi.fn();
  const lists = vi.fn();
  const back = vi.fn();
  await draw(<AlbumView target={{ id: 'dz:2' }} onBack={back} onPreview={play} onLists={lists} seedKeys={new Set()} onAdd={() => {}} playingKey="b" />);
  await act(async () => undefined);
  expect(albumCall).toHaveBeenCalledWith({ id: 'dz:2' });
  expect(host.querySelector('h2')!.textContent).toBe('Lost Files');
  // Focus moves into the album, and its songs do not repeat the album on every row.
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Back');
  expect(host.querySelector('.tracks .track__meta')).toBeNull();
  expect(host.textContent).toContain('EP');
  expect(host.textContent).toContain('2019 · 2 songs · 5 min');
  const titles = [...host.querySelectorAll('.tracks .track__title')].map((x) => x.textContent);
  expect(titles).toEqual(['First', 'Second']);
  expect([...host.querySelectorAll('.tracks .track__num')].map((x) => x.textContent)).toEqual(['1', '2']);
  // The song playing is marked in the album, as the queue marks it.
  expect([...host.querySelectorAll('.tracks .track')].map((li) => li.getAttribute('aria-current'))).toEqual([null, 'true']);
  expect(host.querySelectorAll('.tracks .track.is-playing')).toHaveLength(1);
  // Songs on this album do not offer to open the album they are already in.
  expect(host.querySelector('button[aria-label^="Open the album"]')).toBeNull();
  await act(async () => byText('Play album')!.click());
  expect(play).toHaveBeenCalledWith(full.tracks[0], full.tracks);
  // ALBUM-SAVE-001 replaced “Save as a list”: the album is saved as an album (saved-albums-ui.test.tsx).
  await act(async () => byText('Save album')!.click());
  expect(editCall).toHaveBeenCalledWith('save_album', { album: full });
  expect(lists).toHaveBeenCalledWith([{ id: 'L9', name: 'Lost Files', count: 2 }]);
  await act(async () => button('Back')!.click());
  expect(back).toHaveBeenCalled();
});

it('opens the album of a song, and says so plainly when none is found', async () => {
  const { ApiError } = await import('./api');
  albumCall.mockRejectedValue(new ApiError('No album for this song was found on Deezer or Apple Music.', 404, { code: 'none' }));
  await draw(<AlbumView target={{ track: onAlbum }} onBack={() => {}} onPreview={() => {}} seedKeys={new Set()} onAdd={() => {}} />);
  await act(async () => undefined);
  expect(albumCall).toHaveBeenCalledWith({ track: onAlbum });
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('No album for this song was found');
});

it('opens albums from text credits in queue and saved rows, including singles', async () => {
  const open = vi.fn();
  const item = { rank: 1, track: onAlbum, score: 1, coverage: 1, tier: 'core', evidence: 'strong', best_seed: null, reasons: [], uncertainty: [], new_release: false, factors: {}, weights: {}, sources: [], playback: { preview: null, embed: null, open: [] } };
  await draw(createElement(Results, {
    seeds: [], onRemoveSeed: () => {}, onEmphasis: () => {}, items: [item] as never, focusKey: null, playingKey: null, flags: {},
    onFocus: () => {}, onPlay: () => {}, onPlayTrack: () => {}, onFeedback: () => {}, onOpenAlbum: open,
  }));
  const queueAlbum = host.querySelector<HTMLButtonElement>('.rec__text button.song-credits__album');
  expect(queueAlbum?.textContent).toBe('A Great Chaos');
  await act(async () => queueAlbum!.click());
  expect(open).toHaveBeenCalledWith(onAlbum);
  open.mockReset();
  await draw(<SavedView saved={[{ track: onAlbum, ts: 1 }, { track: single, ts: 2 }] as never} lists={[]} onLists={() => {}} onPreview={() => {}} onRemoveSaved={() => {}} onOpenAlbum={open} />);
  const savedAlbums = [...host.querySelectorAll<HTMLButtonElement>('.track__text button.song-credits__album')];
  expect(savedAlbums.map((b) => b.textContent)).toEqual(['A Great Chaos', 'Rock N Roll']);
  for (const b of savedAlbums) await act(async () => b.click());
  expect(open.mock.calls).toEqual([[onAlbum], [single]]);
});
