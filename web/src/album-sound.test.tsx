// @vitest-environment happy-dom
/**
 * ALBUM-SOUND-001. Owner: "when an album is opened a your sound color bar should let you see the
 * colour gradient for the album so the user can see what the album sounds like."
 *
 * The album page draws the same Sound card the listener's own taste and a saved list use, read from
 * the genres of the album's songs. When no genre is known for any of them it says so instead of
 * inventing a gradient.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AlbumMix, AlbumView as Album } from './api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const track = (i: number) => ({
  key: `k${i}`, id: `dz:${i}`, provider: 'deezer', platform_id: String(i),
  title: `Song ${i}`, artists: ['Sasha Keable'], album: 'Tiny Desk', artwork: null,
  duration: 130, isrc: null, url: 'https://deezer.com/track/1', source: null, tags: [],
});

const album = (mix: AlbumMix | null): Album => ({
  id: 'dz:album:1', provider: 'deezer', title: 'Live From NPR\u2019s Tiny Desk', artist: 'Sasha Keable',
  artwork: null, year: 2026, kind: 'ep', url: 'https://deezer.com/album/1',
  tracks: [track(1), track(2), track(3)], duration: 390, genres: [],
  ...(mix ? { mix } : {}),
} as unknown as Album);

const mixWith = (placed: number): AlbumMix => ({
  songs: 3,
  placed,
  taste: placed
    ? {
        events: placed, positives: placed, negatives: 0, bpm: null, skip_bpm: null,
        likes: [
          { name: 'r&b', label: 'R&B', score: 0.6, plays: 2 },
          { name: 'neo soul', label: 'Neo soul', score: 0.4, plays: 1 },
        ] as never,
        avoids: [],
        genres: [
          { name: 'r&b', label: 'R&B', score: 0.6, plays: 2 },
          { name: 'neo soul', label: 'Neo soul', score: 0.4, plays: 1 },
        ] as never,
      }
    : null,
});

let root: Root;
let host: HTMLDivElement;
const api = { album: vi.fn(), playlists: vi.fn(async () => []), saved: vi.fn(async () => []) };
vi.mock('./api', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, api: { ...(real['api'] as object), album: (...a: unknown[]) => api.album(...a) } };
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const open = async (a: Album) => {
  api.album.mockResolvedValue({ album: a });
  const { AlbumView } = await import('./Albums');
  await act(async () => {
    root.render(
      <AlbumView
        target={{ id: a.id }} onBack={() => {}} onPreview={() => {}} seedKeys={new Set()}
        onAdd={() => {}} onLike={() => {}} onRemoveSeed={() => {}} lists={[]} onLists={() => {}}
        addedKeys={new Set()} playingKey={null}
      />,
    );
  });
  await act(async () => { await Promise.resolve(); });
};

describe('an album shows what it sounds like (ALBUM-SOUND-001)', () => {
  it('draws the sound card for the album', async () => {
    await open(album(mixWith(3)));
    const card = host.querySelector('.sound');
    expect(card).toBeTruthy();
    // ALBUM-TIDY-001 (owner, 2026-11-22): "on the album page get rid of the sound of album name label". The name stays
    // for screen readers only.
    expect(card!.getAttribute('aria-label')).toContain('Sound of');
    expect(card!.querySelector('.sound__title .sr')?.textContent).toContain('Sound of');
    expect([...card!.querySelector('.sound__title')!.childNodes].filter((n) => n.nodeType === 3 && n.textContent!.trim())).toHaveLength(0);
  });

  // ALBUM-NOTE-001 (owner, 2026-11-22): "remove the label under the color algorithim bar on the album page". The line
  // "From the genres of the N songs on this album. It redraws\u2026" is not printed; it stays for screen readers, and
  // it takes no room under the bar.
  it('prints no line under a drawn bar', async () => {
    await open(album(mixWith(3)));
    const card = host.querySelector('.sound')!;
    expect(card.querySelector('.sound__grad')!.getAttribute('style') ?? '').toMatch(/--c0:/);
    expect(card.querySelector('.sound__changes')).toBeNull();
    const note = card.querySelector('p[role="status"]')!;
    expect(note.className).toBe('sr');
    expect(note.textContent).toMatch(/From the genres of the/);
  });

  it('colours the bar by genre, like the listener\u2019s own sound', async () => {
    await open(album(mixWith(3)));
    // The gradient bar carries one --cN colour stop per genre share.
    const grad = host.querySelector('.sound__grad') as HTMLElement | null;
    expect(grad).toBeTruthy();
    expect(grad!.getAttribute('style') ?? '').toMatch(/--c0:/);
  });

  it('says when no genre is known yet instead of drawing a gradient', async () => {
    await open(album(mixWith(0)));
    expect(host.textContent).toMatch(/No genre known yet/i);
    // The bar is drawn empty, not coloured out of nothing.
    expect(host.querySelector('.sound__grad--empty')).toBeTruthy();
    expect(host.querySelector('.sound__grad')!.getAttribute('style')).toBeNull();
  });

  it('draws no card at all for an album with no songs', async () => {
    const a = album(null);
    (a as { tracks: unknown[] }).tracks = [];
    await open(a);
    expect(host.querySelector('.sound')).toBeNull();
  });
});
