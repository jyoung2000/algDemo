// @vitest-environment happy-dom
/**
 * ARTIST-SOURCES-001. Owner: "when opening an artist page dont just list deezer, list all the different
 * platforms / sources the artist information is coming from". Chosen form: every platform that gave
 * something and what it gave (songs, albums, picture, audience), including any that failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Api from './api';
import type { AlbumSummary, ArtistView as ArtistData, Track } from './api';

const artistCall = vi.fn();
const songsCall = vi.fn();
const extrasCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return { ...real, api: { ...real.api, artist: (a: unknown) => artistCall(a), artistSongs: (a: unknown) => songsCall(a), artistFeatures: () => Promise.resolve({ features: [], complete: true }), artistSources: (a: unknown) => extrasCall(a) } };
});
const { ArtistView, artistSources, alsoChecked } = await import('./Artists');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const song = (k: string, provider = 'deezer', artists = ['Sade']): Track =>
  ({ key: k, title: `Song ${k}`, artist: artists.join(', '), artists, album: null, duration: 200, artwork: null, preview: null, provider, platform_id: k, release: null, tags: [] }) as unknown as Track;
const album = (id: string, provider: string, kind: AlbumSummary['kind'] = 'album'): AlbumSummary =>
  ({ id, provider, title: `Album ${id}`, artist: 'Sade', artwork: null, year: '2000', kind, count: 9, url: '' }) as unknown as AlbumSummary;
const view = (over: Partial<ArtistData> = {}): ArtistData => ({
  id: 'dz:1', name: 'Sade', picture: 'https://x/p.jpg', detail: '9.1M monthly audience',
  songs: [song('a'), song('b'), song('c')],
  features: [song('f', 'deezer', ['Other', 'Sade'])],
  albums: [album('dz:1', 'deezer'), album('dz:2', 'deezer'), album('yt:MPREb_1', 'ytmusic')],
  singles: [album('dz:9', 'deezer', 'single')],
  links: {}, sources: { deezer: { state: 'ok', count: 4, gave: ['picture'] }, ytmusic: { state: 'ok', count: 0, gave: ['audience'] } },
  ...over,
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
const NO_EXTRAS = { songs: [], albums: [], singles: [], sources: {} };
beforeEach(() => { extrasCall.mockResolvedValue(NO_EXTRAS); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); artistCall.mockReset(); songsCall.mockReset(); extrasCall.mockReset(); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const mount = (a: ArtistData) => act(async () => {
    root.render(<ArtistView target={{ name: a.name }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} addedKeys={new Set()} playingKey={null} />);
});
const open = async (a: ArtistData) => {
  artistCall.mockResolvedValue({ artist: a });
  await mount(a);
  await flush();
};
// The words only: a built-in platform mark can carry a letter of its own.
const rows = () => [...host.querySelectorAll('.artist__sources .artist__source .artist__source-text')].map((li) => li.textContent!.replace(/\s+/g, ' ').trim());

describe('what each platform gave (ARTIST-SOURCES-001)', () => {
  it('names every platform with what came from it', () => {
    const a = view();
    expect(artistSources(a, a.songs, a.features).map((r) => r.text)).toEqual([
      'Deezer · 3 songs · 1 feature · 2 albums · 1 single · picture',
      'YouTube Music · 1 album · audience',
    ]);
  });
  it('lists a platform whose songs are on the page even though its artist page was never read', () => {
    const a = view();
    const songs = [...a.songs, song('s1', 'soundcloud'), song('s2', 'soundcloud'), song('ap', 'apple')];
    expect(artistSources(a, songs, a.features).map((r) => r.text)).toEqual([
      'Deezer · 3 songs · 1 feature · 2 albums · 1 single · picture',
      'YouTube Music · 1 album · audience',
      'Apple Music · 1 song',
      'SoundCloud · 2 songs',
    ]);
  });
  it('leaves out a platform that answered and added nothing', () => {
    const a = view({ albums: [album('dz:1', 'deezer')], detail: null, sources: { deezer: { state: 'ok', count: 4, gave: ['picture'] }, ytmusic: { state: 'ok', count: 0 } } });
    expect(artistSources(a, a.songs, a.features).map((r) => r.provider)).toEqual(['deezer']);
  });
  it('says why a platform was not read', () => {
    const why = (w: string) => artistSources(view({ albums: [], detail: null, sources: { deezer: { state: 'ok', count: 4, gave: ['picture'] }, ytmusic: { state: 'failed', why: w as never } } }), [song('a')], []).find((r) => r.provider === 'ytmusic')!;
    expect(why('offline')).toMatchObject({ failed: true, text: 'YouTube Music · page not read: no connection' });
    expect(why('allowance').text).toBe('YouTube Music · page not read: today\u2019s allowance is used up');
    expect(why('busy').text).toBe('YouTube Music · page not read: the service is busy');
    expect(why('refused').text).toBe('YouTube Music · page not read: the service refused the request');
    expect(why('failed').text).toBe('YouTube Music · page not read: it answered with an error');
  });
  it('keeps what a platform did give beside the reason its page was not read', () => {
    const a = view({ local: true, picture: null, detail: null, albums: [], singles: [], features: [], sources: { deezer: { state: 'failed', why: 'offline' }, ytmusic: { state: 'failed', why: 'offline' } } });
    expect(artistSources(a, a.songs, []).map((r) => r.text)).toEqual([
      'Deezer · 3 songs · page not read: no connection',
      'YouTube Music · page not read: no connection',
    ]);
  });
});

describe('the artist page shows its sources (ARTIST-SOURCES-001)', () => {
  it('lists each platform on its own row, and counts every song once they are all found', async () => {
    let release: (v: unknown) => void = () => {};
    songsCall.mockReturnValue(new Promise((r) => (release = r)));
    const a = view();
    await open(a);
    expect(host.querySelector('.artist__sources')!.getAttribute('aria-label')).toBe('Where Sade\u2019s information comes from');
    expect(rows()).toEqual(['Deezer · 3 songs · 1 feature · 2 albums · 1 single · picture', 'YouTube Music · 1 album · audience']);
    expect(host.textContent).not.toContain('From Deezer');
    await act(async () => { release({ songs: [...a.songs, song('d'), song('y1', 'ytmusic')], features: [], opened: 4, failed: 0, featuresComplete: true }); });
    await flush();
    expect(rows()).toEqual(['Deezer · 4 songs · 1 feature · 2 albums · 1 single · picture', 'YouTube Music · 1 song · 1 album · audience']);
  });
  it('marks a platform that was not read, in words', async () => {
    songsCall.mockResolvedValue({ songs: [song('a')], features: [], opened: 0, failed: 0, featuresComplete: true });
    await open(view({ albums: [], detail: null, sources: { deezer: { state: 'ok', count: 4, gave: ['picture'] }, ytmusic: { state: 'failed', why: 'offline' } } }));
    expect(rows()).toContain('YouTube Music · page not read: no connection');
    expect(host.querySelector('.artist__source.is-failed')).not.toBeNull();
  });
  it('does not claim the services have no page when they were never reached', async () => {
    songsCall.mockResolvedValue({ songs: [song('a', 'ytmusic')], features: [], opened: 0, failed: 0, featuresComplete: true });
    await open(view({ id: 'local:sade', local: true, picture: null, detail: null, songs: [song('a', 'ytmusic')], features: [], albums: [], singles: [], sources: { deezer: { state: 'failed', why: 'allowance' }, ytmusic: { state: 'failed', why: 'allowance' } } }));
    expect(host.textContent).not.toMatch(/Neither Deezer nor YouTube Music has a page/i);
    expect(host.querySelector('.album__note')!.textContent).toMatch(/Sade\u2019s page could not be read: today\u2019s allowance is used up\. These are the songs you already have by them\./);
    expect(rows()).toEqual(['Deezer · page not read: today\u2019s allowance is used up', 'YouTube Music · 1 song · page not read: today\u2019s allowance is used up']);
  });
  it('still says neither has a page when both answered and had none', async () => {
    songsCall.mockResolvedValue({ songs: [song('a', 'soundcloud')], features: [], opened: 0, failed: 0, featuresComplete: true });
    await open(view({ id: 'local:sade', local: true, picture: null, detail: null, songs: [song('a', 'soundcloud')], features: [], albums: [], singles: [], sources: { deezer: { state: 'none' }, ytmusic: { state: 'none' } } }));
    expect(host.textContent).toMatch(/Neither Deezer nor YouTube Music has a page for/i);
    expect(rows()).toEqual(['SoundCloud · 1 song']);
  });
});

/**
 * ARTIST-ALL-SOURCES-001. Owner: "ensure the artist / discography page pulls from all sources".
 * SoundCloud, Apple Music, Bandcamp and Audius are asked once the page is up; what they add joins the
 * song list and the shelves, and every one of them is accounted for where the sources are listed.
 */
describe('the other platforms on an artist page (ARTIST-ALL-SOURCES-001)', () => {
  const titled = (k: string, title: string, provider: string): Track => ({ ...song(k, provider), title });
  const extras = {
    songs: [titled('sc1', 'A Loosie', 'soundcloud'), titled('sc2', 'Song a', 'soundcloud'), titled('bc1', 'Bandcamp Only', 'bandcamp')],
    albums: [album('ap:7', 'apple')],
    singles: [album('sc:9', 'soundcloud', 'single')],
    sources: { soundcloud: { state: 'ok', checked: 40 }, apple: { state: 'ok', checked: 12 }, bandcamp: { state: 'ok', checked: 3 }, audius: { state: 'none' } },
  };
  const names = (label: string) => [...host.querySelectorAll(`[aria-label="${label}"] .track__title`)].map((x) => x.textContent!.trim());
  const also = () => host.querySelector('.artist__also')?.textContent?.replace(/\s+/g, ' ').trim();

  it('says what a platform gave, that one had it all already, and that one is not vouched for', () => {
    const a = view({ sources: { deezer: { state: 'ok', gave: ['picture'] }, soundcloud: { state: 'ok', checked: 40, note: 'unverified' }, apple: { state: 'ok', checked: 12 }, bandcamp: { state: 'none' }, audius: { state: 'failed', why: 'busy' } } });
    const songs = [...a.songs, song('s1', 'soundcloud')];
    expect(artistSources(a, songs, a.features).map((r) => r.text)).toEqual([
      'Deezer · 3 songs · 1 feature · 2 albums · 1 single · picture',
      'YouTube Music · 1 album',
      'Apple Music · all 12 already listed',
      'SoundCloud · 1 song · unverified account',
      'Audius · page not read: the service is busy',
    ]);
    expect(alsoChecked(a.sources)).toEqual(['Bandcamp']);
  });

  it('asks the other platforms once the page is up, and names them while it waits', async () => {
    let land: (v: unknown) => void = () => {};
    extrasCall.mockReturnValue(new Promise((r) => (land = r)));
    songsCall.mockResolvedValue({ songs: view().songs, features: [], opened: 0, failed: 0, featuresComplete: true });
    await open(view());
    expect(extrasCall).toHaveBeenCalledWith({ id: 'dz:1', name: 'Sade' });
    expect(host.querySelector('.artist__source--wait')?.textContent).toContain('Checking SoundCloud, Apple Music, Bandcamp and Audius');
    await act(async () => { land(NO_EXTRAS); });
    await flush();
    expect(host.querySelector('.artist__source--wait')).toBeNull();
  });

  it('adds their songs after the artist\u2019s own, each once, and their records to the shelves', async () => {
    songsCall.mockResolvedValue({ songs: view().songs, features: [], opened: 0, failed: 0, featuresComplete: true });
    extrasCall.mockResolvedValue(extras);
    await open(view());
    await flush();
    await act(async () => { [...host.querySelectorAll('button')].find((b) => /Show all/.test(b.textContent ?? ''))?.click(); });
    // "Song a" is on the page already: SoundCloud's copy is not listed again.
    expect(names('Songs by Sade')).toEqual(['Song a', 'Song b', 'Song c', 'A Loosie', 'Bandcamp Only']);
    expect(host.querySelector('.album__meta')!.textContent).toContain('5 songs');
    expect(host.querySelector('.album__meta')!.textContent).toContain('4 albums');
    expect(rows()).toEqual([
      'Deezer · 3 songs · 1 feature · 2 albums · 1 single · picture',
      'YouTube Music · 1 album · audience',
      'Apple Music · 1 album',
      'SoundCloud · 1 song · 1 single',
      'Bandcamp · 1 song',
    ]);
    expect(also()).toBe('Also checked: Audius has no page for Sade.');
  });

  it('holds their songs until the artist\u2019s own list is whole, so none shows and then goes', async () => {
    let release: (v: unknown) => void = () => {};
    songsCall.mockReturnValue(new Promise((r) => (release = r)));
    extrasCall.mockResolvedValue(extras);
    const a = view();
    await open(a);
    await flush();
    expect(rows()).not.toContain('Bandcamp · 1 song');
    // The records are not waiting on anything: the page has every album from the start.
    expect(rows()).toContain('Apple Music · 1 album');
    await act(async () => { release({ songs: [...a.songs, titled('d', 'A Loosie', 'deezer')], features: [], opened: 4, failed: 0, featuresComplete: true }); });
    await flush();
    // Deezer turned out to have "A Loosie" on an album: SoundCloud's copy never appears.
    expect(rows()).toContain('Deezer · 4 songs · 1 feature · 2 albums · 1 single · picture');
    expect(rows()).toContain('Bandcamp · 1 song');
    expect(rows().some((r) => r.startsWith('SoundCloud · 1 song'))).toBe(false);
  });

  it('says so, quietly, when the other platforms could not be asked at all', async () => {
    songsCall.mockResolvedValue({ songs: view().songs, features: [], opened: 0, failed: 0, featuresComplete: true });
    extrasCall.mockRejectedValue(new Error('offline'));
    await open(view());
    await flush();
    expect(also()).toBe('SoundCloud, Apple Music, Bandcamp and Audius could not be checked.');
    expect(rows()).toEqual(['Deezer · 3 songs · 1 feature · 2 albums · 1 single · picture', 'YouTube Music · 1 album · audience']);
  });
});

/**
 * OPEN-HEAL-001. Owner: "ensure everything loads as seamless as possible". A page opens without a
 * service that is slow to answer (OPEN-FLOW-001) rather than wait on it. It then has to mend itself:
 * measured 2026-11-16, such a page said "YouTube Music \u00b7 page not read: the service is busy" and stayed
 * that way until the listener left and came back.
 */
describe('a service that was busy when the page opened (OPEN-HEAL-001)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const busy = () => view({ albums: [album('dz:1', 'deezer'), album('dz:2', 'deezer')], detail: null, sources: { deezer: { state: 'ok', count: 4, gave: ['picture'] }, ytmusic: { state: 'failed', why: 'busy' } } });

  it('asks again quietly, and shows what the service then gave without the page starting over', async () => {
    artistCall.mockResolvedValueOnce({ artist: busy() }).mockResolvedValue({ artist: view() });
    songsCall.mockResolvedValue({ songs: view().songs, features: [], opened: 1, failed: 0 });
    await mount(busy());
    await tick(0);
    expect(rows().some((r) => /^YouTube Music .*not read/.test(r))).toBe(true);
    expect(artistCall).toHaveBeenCalledTimes(1);
    expect(songsCall).toHaveBeenCalledTimes(1);
    const page = host.querySelector('.artist');
    await tick(6000);
    expect(artistCall).toHaveBeenCalledTimes(2);
    expect(rows()).toContain('YouTube Music \u00b7 1 album \u00b7 audience');
    expect(rows().some((r) => /not read/.test(r))).toBe(false);
    // The same page, mended in place: never back to "Opening the artist".
    expect(host.querySelector('.artist')).toBe(page);
    expect(host.textContent).not.toContain('Opening the artist');
    // The songs are asked for again, now that there are more records to read them from.
    expect(songsCall).toHaveBeenCalledTimes(2);
    // Every service has answered: nothing further is asked.
    await tick(120000);
    expect(artistCall).toHaveBeenCalledTimes(2);
  });

  it('gives up after a few tries when the service stays busy, and keeps the page as it is', async () => {
    artistCall.mockResolvedValue({ artist: busy() });
    songsCall.mockResolvedValue({ songs: view().songs, features: [], opened: 1, failed: 0 });
    await mount(busy());
    await tick(0);
    await tick(300000);
    expect(artistCall.mock.calls.length).toBeGreaterThan(1);
    expect(artistCall.mock.calls.length).toBeLessThanOrEqual(6);
    expect(songsCall).toHaveBeenCalledTimes(1);
    expect(rows().some((r) => /^YouTube Music .*not read/.test(r))).toBe(true);
  });

  it('asks nothing again when every service answered, or when one simply has no such artist', async () => {
    artistCall.mockResolvedValue({ artist: view({ sources: { deezer: { state: 'ok', count: 4 }, ytmusic: { state: 'none' } } }) });
    songsCall.mockResolvedValue({ songs: view().songs, features: [], opened: 1, failed: 0 });
    await mount(view());
    await tick(0);
    await tick(120000);
    expect(artistCall).toHaveBeenCalledTimes(1);
  });

  it('stops asking once the page is left', async () => {
    artistCall.mockResolvedValue({ artist: busy() });
    songsCall.mockResolvedValue({ songs: view().songs, features: [], opened: 1, failed: 0 });
    await mount(busy());
    await tick(0);
    await act(async () => root.render(<div />));
    await tick(120000);
    expect(artistCall).toHaveBeenCalledTimes(1);
  });
});
