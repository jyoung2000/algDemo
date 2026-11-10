/**
 * ALBUM-SAVE-001. Owner: "let users save albums to the saved section like playlist". A saved album is a
 * list that carries the album it came from: it plays, queues, downloads and shows in the car like a list,
 * but it keeps the album's name and songs, is found again by the album's id (saving twice changes
 * nothing), never takes songs from the like menu, and does not count against the listener's own lists.
 */
import { expect, it } from 'vitest';

import {
  ALBUMS_MAX, PLAYLISTS_MAX, PlaylistError, addToPlaylists, createPlaylist, parsePlaylists, renamePlaylist, saveAlbum,
  type AlbumRef, type Playlist,
} from './playlists';

const REF: AlbumRef = { id: 'dz:498395131', provider: 'deezer', artist: 'Ken Carson', artwork: 'https://cdn/c.jpg', year: '2023', kind: 'album', url: 'https://www.deezer.com/album/498395131' };

it('saves an album as a list holding its songs in album order, once', () => {
  const one = saveAlbum([], { ...REF, title: 'A Great Chaos' }, ['a', 'b', 'a', 'c'], 10, 'L1');
  expect(one).toEqual([{ id: 'L1', name: 'A Great Chaos', created: 10, album: REF, entries: [{ key: 'a', added: 10 }, { key: 'b', added: 10 }, { key: 'c', added: 10 }] }]);
  // Saving the same album again (by id) changes nothing, whatever the name.
  expect(saveAlbum(one, { ...REF, title: 'Other name' }, ['z'], 99, 'L2')).toBe(one);
});

it('keeps an album apart from the listener\u2019s own lists', () => {
  // An album may share a name with a list, in either order.
  const withList = createPlaylist([], 'A Great Chaos', 1, 'P');
  const both = saveAlbum(withList, { ...REF, title: 'A Great Chaos' }, ['a'], 2, 'L');
  expect(both.map((l) => l.id)).toEqual(['P', 'L']);
  const albumFirst = saveAlbum([], { ...REF, title: 'Late night' }, ['a'], 1, 'L');
  expect(createPlaylist(albumFirst, 'Late night', 2, 'P').map((l) => l.name)).toEqual(['Late night', 'Late night']);
  // The like menu cannot put songs into an album, and an album keeps its own name.
  expect(addToPlaylists(both, ['L', 'P'], 'x', 3).find((l) => l.id === 'L')!.entries.map((e) => e.key)).toEqual(['a']);
  expect(addToPlaylists(both, ['L', 'P'], 'x', 3).find((l) => l.id === 'P')!.entries.map((e) => e.key)).toEqual(['x']);
  expect(() => renamePlaylist(both, 'L', 'Mine now')).toThrow(PlaylistError);
});

it('counts albums and lists separately', () => {
  let lists: Playlist[] = [];
  for (let i = 0; i < PLAYLISTS_MAX; i++) lists = createPlaylist(lists, `List ${i}`, i, `p${i}`);
  // A full set of lists still leaves room for albums...
  lists = saveAlbum(lists, { ...REF, title: 'A Great Chaos' }, ['a'], 1, 'L');
  expect(lists).toHaveLength(PLAYLISTS_MAX + 1);
  // ...and albums never use up the room for lists.
  let albums: Playlist[] = [];
  for (let i = 0; i < ALBUMS_MAX; i++) albums = saveAlbum(albums, { ...REF, id: `dz:${i}`, title: `Album ${i}` }, ['a'], i, `a${i}`);
  expect(() => saveAlbum(albums, { ...REF, id: 'dz:new', title: 'One more' }, ['a'], 1, 'n')).toThrow(/up to 100 albums/);
  expect(createPlaylist(albums, 'Mine', 1, 'm')).toHaveLength(ALBUMS_MAX + 1);
});

it('reads saved albums back from the store, and drops a broken album record rather than the list', () => {
  const stored = [
    { id: 'L', name: 'A Great Chaos', created: 1, album: REF, entries: [{ key: 'a', added: 1 }] },
    { id: 'M', name: 'Odd', created: 1, album: { id: '' }, entries: [] },
    { id: 'N', name: 'Mine', created: 1, entries: [] },
  ];
  const lists = parsePlaylists(stored);
  expect(lists[0]!.album).toEqual(REF);
  expect(lists[1]!.album).toBeUndefined();
  expect(lists[2]).not.toHaveProperty('album');
});
