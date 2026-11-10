// @vitest-environment happy-dom
/**
 * ALBUM-SAVE-001 in the UI. Owner: "let users save albums to the saved section like playlist". The album
 * view saves (and un-saves) the album; Saved shows albums in their own row beside the lists, and an album
 * opens there like a list: play it, play it as the queue, open the full album, remove it. An album keeps
 * its own name and songs, so it has no Rename, no per-song remove, and never shows in the like menu.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Api from './api';
import type { AlbumView as AlbumData, PlaylistSummary, Track } from './api';

const albumCall = vi.fn();
const editCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return {
    ...real,
    api: { ...real.api, album: (a: unknown) => albumCall(a), playlistEdit: (...a: unknown[]) => editCall(...a), playlistMix: () => new Promise(() => {}) },
  };
});
const { AlbumView } = await import('./Albums');
const { SavedView } = await import('./SavedView');
const { SaveMenu } = await import('./SaveMenu');
const { addTargetOf } = await import('./engine/queue-context');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const song = (k: string, title: string): Track =>
  ({ key: k, title, artist: 'Ken Carson', artists: ['Ken Carson'], album: 'Lost Files', duration: 150, artwork: null, preview: null, provider: 'deezer', platform_id: k, release: null, tags: [] }) as unknown as Track;
const tracks = [song('a', 'First'), song('b', 'Second')];
const full: AlbumData = { id: 'dz:2', provider: 'deezer', title: 'Lost Files', artist: 'Ken Carson', artwork: 'https://cdn/l.jpg', year: '2019', kind: 'ep', count: 2, url: 'https://www.deezer.com/album/2', tracks, duration: 300, genres: [] };
const ref = { id: 'dz:2', provider: 'deezer', artist: 'Ken Carson', artwork: 'https://cdn/l.jpg', year: '2019', kind: 'ep', url: 'https://www.deezer.com/album/2' };
const albumList: PlaylistSummary = {
  id: 'A1', name: 'Lost Files', created: 1, count: 2, unplayed: 2, discovery_ready: false, album: ref,
  items: tracks.map((t) => ({ key: t.key, added: 1, track: t, played: false })),
};
const ownList: PlaylistSummary = { id: 'P1', name: 'Late night', created: 1, count: 0, unplayed: 0, discovery_ready: false, album: null, items: [] };

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
const byText = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(t));
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it('saves the open album to Saved, and takes it out again', async () => {
  albumCall.mockResolvedValue({ album: full });
  editCall.mockResolvedValue({ lists: [albumList] });
  const onLists = vi.fn();
  const view = (lists: PlaylistSummary[]) => <AlbumView target={{ id: 'dz:2' }} onBack={() => {}} onPreview={() => {}} lists={lists} onLists={onLists} seedKeys={new Set()} onAdd={() => {}} />;
  await draw(view([ownList]));
  await act(async () => undefined);
  const save = byText('Save album')!;
  expect(save.getAttribute('aria-pressed')).toBe('false');
  await act(async () => save.click());
  expect(editCall).toHaveBeenCalledWith('save_album', { album: full });
  expect(onLists).toHaveBeenCalledWith([albumList]);
  expect(host.textContent).toContain('Saved. Find it in Saved, under Albums.');
  // With the album among the lists the button says so, and pressing it again removes the album.
  await draw(view([ownList, albumList]));
  const saved = byText('Saved')!;
  expect(saved.getAttribute('aria-pressed')).toBe('true');
  expect(saved.getAttribute('aria-label')).toBe('Saved. Remove Lost Files from Saved');
  editCall.mockResolvedValue({ lists: [ownList] });
  await act(async () => saved.click());
  expect(editCall).toHaveBeenLastCalledWith('delete', { id: 'A1' });
});

it('shows saved albums in their own row in Saved, and opens one like a list', async () => {
  const play = vi.fn();
  const openId = vi.fn();
  const queue = vi.fn();
  editCall.mockResolvedValue({ lists: [ownList] });
  await draw(<SavedView saved={[]} lists={[ownList, albumList]} onLists={() => {}} onPreview={play} onRemoveSaved={() => {}} onUseAsQueue={queue} onOpenAlbumId={openId} />);
  const lists = host.querySelector('[aria-label="Your saved lists"]')!;
  const albums = host.querySelector('[aria-label="Your saved albums"]')!;
  expect(lists.textContent).toContain('Late night');
  expect(lists.textContent).not.toContain('Lost Files');
  expect(albums.textContent).toContain('Lost Files');
  expect(albums.textContent).toContain('Ken Carson');
  await act(async () => button('Lost Files by Ken Carson, 2 songs')!.click());
  // The album's songs in album order; it keeps its own name and songs.
  expect([...host.querySelectorAll('.tracks--saved .track__title')].map((x) => x.textContent)).toEqual(['First', 'Second']);
  expect(host.querySelector('.lists__bar')!.textContent).toContain('EP · Ken Carson · 2019');
  expect(byText('Rename')).toBeUndefined();
  expect(button('Remove First from Lost Files')).toBeNull();
  await act(async () => byText('Play album')!.click());
  expect(play).toHaveBeenCalledWith(tracks[0], 'A1');
  await act(async () => byText('Play as my queue')!.click());
  expect(queue).toHaveBeenCalledWith('A1');
  await act(async () => byText('Open album')!.click());
  expect(openId).toHaveBeenCalledWith('dz:2');
  await act(async () => byText('Remove album')!.click());
  expect(editCall).toHaveBeenCalledWith('delete', { id: 'A1' });
});

it('brings a pressed chip fully into its sideways row, in both rows', async () => {
  const seen: Element[] = [];
  const spy = vi.fn(function (this: Element) { seen.push(this); });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: spy, configurable: true });
  try {
    await draw(<SavedView saved={[]} lists={[ownList, albumList]} onLists={() => {}} onPreview={() => {}} onRemoveSaved={() => {}} />);
    await act(async () => button('Lost Files by Ken Carson, 2 songs')!.click());
    expect(seen.at(-1)).toBe(button('Lost Files by Ken Carson, 2 songs'));
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ inline: 'nearest', block: 'nearest' }));
    const own = [...host.querySelectorAll('[aria-label="Your saved lists"] button')].find((b) => /Late night/.test(b.textContent ?? ''))!;
    await act(async () => (own as HTMLButtonElement).click());
    expect(seen.at(-1)).toBe(own);
  } finally {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

it('never offers a saved album in the like menu, or as where an added song goes', async () => {
  await draw(<SaveMenu songKey="x" title="X" lists={[ownList, albumList]} onLists={() => {}} onClose={() => {}} />);
  expect(host.textContent).toContain('Late night');
  expect(host.textContent).not.toContain('Lost Files');
  // Playing from a saved album, or with it as the queue, an added song goes to the now playing queue.
  expect(addTargetOf('A1', null, [ownList, albumList])).toEqual({ kind: 'queue' });
  expect(addTargetOf(null, { id: 'A1', name: 'Lost Files' }, [ownList, albumList])).toEqual({ kind: 'queue' });
  expect(addTargetOf('P1', null, [ownList, albumList])).toEqual({ kind: 'list', id: 'P1', name: 'Late night', seed: false });
});
