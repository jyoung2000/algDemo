import { describe, expect, it } from 'vitest';

import {
  PLAYLISTS_MAX,
  PLAYLIST_NAME_MAX,
  PlaylistError,
  addToPlaylists,
  createPlaylist,
  deletePlaylist,
  findByName,
  normaliseName,
  parsePlaylists,
  playlistFullyPlayed,
  playlistsHolding,
  removeFromPlaylists,
  renamePlaylist,
  unplayedCount,
  type Playlist,
} from './playlists';

const T = 1_700_000_000;

/** A list with the given song keys already in it. */
const list = (id: string, name: string, keys: string[] = []): Playlist => ({
  id,
  name,
  created: T,
  entries: keys.map((key, i) => ({ key, added: T + i })),
});

describe('naming a list (PLAYLISTS-001)', () => {
  it('collapses the whitespace a text field invites', () => {
    expect(normaliseName('  Late   night  ')).toBe('Late night');
    expect(normaliseName('\n\tdrive\n')).toBe('drive');
  });

  it('keeps a name short enough to render', () => {
    expect(normaliseName('x'.repeat(200))).toHaveLength(PLAYLIST_NAME_MAX);
  });

  it('treats a blank name as no name', () => {
    expect(normaliseName('   ')).toBe('');
    expect(normaliseName(null)).toBe('');
    expect(normaliseName(undefined)).toBe('');
  });

  it('refuses to create a list with no name', () => {
    expect(() => createPlaylist([], '   ', T, 'p1')).toThrow(PlaylistError);
  });

  it('refuses a name the listener already used, however they spaced or cased it', () => {
    const lists = createPlaylist([], 'Late night', T, 'p1');
    expect(() => createPlaylist(lists, 'late  NIGHT', T, 'p2')).toThrow(/already have a list/i);
  });

  it('stops at the number of lists the UI can show', () => {
    let lists: Playlist[] = [];
    for (let i = 0; i < PLAYLISTS_MAX; i++) lists = createPlaylist(lists, `list ${i}`, T, `p${i}`);
    expect(lists).toHaveLength(PLAYLISTS_MAX);
    expect(() => createPlaylist(lists, 'one more', T, 'px')).toThrow(/up to/i);
  });

  it('renames a list, but not onto another list’s name', () => {
    let lists = createPlaylist([], 'Late night', T, 'p1');
    lists = createPlaylist(lists, 'Gym', T, 'p2');
    expect(renamePlaylist(lists, 'p2', 'Workout')[1]!.name).toBe('Workout');
    expect(() => renamePlaylist(lists, 'p2', 'late night')).toThrow(/already have a list/i);
    // Renaming a list to its own name is not a clash.
    expect(renamePlaylist(lists, 'p1', 'Late Night')[0]!.name).toBe('Late Night');
  });

  it('finds a list by name regardless of spacing and case', () => {
    const lists = createPlaylist([], 'Late night', T, 'p1');
    expect(findByName(lists, '  LATE   night ')?.id).toBe('p1');
    expect(findByName(lists, 'nope')).toBeUndefined();
  });
});

describe('putting a song in several lists', () => {
  it('adds one song to every list the listener ticked', () => {
    const lists = [list('p1', 'A'), list('p2', 'B'), list('p3', 'C')];
    const next = addToPlaylists(lists, ['p1', 'p3'], 'song:1', T);
    expect(next[0]!.entries.map((e) => e.key)).toEqual(['song:1']);
    expect(next[1]!.entries).toEqual([]);
    expect(next[2]!.entries.map((e) => e.key)).toEqual(['song:1']);
  });

  it('is safe to repeat: a song already held is not duplicated', () => {
    const once = addToPlaylists([list('p1', 'A')], ['p1'], 'song:1', T);
    const twice = addToPlaylists(once, ['p1'], 'song:1', T + 50);
    expect(twice[0]!.entries).toHaveLength(1);
    expect(twice[0]!.entries[0]!.added).toBe(T);
  });

  it('reports which lists hold a song, for the like menu to tick', () => {
    const lists = [list('p1', 'A', ['song:1']), list('p2', 'B'), list('p3', 'C', ['song:1', 'song:2'])];
    expect(playlistsHolding(lists, 'song:1')).toEqual(['p1', 'p3']);
    expect(playlistsHolding(lists, 'song:2')).toEqual(['p3']);
    expect(playlistsHolding(lists, 'missing')).toEqual([]);
  });

  it('removes a song from the named lists only', () => {
    const lists = [list('p1', 'A', ['song:1']), list('p2', 'B', ['song:1'])];
    const next = removeFromPlaylists(lists, ['p1'], 'song:1');
    expect(next[0]!.entries).toEqual([]);
    expect(next[1]!.entries.map((e) => e.key)).toEqual(['song:1']);
  });

  it('deletes a list without touching the others', () => {
    const lists = [list('p1', 'A'), list('p2', 'B')];
    expect(deletePlaylist(lists, 'p1').map((l) => l.id)).toEqual(['p2']);
    expect(deletePlaylist(lists, 'gone')).toHaveLength(2);
  });

  it('never mutates the lists it was given', () => {
    const lists = [list('p1', 'A')];
    const snapshot = JSON.stringify(lists);
    addToPlaylists(lists, ['p1'], 'song:1', T);
    removeFromPlaylists(lists, ['p1'], 'song:1');
    deletePlaylist(lists, 'p1');
    expect(JSON.stringify(lists)).toBe(snapshot);
  });
});

describe('discovery on a saved list', () => {
  it('waits until every song in the list has been played', () => {
    const l = list('p1', 'A', ['a', 'b', 'c']);
    expect(playlistFullyPlayed(l, new Set())).toBe(false);
    expect(playlistFullyPlayed(l, new Set(['a']))).toBe(false);
    expect(playlistFullyPlayed(l, new Set(['a', 'b']))).toBe(false);
    expect(playlistFullyPlayed(l, new Set(['a', 'b', 'c']))).toBe(true);
  });

  it('does not ask for more songs for an empty list', () => {
    // Nothing has been finished, so there is no "ran out" moment to react to.
    expect(playlistFullyPlayed(list('p1', 'A'), new Set())).toBe(false);
  });

  it('counts what is left so the UI can say why it is waiting', () => {
    const l = list('p1', 'A', ['a', 'b', 'c']);
    expect(unplayedCount(l, new Set())).toBe(3);
    expect(unplayedCount(l, new Set(['b']))).toBe(2);
    expect(unplayedCount(l, new Set(['a', 'b', 'c']))).toBe(0);
  });

  it('ignores plays of songs that are not in the list', () => {
    const l = list('p1', 'A', ['a']);
    expect(playlistFullyPlayed(l, new Set(['x', 'y']))).toBe(false);
  });
});

describe('reading lists back out of a long-lived store', () => {
  it('survives rows a past version or a bad write left behind', () => {
    const parsed = parsePlaylists([
      { id: 'p1', name: 'Good', created: T, entries: [{ key: 'a', added: T }] },
      null,
      'nonsense',
      { id: '', name: 'no id' },
      { id: 'p2', name: '   ' },
      { id: 'p1', name: 'duplicate id' },
      { id: 'p3', name: 'Entries missing' },
      { id: 'p4', name: 'Bad entries', entries: [null, { key: '' }, { key: 'b' }, { key: 'b' }] },
    ]);
    expect(parsed.map((l) => l.id)).toEqual(['p1', 'p3', 'p4']);
    expect(parsed[1]!.entries).toEqual([]);
    // A repeated key is kept once, and a missing timestamp becomes 0 rather than NaN.
    expect(parsed[2]!.entries).toEqual([{ key: 'b', added: 0 }]);
  });

  it('gives an empty list of lists for anything that is not an array', () => {
    expect(parsePlaylists(undefined)).toEqual([]);
    expect(parsePlaylists({})).toEqual([]);
    expect(parsePlaylists('[]')).toEqual([]);
  });
});
