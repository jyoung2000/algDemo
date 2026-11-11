// @vitest-environment happy-dom
/** Song metadata is title -> album (when known) -> every credited artist, not an action icon. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RecItem, Track } from './api';
import { TrackList } from './Search';
import { Results } from './Results';
import { SavedView } from './SavedView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const song: Track & { artist_ids: Record<string, string> } = {
  id: 'dz:123', key: 'deezer:123', provider: 'deezer', platform_id: '123',
  title: 'Singapore', album: 'A Great Chaos', artist: 'Ken Carson',
  artists: ['Ken Carson', 'Destroy Lonely'], artist_ids: { deezer: '2568121' },
  duration: 150, preview: 'https://example.test/preview.mp3',
};
const recommendation = (track: Track): RecItem => ({
  rank: 1, track, score: 1, coverage: 1, tier: 'core', evidence: 'strong',
  best_seed: null, reasons: [], uncertainty: [], new_release: false,
  factors: {}, weights: {}, sources: [],
  playback: { preview: track.preview, embed: null, open: [] },
}) as unknown as RecItem;

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
});
const draw = async (element: ReactElement) => act(async () => root.render(element));

const surfaces = ['Search.TrackList', 'Results recommendation', 'Results seed', 'SavedView'] as const;
type Surface = typeof surfaces[number];
function fixture(surface: Surface, track = song, navigation = true) {
  const play = vi.fn();
  const openAlbum = vi.fn();
  const openArtist = vi.fn();
  const nav = navigation ? { onOpenAlbum: openAlbum, onOpenArtist: openArtist } : {};
  let element: ReactElement;
  if (surface === 'Search.TrackList') {
    element = <TrackList tracks={[track]} seedKeys={new Set()} onAdd={() => {}} onPreview={play} label="Search songs" {...nav} />;
  } else if (surface === 'SavedView') {
    element = <SavedView saved={[{ track, ts: 1 }] as never} lists={[]} onLists={() => {}} onPreview={play} onRemoveSaved={() => {}} {...nav} />;
  } else {
    element = <Results seeds={surface === 'Results seed' ? [track] : []} items={surface === 'Results recommendation' ? [recommendation(track)] : []}
      onRemoveSeed={() => {}} onEmphasis={() => {}} focusKey={null} playingKey={null} flags={{}}
      onFocus={() => {}} onPlay={play} onPlayTrack={play} onFeedback={() => {}} {...nav} />;
  }
  return { element, play, openAlbum, openArtist };
}
function rowParts() {
  const row = host.querySelector<HTMLElement>('li.track, li.rec');
  expect(row).toBeTruthy();
  const text = row!.querySelector<HTMLElement>('.track__text, .rec__text')!;
  const title = text.querySelector<HTMLElement>('.track__title, .rec__title')!;
  const artists = text.querySelector<HTMLElement>('.track__artist, .rec__artist')!;
  return { row: row!, text, title, artists };
}
function precedes(a: Element, b: Element) {
  expect(Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
}

for (const surface of surfaces) describe(surface, () => {
  it('puts a text-only album button between the song title and all artist names, outside the action rail', async () => {
    const f = fixture(surface);
    await draw(f.element);
    const { row, text, title, artists } = rowParts();
    const album = text.querySelector<HTMLButtonElement>('button.song-credits__album');
    expect(album).toBeTruthy();
    expect(title.textContent).toBe('Singapore');
    expect(album!.textContent?.trim()).toBe('A Great Chaos');
    expect(album!.type).toBe('button');
    expect(album!.matches('.iconbtn')).toBe(false);
    expect(album!.querySelector('svg, .iconbtn')).toBeNull();
    expect(album!.closest('.track__actions, .rec__actions')).toBeNull();
    expect(artists.textContent).toBe('Ken Carson, Destroy Lonely');
    precedes(title, album!);
    precedes(album!, artists);
    expect(row.querySelector('.album-gap')).toBeNull();
    expect(row.querySelector('.track__actions [aria-label^="Open the album"], .rec__actions [aria-label^="Open the album"]')).toBeNull();
    expect([...text.querySelectorAll('*')].filter((el) => el.children.length === 0 && el.textContent?.trim() === song.album)).toHaveLength(1);
  });

  it('opens the album and each credited artist without playing the song, including nested Enter events', async () => {
    const f = fixture(surface);
    await draw(f.element);
    const { text, artists } = rowParts();
    const album = text.querySelector<HTMLButtonElement>('button.song-credits__album');
    expect(album).toBeTruthy();
    const names = [...artists.querySelectorAll<HTMLButtonElement>('button')];
    expect(names.map((b) => b.textContent)).toEqual(['Ken Carson', 'Destroy Lonely']);
    await act(async () => {
      for (const b of [album!, ...names]) {
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        b.click();
      }
    });
    expect(f.openAlbum.mock.calls).toEqual([[song]]);
    expect(f.openArtist.mock.calls).toEqual([
      [{ id: 'dz:2568121', name: 'Ken Carson' }],
      [{ name: 'Destroy Lonely' }],
    ]);
    expect(f.play).not.toHaveBeenCalled();
    // Control: this fixture really is playable, so a navigation regression cannot hide behind a disabled player.
    const playButton = host.querySelector<HTMLButtonElement>('button[aria-label="Play Singapore"]');
    expect(playButton).toBeTruthy();
    expect(playButton!.disabled).toBe(false);
    await act(async () => playButton!.click());
    expect(f.play).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, '', '   '])('omits a missing/blank album (%j), leaving artists immediately after the title', async (album) => {
    const f = fixture(surface, { ...song, album } as typeof song);
    await draw(f.element);
    const { row, text, title, artists } = rowParts();
    expect(text.querySelector('.song-credits__album')).toBeNull();
    expect(row.querySelector('.album-gap, [aria-label^="Open the album"]')).toBeNull();
    expect(artists.textContent).toBe('Ken Carson, Destroy Lonely');
    // No empty album slot or separator between the title and artists; wrappers are intentionally unconstrained.
    expect(text.textContent).toBe('SingaporeKen Carson, Destroy Lonely');
    precedes(title, artists);
  });

  it('keeps a known same-title single album clickable instead of suppressing it', async () => {
    const single = { ...song, album: 'Singapore', kind: 'single' };
    const f = fixture(surface, single);
    await draw(f.element);
    const { text, title, artists } = rowParts();
    const album = text.querySelector<HTMLButtonElement>('button.song-credits__album');
    expect(album?.textContent).toBe('Singapore');
    precedes(title, album!);
    precedes(album!, artists);
    await act(async () => album!.click());
    expect(f.openAlbum).toHaveBeenCalledWith(single);
    expect(f.play).not.toHaveBeenCalled();
  });

  it('renders SongCredits album and every artist as plain text when navigation callbacks are absent', async () => {
    // Exercise the shared credits through real consumers, without importing a not-yet-created production module.
    const f = fixture(surface, song, false);
    await draw(f.element);
    const { text, title, artists } = rowParts();
    const album = text.querySelector('.song-credits__album');
    expect(album?.textContent).toBe('A Great Chaos');
    expect(album!.matches('button, a')).toBe(false);
    expect(text.querySelector('button, a')).toBeNull();
    expect(artists.textContent).toBe('Ken Carson, Destroy Lonely');
    precedes(title, album!);
    precedes(album!, artists);
  });
});

it('allows album-page numbered search rows to suppress their duplicate album/self-link while retaining artist navigation', async () => {
  const album = vi.fn();
  const artist = vi.fn();
  await draw(<TrackList tracks={[song]} seedKeys={new Set()} onAdd={() => {}} onPreview={() => {}} label="Album songs" numbered onOpenAlbum={album} onOpenArtist={artist} />);
  const { text, artists } = rowParts();
  expect(text.querySelector('.song-credits__album')).toBeNull();
  expect(text.textContent).not.toContain('A Great Chaos');
  const guest = [...artists.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Destroy Lonely');
  expect(guest).toBeTruthy();
  await act(async () => guest!.click());
  expect(artist).toHaveBeenCalledWith({ name: 'Destroy Lonely' });
  expect(album).not.toHaveBeenCalled();
});
