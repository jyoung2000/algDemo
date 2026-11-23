/**
 * PLAYLIST-DELTA-001 (owner, 2026-11-23): "On android adding songs to playlist doesnt work and the playlist dont
 * load or save the music".
 *
 * Measured on the emulator: every playlist call answered with EVERY list's EVERY song (about 2 KB a song). At
 * 20 lists of 450 songs one tick of the save menu took 8-18 s, and past 8,000,000 characters the Android bridge
 * refused the reply ("The engine reply was too large."), so no list loaded and nothing could be added. The product
 * limits (50 lists of 500 songs, plus saved albums) reach that size many times over.
 *
 * So a caller that says what it already holds is sent only what changed, in replies of a bounded size.
 */
import { describe, expect, it } from 'vitest';
import { LocalApi } from './local-api';
import { MemoryBackend, Store } from './store';
import { PLAYLIST_REPLY_BUDGET } from './playlist-delta';

const port = { async request() { return { status: 404, headers: {}, body: new Uint8Array() }; } };
const api = (store: Store) => new LocalApi({ store, port: port as never, encoder: null, spotifySearch: () => async () => [] });

type List = { id: string; name: string; count: number; rev?: string; same?: boolean; more?: boolean; items?: { key: string }[] };
const listsOf = (r: { body: unknown }) => (r.body as { lists: List[] }).lists;
const size = (r: { body: unknown }) => JSON.stringify(r.body).length;

const song = (list: number, i: number) => ({
  key: `artist ${list}|song ${list} ${i}|`, title: `Song ${list} ${i}`, artists: [`Artist ${list}`], provider: 'deezer',
  platform_id: String(list * 1000 + i), duration: 200, album: `Album ${list}`, url: `https://www.deezer.com/track/${list * 1000 + i}`,
  artwork: `https://cdn-images.dzcdn.net/images/cover/${'a'.repeat(32)}/500x500-000000-80-0-0.jpg`,
  tags: [{ name: 'Rap', kind: 'genre' }, { name: 'Rage', kind: 'subgenre' }], explicit: true, release_date: '2025-01-01',
});

async function library(lists: number, songs: number) {
  const a = api(await Store.open(new MemoryBackend()));
  for (let l = 0; l < lists; l++) {
    const r = await a.handle('POST', '/api/playlists', { action: 'create', name: `List ${l}`, tracks: Array.from({ length: songs }, (_, i) => song(l, i)), have: {} });
    expect(r.status).toBe(200);
  }
  return a;
}

const have = (held: Map<string, string>) => encodeURIComponent(JSON.stringify(Object.fromEntries(held)));

describe('PLAYLIST-DELTA-001: playlist replies carry only what the caller lacks', () => {
  it('an edit to one list does not send the other lists again', async () => {
    const a = await library(6, 120);
    const all = listsOf(await a.handle('GET', '/api/playlists'));
    expect(all.every((l) => l.items?.length === 120)).toBe(true);
    const full = size(await a.handle('GET', '/api/playlists'));

    const first = listsOf(await a.handle('GET', `/api/playlists?have=${have(new Map())}`));
    const held = new Map(first.filter((l) => l.items).map((l) => [l.id, l.rev!]));
    expect(held.size).toBe(6);

    const edit = await a.handle('POST', '/api/playlists', { action: 'add', ids: [all[2]!.id], key: 'someone|a new song|', tracks: [{ ...song(9, 9), key: 'someone|a new song|' }], have: Object.fromEntries(held) });
    const after = listsOf(edit);
    expect(after.map((l) => l.count)).toEqual([120, 120, 121, 120, 120, 120]);
    // Only the list that changed comes with its songs.
    expect(after.filter((l) => l.items).map((l) => l.name)).toEqual(['List 2']);
    expect(after.filter((l) => l.same).length).toBe(5);
    expect(after[2]!.items!.some((i) => i.key === 'someone|a new song|')).toBe(true);
    expect(size(edit)).toBeLessThan(full / 4);
  });

  it('a library far larger than one reply may be still loads, a bounded piece at a time', async () => {
    const a = await library(12, 400);
    const held = new Map<string, string>();
    const got = new Map<string, number>();
    let rounds = 0;
    for (;;) {
      const r = await a.handle('GET', `/api/playlists?have=${have(held)}`);
      expect(r.status).toBe(200);
      // No single reply is allowed to grow with the whole library.
      expect(size(r)).toBeLessThan(PLAYLIST_REPLY_BUDGET * 2);
      const lists = listsOf(r);
      expect(lists.length).toBe(12);
      for (const l of lists) if (l.items) { held.set(l.id, l.rev!); got.set(l.id, l.items.length); }
      rounds++;
      if (!lists.some((l) => l.more)) break;
      expect(rounds).toBeLessThan(40);
    }
    expect(rounds).toBeGreaterThan(1);
    expect([...got.values()]).toEqual(Array(12).fill(400));
  });

  it('a caller that says nothing about what it holds is answered in full, as before', async () => {
    const a = await library(2, 5);
    const lists = listsOf(await a.handle('GET', '/api/playlists'));
    expect(lists.map((l) => l.items?.length)).toEqual([5, 5]);
    expect(lists.some((l) => l.same || l.more)).toBe(false);
  });

  it('a list whose songs changed is sent again; one that did not is not', async () => {
    const a = await library(2, 3);
    const first = listsOf(await a.handle('GET', `/api/playlists?have=${have(new Map())}`));
    const held = new Map(first.map((l) => [l.id, l.rev!]));
    const again = listsOf(await a.handle('GET', `/api/playlists?have=${have(held)}`));
    expect(again.every((l) => l.same && !l.items)).toBe(true);
    await a.handle('POST', '/api/playlists', { action: 'remove', id: first[0]!.id, key: song(0, 1).key });
    const third = listsOf(await a.handle('GET', `/api/playlists?have=${have(held)}`));
    expect(third[0]!.items?.length).toBe(2);
    expect(third[0]!.rev).not.toBe(first[0]!.rev);
    expect(third[1]!.same).toBe(true);
  });
});
