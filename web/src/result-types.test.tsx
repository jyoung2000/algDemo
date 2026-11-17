// @vitest-environment happy-dom
/**
 * RESULT-TYPES-001. Owner (2026-11-15): "in the search results and near the top of artist
 * discography page could we make a small icon menu with a cd, album cover, duo icon with 2 users,
 * and music note to denominate and filter search results between singles, albums, features, and
 * lyrics ... Ensure the user can select and unselect icons".
 * RESULT-ARTIST-001. Owner (2026-11-15): "add a single user icon for artist to the search results
 * list and android auto so users can search by artist but not on the artist discography page".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type * as Api from './api';
import type { AlbumSearchResponse, AlbumSummary, ArtistSummary, ArtistView as ArtistData, IdentifyResponse, SearchResponse, Track } from './api';

const track = (k: string, title: string, album: string | null, artists = ['Ken Carson']): Track =>
  ({ key: k, title, artist: artists.join(', '), artists, album, duration: 136, artwork: null, preview: null, provider: 'deezer', platform_id: k, url: null, release: null, artist_ids: { deezer: '2568121' } }) as unknown as Track;
const albumOf = (id: string, title: string, kind: AlbumSummary['kind']): AlbumSummary => ({ id, provider: 'deezer', title, artist: 'Ken Carson', artwork: null, year: '2024', kind, count: kind === 'single' ? 1 : 12, url: '' });

// A single (its release is named after the song), an album song, a feature, and a lyric match.
const single = track('s1', 'Overseas', 'Overseas');
const albumSong = track('a1', 'Green Room', 'A Great Chaos');
const feat = track('f1', 'Fell In Love', 'We Love You Tecca 2', ['Lil Tecca', 'Ken Carson']);
const lyric = track('l1', 'Rock N Roll', 'A Great Chaos');
// Named after the artist but sung by someone else: the Artist icon must leave it out.
const tribute = track('o1', 'Ken Carson Tribute', null, ['Cover Band']);
const songs: SearchResponse = { results: [single, albumSong, feat, tribute], sources: { deezer: { state: 'ok', count: 4 } }, ms: 5, bytes: 0 } as unknown as SearchResponse;
const albums: AlbumSearchResponse = { query: 'q', sources: {}, albums: [albumOf('dz:9', 'A Great Chaos', 'album'), albumOf('dz:8', 'Overseas', 'single'), { ...albumOf('dz:7', 'Tribute Hits', 'album'), artist: 'Cover Band' }] };
const artistOf = (id: string, name: string): ArtistSummary => ({ id, provider: 'deezer', name, picture: null, detail: null, url: '' });
const artists = { query: 'q', artists: [artistOf('dz:2568121', 'Ken Carson'), artistOf('dz:5', 'Ken Carson Jr'), artistOf('dz:6', 'Carson Lueders')] };
const lyrics = { mode: 'lyrics', query: 'q', results: [lyric], named: 1, unplayable: 0, sources: {}, ms: 1, bytes: 0 } as unknown as IdentifyResponse;

const artistCall = vi.fn();
const songsCall = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<typeof Api>();
  return {
    ...real,
    api: {
      ...real.api,
      search: () => Promise.resolve(songs),
      searchLyrics: () => Promise.resolve(lyrics),
      searchAlbums: () => Promise.resolve(albums),
      searchArtists: () => Promise.resolve(artists),
      artist: (a: unknown) => artistCall(a),
      artistSongs: (a: unknown) => songsCall(a),
      artistFeatures: () => Promise.resolve({ features: [], complete: true }),
      artistSources: () => Promise.resolve({ songs: [], albums: [], singles: [], sources: {} }),
    },
  };
});
const { Search } = await import('./Search');
const { ArtistView } = await import('./Artists');
const { isSingleTrack, isFeatureTrack, isAlbumTrack } = await import('./result-types');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: Root;
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
});

const typeAndSearch = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
};
const menu = () => host.querySelector<HTMLElement>('[role="group"][aria-label="Show only"]');
const toggle = (name: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.dataset.type === name)!;
const press = async (name: string) => act(async () => toggle(name).click());
const songTitles = () => [...host.querySelectorAll('ul[aria-label^="Results for"] .track__title, ul[aria-label^="Songs with the words"] .track__title')].map((x) => x.textContent?.trim());
const albumTitles = () => [...host.querySelectorAll('button[aria-label^="Open the album "][aria-label*=" by "]')].map((b) => b.getAttribute('aria-label')!.replace(/^Open the album /, '').replace(/ by .*$/, ''));
const artistCards = () => [...host.querySelectorAll('ul[aria-label^="Artist "]')].map((u) => u.getAttribute('aria-label')!.replace(/^Artist /, ''));

describe('which kind of result a song is', () => {
  it('calls a song released under its own name a single, and not an album song', () => {
    expect(isSingleTrack(single)).toBe(true);
    expect(isSingleTrack(track('x', 'Margiela (feat. Destroy Lonely)', 'Margiela - Single'))).toBe(true);
    expect(isAlbumTrack(single)).toBe(false);
    expect(isSingleTrack(albumSong)).toBe(false);
    expect(isAlbumTrack(albumSong)).toBe(true);
    expect(isSingleTrack(track('n', 'No album', null))).toBe(false);
    expect(isAlbumTrack(track('n', 'No album', null))).toBe(false);
  });
  it('calls a song with more than one credited artist, or a feat. credit, a feature', () => {
    expect(isFeatureTrack(feat)).toBe(true);
    expect(isFeatureTrack(track('t', 'Toxic (feat. Lil Uzi Vert)', 'X'))).toBe(true);
    expect(isFeatureTrack(albumSong)).toBe(false);
  });
});

describe('search results', () => {
  const draw = async () => {
    await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} onOpenAlbumTarget={() => {}} />));
    await typeAndSearch('ken carson songs');
  };

  it('offers Artists, Singles, Albums, Features and Lyrics as icons, none selected, everything shown', async () => {
    await draw();
    expect(menu()).not.toBeNull();
    expect([...menu()!.querySelectorAll('button')].map((b) => b.dataset.type)).toEqual(['artists', 'singles', 'albums', 'features', 'lyrics']);
    for (const b of menu()!.querySelectorAll('button')) {
      expect(b.getAttribute('aria-pressed')).toBe('false');
      expect(b.querySelector('svg')).not.toBeNull();
    }
    expect(toggle('artists').getAttribute('aria-label')).toMatch(/^Artists/);
    expect(songTitles()).toEqual(['Overseas', 'Green Room', 'Fell In Love', 'Ken Carson Tribute', 'Rock N Roll']);
    expect(albumTitles()).toEqual(['A Great Chaos', 'Overseas', 'Tribute Hits']);
  });

  it('shows only singles when the CD is selected, and everything again when it is unselected', async () => {
    await draw();
    await press('singles');
    expect(toggle('singles').getAttribute('aria-pressed')).toBe('true');
    expect(songTitles()).toEqual(['Overseas']);
    expect(albumTitles()).toEqual(['Overseas']);
    await press('singles');
    expect(toggle('singles').getAttribute('aria-pressed')).toBe('false');
    expect(songTitles()).toEqual(['Overseas', 'Green Room', 'Fell In Love', 'Ken Carson Tribute', 'Rock N Roll']);
  });

  it('shows only album songs and albums for the album cover', async () => {
    await draw();
    await press('albums');
    expect(songTitles()).toEqual(['Green Room', 'Fell In Love']);
    expect(albumTitles()).toEqual(['A Great Chaos', 'Tribute Hits']);
  });

  it('shows only features for the two people, and only lyric matches for the note', async () => {
    await draw();
    await press('features');
    expect(songTitles()).toEqual(['Fell In Love']);
    expect(albumTitles()).toEqual([]);
    await press('features');
    await press('lyrics');
    expect(songTitles()).toEqual(['Rock N Roll']);
    expect(albumTitles()).toEqual([]);
  });

  it('combines selected icons, and unselecting them all shows everything again', async () => {
    await draw();
    await press('singles');
    await press('lyrics');
    expect(songTitles()).toEqual(['Overseas', 'Rock N Roll']);
    await press('singles');
    await press('lyrics');
    expect(songTitles()).toHaveLength(5);
  });
});

describe('searching by artist (RESULT-ARTIST-001)', () => {
  const draw = async (q: string) => {
    await act(async () => root.render(<Search seeds={[]} onAdd={() => {}} onPreview={() => {}} onOpenAlbumTarget={() => {}} onOpenArtist={() => {}} />));
    await typeAndSearch(q);
  };

  it('shows only the artists named, their songs and their albums for the single person', async () => {
    await draw('ken carson');
    // Unfiltered, only the exact artist leads (unchanged), and every song is listed.
    expect(artistCards()).toEqual(['Ken Carson']);
    expect(songTitles()).toContain('Ken Carson Tribute');
    await press('artists');
    expect(toggle('artists').getAttribute('aria-pressed')).toBe('true');
    expect(artistCards()).toEqual(['Ken Carson', 'Ken Carson Jr']);
    expect(songTitles()).toEqual(['Overseas', 'Green Room', 'Fell In Love']);
    expect(albumTitles()).toEqual(['A Great Chaos', 'Overseas']);
    await press('artists');
    expect(artistCards()).toEqual(['Ken Carson']);
    expect(songTitles()).toHaveLength(5);
  });

  it('keeps the artist away when another icon is chosen alone', async () => {
    await draw('ken carson');
    await press('singles');
    expect(artistCards()).toEqual([]);
    expect(songTitles()).toEqual(['Overseas']);
  });
});

describe('artist discography page', () => {
  const pop = [track('p1', 'Popular One', 'A Great Chaos'), track('p2', 'Popular Two', 'Popular Two')];
  const view: ArtistData = {
    id: 'dz:2568121', name: 'Ken Carson', picture: null, detail: '', songs: pop,
    albums: [albumOf('dz:1', 'A Great Chaos', 'album')], singles: [albumOf('dz:4', 'Possession', 'single')],
    features: [feat], links: {}, sources: { deezer: { state: 'ok', count: 2 } },
  } as unknown as ArtistData;
  const draw = async () => {
    artistCall.mockResolvedValue({ artist: view });
    songsCall.mockResolvedValue({ songs: pop, features: [], opened: 1, failed: 0 });
    await act(async () => root.render(<ArtistView target={{ id: 'dz:2568121', name: 'Ken Carson' }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const sections = () => [...host.querySelectorAll('[aria-label^="Songs by"], [aria-label^="Albums by"], [aria-label^="Singles by"], [aria-label^="Songs featuring"]')].map((x) => x.getAttribute('aria-label')!.split(' ')[0] + (x.getAttribute('aria-label')!.includes('featuring') ? ' featuring' : ''));

  it('puts the same icon menu near the top, above the songs, with everything shown', async () => {
    await draw();
    expect(menu()).not.toBeNull();
    expect([...menu()!.querySelectorAll('button')].map((b) => b.dataset.type)).toEqual(['singles', 'albums', 'features', 'songs']);
    // RESULT-ARTIST-001: the owner wants no artist icon on an artist's own page.
    expect(menu()!.querySelector('[data-type="artists"]')).toBeNull();
    const first = host.querySelector('ul.tracks')!;
    expect(menu()!.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sections()).toEqual(['Songs', 'Albums', 'Singles', 'Songs featuring']);
  });

  it('shows only the chosen parts of the discography, and all of it when unselected', async () => {
    await draw();
    await press('singles');
    expect(sections()).toEqual(['Singles']);
    await press('features');
    expect(sections()).toEqual(['Singles', 'Songs featuring']);
    await press('singles');
    await press('features');
    expect(sections()).toEqual(['Songs', 'Albums', 'Singles', 'Songs featuring']);
    await press('albums');
    expect(sections()).toEqual(['Albums']);
    await press('albums');
    await press('songs');
    expect(sections()).toEqual(['Songs']);
  });
});
