// @vitest-environment happy-dom
/** ARTIST-REFRESH-001: a new look reads every source without taking the visible page away. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Api from './api';
import { Artists, type ArtistView as EngineView, type Ctx } from './engine/artists';
import { ArtistExtrasReader } from './engine/artist-extras';
import { Deezer } from './engine/deezer';
import { Http, HostPacer, type HttpPort } from './engine/net';
import { makeTrack } from './engine/track';
import type { Store } from './engine/store';
import type { Albums } from './engine/albums';

const artist = vi.fn();
const songs = vi.fn();
const features = vi.fn();
const sources = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, artist, artistSongs: songs, artistFeatures: features, artistSources: sources } };
});
const { ArtistView } = await import('./Artists');
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const song = (title: string) => makeTrack({ provider: 'deezer', platformId: title, title, artists: ['Artist'], duration: 200, url: '' });
const view: EngineView = { id: 'dz:1', name: 'Artist', picture: null, detail: null, songs: [song('Old song')], features: [song('Old page feature')], albums: [], singles: [], links: { deezer: 'https://www.deezer.com/artist/1' }, sources: {} };
const emptyExtras = { songs: [], albums: [], singles: [], sources: {} };
const deferred = <T,>() => { let resolve!: (x: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); vi.resetAllMocks(); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function open() {
  artist.mockResolvedValue({ artist: view });
  songs.mockResolvedValue({ songs: [...view.songs, song('Old album song')], features: [], opened: 1, failed: 0 });
  features.mockResolvedValue({ features: [song('Old feature')], complete: true });
  sources.mockResolvedValue({ ...emptyExtras, songs: [song('Old extra song')] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<ArtistView target={{ id: 'dz:1', name: 'Artist' }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} />));
  await flush();
}
const refreshButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Refresh artist"]') ?? undefined;
const titles = () => [...host.querySelectorAll('.track__title')].map((x) => x.textContent?.trim());

it('moves a song with a newly verified guest credit into Features without showing it twice', async () => {
  const shared = song('Newly credited guest');
  view.songs.push(shared); view.features!.push(shared);
  try { await open(); expect(titles().filter(t => t === 'Newly credited guest')).toHaveLength(1); }
  finally { view.songs.pop(); view.features!.pop(); }
});

it('uses a separated icon-only refresh action, with an accessible name', async () => {
  await open();
  const button = refreshButton()!; expect(button).toBeDefined();
  expect(button.textContent).toBe(''); expect(button.querySelector('svg')).not.toBeNull();
  expect(button.classList.contains('artist__refresh')).toBe(true);
});

it('refreshes all four requests with one fresh token, keeps results and pages features to the end', async () => {
  await open();
  const before = titles();
  const page = deferred<{ artist: EngineView }>();
  const rows = deferred<{ songs: ReturnType<typeof song>[]; features: ReturnType<typeof song>[]; opened: number; failed: number }>();
  const guest = deferred<{ features: ReturnType<typeof song>[]; complete: boolean; more: boolean }>();
  artist.mockReturnValue(page.promise); songs.mockReturnValue(rows.promise); features.mockReturnValueOnce(guest.promise).mockResolvedValue({ features: [song('New feature')], complete: true, more: false });
  expect(refreshButton()).toBeDefined();
  await act(async () => refreshButton()!.click());
  expect(refreshButton()!.disabled).toBe(true);
  expect(titles()).toEqual(before);
  const target = artist.mock.calls[1]![0];
  expect(target).toMatchObject({ refresh: true, refreshToken: expect.any(String) });
  await act(async () => page.resolve({ artist: { ...view, songs: [], features: [] } }));
  await flush();
  for (const fn of [songs, features, sources]) expect(fn.mock.calls[1]![0]).toMatchObject(target);
  expect(titles()).toEqual(before);
  await act(async () => guest.resolve({ features: [song('New feature')], complete: true, more: true }));
  await flush();
  expect(features.mock.calls[2]![0]).toMatchObject(target);
  expect(refreshButton()!.disabled).toBe(true); // Songs are still on their way.
  await act(async () => rows.resolve({ songs: [song('New song')], features: [], opened: 1, failed: 0 }));
  await flush();
  expect(titles()).toEqual(expect.arrayContaining([...before, 'New feature', 'New song']));
  expect(refreshButton()!.disabled).toBe(false);
  await act(async () => refreshButton()!.click());
  expect(artist.mock.calls[2]![0].refreshToken).not.toBe(target.refreshToken);
});

it('retains the page and reports a failed refresh without turning it into a failed artist page', async () => {
  await open(); const before = titles();
  artist.mockRejectedValue(new Error('offline'));
  expect(refreshButton()).toBeDefined();
  await act(async () => refreshButton()!.click()); await flush();
  expect(titles()).toEqual(before);
  expect(host.textContent).toMatch(/refresh.*could not|could not.*refresh/i);
  expect(refreshButton()!.disabled).toBe(false);
});

it('ignores an old in-flight feature answer after refresh starts', async () => {
  await open();
  const old = deferred<{ features: ReturnType<typeof song>[]; complete: boolean; more: boolean }>();
  // Start another incomplete feature look through the existing retry control.
  await act(async () => root!.render(<div />));
  features.mockReturnValueOnce(old.promise).mockResolvedValue({ features: [], complete: true });
  await act(async () => root!.render(<ArtistView target={{ id: 'dz:1', name: 'Artist' }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} />));
  await flush(); expect(refreshButton()).toBeDefined();
  await act(async () => refreshButton()!.click()); await flush();
  await act(async () => old.resolve({ features: [song('Obsolete answer')], complete: true, more: true }));
  await flush(); expect(titles()).not.toContain('Obsolete answer');
});

it('keeps initial page songs when refresh begins before the first full song list finishes', async () => {
  await open();
  await act(async () => root!.render(<div />));
  const held = deferred<{ songs: ReturnType<typeof song>[]; opened: number; failed: number }>();
  songs.mockReturnValueOnce(held.promise).mockResolvedValue({ songs: [], opened: 0, failed: 0 });
  await act(async () => root!.render(<ArtistView target={{ id: 'dz:1', name: 'Artist' }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} />));
  await flush(); expect(titles()).toContain('Old song');
  await act(async () => refreshButton()!.click()); await flush();
  expect(titles()).toContain('Old song');
});

function cache() {
  const m = new Map<string, unknown>();
  const store = { cacheGet: (k: string) => m.has(k) ? { value: m.get(k) } : null, cachePut: async (k: string, _kind: string, v: unknown) => { m.set(k, v); } } as unknown as Store;
  return { m, store };
}
function engine(store: Store) {
  const seen: string[] = [];
  const port: HttpPort = { async delay() {}, async request(req) {
    seen.push(req.url); const u = new URL(req.url);
    const body = u.pathname === '/artist/1' ? { id: 1, name: 'Artist' } : { data: [] };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } };
  const http = new Http(port, new HostPacer({}, 0));
  return { http, seen, dz: new Deezer(http), artists: new Artists(http, new Deezer(http), undefined, store) };
}
const fresh = (token: string) => ({ refresh: true, refreshToken: token }) as Ctx;

it('bypasses cached artist pages and name searches once per refresh identity, then publishes the fresh page', async () => {
  const { store, m } = cache(); const w = engine(store);
  m.set('artistview4:1::artist', { ...view, name: 'Stale' });
  m.set('dz:artsearch:artist', []);
  expect((await w.artists.open({ id: 'dz:1', name: 'Artist' })).name).toBe('Stale');
  const a = await w.artists.open({ id: 'dz:1', name: 'Artist', ...fresh('one') });
  expect(a.name).toBe('Artist'); expect(w.seen).toHaveLength(3);
  await w.artists.open({ id: 'dz:1', name: 'Artist', ...fresh('one') });
  expect(w.seen).toHaveLength(3);
  await w.artists.open({ id: 'dz:1', name: 'Artist', ...fresh('two') });
  expect(w.seen).toHaveLength(6);
  expect((await w.artists.open({ id: 'dz:1', name: 'Artist' })).name).toBe('Artist');
  await w.artists.search('Artist', 6, fresh('one'));
  expect(w.seen.some((u) => u.includes('/search/artist'))).toBe(true);
});

it('bypasses completed feature caches and old contributor verdicts and restarts every search page', async () => {
  const { store, m } = cache(); const w = engine(store);
  m.set('artistfeats4:dz:1', { features: [song('Cached feature')], complete: true });
  m.set('artistfeatverdict2:1', { no: ['9'], yes: {} });
  let candidateReads = 0; let searches = 0;
  vi.spyOn(w.http, 'getJson').mockImplementation(async (url) => {
    const u = new URL(url);
    if (u.pathname === '/track/9') { candidateReads++; return { id: 9, title: 'New guest', artist: { id: 2, name: 'Lead' }, contributors: [{ id: 2, name: 'Lead' }, { id: 1, name: 'Artist' }] } as never; }
    searches++;
    return { data: [{ id: 9, artist: { id: 2 } }] } as never;
  });
  expect((await w.artists.everyFeature(view)).features[0]!.title).toBe('Cached feature');
  const r = await w.artists.everyFeature(view, fresh('one'));
  expect(r.features.map((t) => t.title)).toEqual(['New guest']);
  expect(candidateReads).toBe(1); expect(searches).toBe(3);
  await w.artists.everyFeature(view, fresh('two'));
  expect(candidateReads).toBe(2); expect(searches).toBe(6);
});

it('does not reuse a song list for different albums merely because their counts match; forwards refresh to album reads', async () => {
  const { store } = cache(); const w = engine(store);
  const openAlbum = vi.fn(async (id: string) => ({ tracks: [song(id)] }));
  const a = new Artists(w.http, w.dz, undefined, store, { open: openAlbum } as unknown as Albums);
  const album = (id: string) => ({ id }) as EngineView['albums'][number];
  await a.everySong({ ...view, albums: [album('dz:10')] }, {}, { features: false });
  const r = await a.everySong({ ...view, albums: [album('dz:20')] }, {}, { features: false });
  expect(r.songs.map((t) => t.title)).toContain('dz:20');
  await a.everySong({ ...view, albums: [album('dz:20')] }, fresh('one'), { features: false });
  expect(openAlbum.mock.calls.at(-1)).toEqual(['dz:20', fresh('one')]);
  expect(openAlbum).toHaveBeenCalledTimes(3);
});

it('rechecks extra sources for each token instead of serving yesterday\u2019s complete empty result', async () => {
  const { store, m } = cache(); const w = engine(store);
  const sc = { api: vi.fn(async () => ({ collection: [] })) };
  const bc = { bands: vi.fn(async () => []), discography: vi.fn() };
  const au = { users: vi.fn(async () => []), userTracks: vi.fn() };
  const reader = new ArtistExtrasReader(w.http, store, { sc, bandcamp: bc, audius: au, albums: {} } as never);
  m.set('artistextra3:dz:1:artist', emptyExtras);
  await reader.read(view); expect(sc.api).not.toHaveBeenCalled();
  const r = await reader.read(view, fresh('one'));
  expect(Object.keys(r.sources)).toHaveLength(4);
  expect(sc.api).toHaveBeenCalledTimes(1); expect(bc.bands).toHaveBeenCalledWith('Artist', fresh('one')); expect(au.users).toHaveBeenCalledWith('Artist', fresh('one'));
  await reader.read(view, fresh('one')); expect(sc.api).toHaveBeenCalledTimes(1);
  await reader.read(view, fresh('two')); expect(sc.api).toHaveBeenCalledTimes(2);
});
