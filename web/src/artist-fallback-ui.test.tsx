// @vitest-environment happy-dom
/**
 * ARTIST-FALLBACK-001, the screen half: a name no service has a page for shows what this app holds
 * by it, under a plain note - never the red "No artist named ..." alert the owner photographed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArtistView as ArtistData } from './api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const held = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `k${i}`, id: `yt:${i}`, provider: 'ytmusic', platform_id: String(i), title: `Song ${i + 1}`,
    artists: ['jackiegalama'], album: null, artwork: null, duration: 180, isrc: null,
    url: 'https://music.youtube.com/watch?v=1', source: null, tags: [],
  }));

const page = (songs: number): ArtistData => ({
  id: 'local:jackiegalama', name: 'jackiegalama', picture: null, detail: null, local: true,
  songs: held(songs) as never, features: [], albums: [], singles: [], links: {},
  sources: { deezer: { state: 'none' }, ytmusic: { state: 'none' } },
} as unknown as ArtistData);

const artist = vi.fn();
vi.mock('./api', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, api: { ...(real['api'] as object), artist: (...a: unknown[]) => artist(...a) } };
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); });

const open = async (a: ArtistData) => {
  artist.mockResolvedValue({ artist: a });
  const { ArtistView } = await import('./Artists');
  await act(async () => {
    root.render(<ArtistView target={{ name: a.name }} onBack={() => {}} onPreview={() => {}} onOpenAlbum={() => {}} onOpenArtist={() => {}} seedKeys={new Set()} onAdd={() => {}} addedKeys={new Set()} playingKey={null} />);
  });
  await act(async () => { await Promise.resolve(); });
};

describe('a name no service knows (ARTIST-FALLBACK-001)', () => {
  it('shows no error', async () => {
    await open(page(3));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toMatch(/No artist named/i);
  });

  it('says why the page is thin, and shows the songs held here', async () => {
    await open(page(3));
    expect(host.textContent).toMatch(/Neither Deezer nor YouTube Music has a page for/i);
    expect(host.textContent).toMatch(/songs you already have by them/i);
  });

  it('says so plainly when nothing is held by that name', async () => {
    await open(page(0));
    expect(host.textContent).toMatch(/no songs by them yet/i);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
