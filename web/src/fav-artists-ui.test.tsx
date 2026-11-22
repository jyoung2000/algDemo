// @vitest-environment happy-dom
// ARTIST-FAV-001 (owner, 2026-11-21): "let the user favorite and star artist ... Also let the user see and edit their
// artist list in the settings".
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({ list: [] as { name: string; deezerId: string | null; fans: number | null; picture: string | null; pageId: string | null; addedAt: number }[] }));
vi.mock('./api', () => ({
  api: {
    favArtists: vi.fn(async () => ({ artists: server.list })),
    editFavArtists: vi.fn(async (body: { op: string; artist?: { name: string; pageId?: string; fans?: number | null }; name?: string }) => {
      if (body.op === 'add' && body.artist) server.list = [{ name: body.artist.name, deezerId: null, fans: body.artist.fans ?? null, picture: null, pageId: body.artist.pageId ?? null, addedAt: Date.now() }, ...server.list.filter((a) => a.name.toLowerCase() !== body.artist!.name.toLowerCase())];
      if (body.op === 'remove') server.list = server.list.filter((a) => a.name.toLowerCase() !== String(body.name).toLowerCase());
      return { artists: server.list };
    }),
  },
}));

import { ArtistStarButton, FavArtistsSettings } from './FavArtists';
import { ArtistCard } from './ArtistLinks';
import { readFileSync } from 'node:fs';
import { favArtistsStore } from './fav-artists-store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => { server.list = []; favArtistsStore.reset(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('starring an artist (ARTIST-FAV-001)', () => {
  it('the artist page’s star adds the artist, says so, and a second press removes it', async () => {
    await act(async () => root.render(<ArtistStarButton artist={{ id: 'dz:141771412', name: 'OsamaSon', picture: null, fans: 21296 }} />));
    await flush();
    const btn = host.querySelector('button')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Star OsamaSon: your discovery takes this artist into account');
    await act(async () => btn.click()); await flush();
    expect(server.list.map((a) => a.name)).toEqual(['OsamaSon']);
    expect(server.list[0]).toMatchObject({ pageId: 'dz:141771412', fans: 21296 });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Unstar OsamaSon');
    await act(async () => btn.click()); await flush();
    expect(server.list).toEqual([]);
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('Settings lists the starred artists, removes one, and adds one by name', async () => {
    server.list = [{ name: 'OsamaSon', deezerId: '1', fans: null, picture: null, pageId: null, addedAt: 2 }, { name: 'Summrs', deezerId: null, fans: null, picture: null, pageId: null, addedAt: 1 }];
    await act(async () => root.render(<FavArtistsSettings />));
    await flush();
    const names = () => [...host.querySelectorAll('.fav-artists__name')].map((n) => n.textContent);
    expect(names()).toEqual(['OsamaSon', 'Summrs']);
    await act(async () => (host.querySelector('button[aria-label="Remove Summrs from your artists"]') as HTMLButtonElement).click()); await flush();
    expect(names()).toEqual(['OsamaSon']);
    const input = host.querySelector('input#fav-artist-add') as HTMLInputElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, '  Nettspend '); input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (host.querySelector('form.fav-artists__add') as HTMLFormElement).requestSubmit()); await flush();
    expect(names()).toEqual(['Nettspend', 'OsamaSon']);
    expect(input.value).toBe('');
  });

  // ARTIST-STAR-LOOK-001 (owner, 2026-11-21): "the star on the artist page should be black and white until tapped then
  // gets blue and white filled tapped, also add a star button to the artist search results".
  it('the star is black and white until tapped, then a blue disc with a filled white star', async () => {
    await act(async () => root.render(<ArtistStarButton artist={{ id: 'dz:1', name: 'OsamaSon', picture: null }} />));
    await flush();
    const btn = host.querySelector('button')!;
    expect(btn.className).not.toMatch(/push--default/);
    const outline = btn.innerHTML;
    await act(async () => btn.click()); await flush();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.innerHTML).not.toBe(outline); // the filled star
    const css = readFileSync(`${process.cwd()}/src/fav-artists.css`, 'utf8');
    expect(css).toMatch(/\.artist__star\[aria-pressed='false'\][^{]*\{[^}]*background:\s*#fff[^}]*color:\s*var\(--ink\)[^}]*box-shadow:\s*inset 0 0 0 1px var\(--hair\)/);
    expect(css).toMatch(/\.artist__star\[aria-pressed='true'\][^{]*\{[^}]*background:\s*var\(--accent\)[^}]*color:\s*#fff/);
  });

  it('an artist in the search results has its own star', async () => {
    await act(async () => root.render(<ArtistCard artist={{ id: 'dz:7', provider: 'deezer', name: 'OsamaSon', picture: null, detail: '21,296 fans', fans: 21296, url: '' }} onOpen={() => {}} />));
    await flush();
    const star = host.querySelector('button[aria-label="Star OsamaSon: your discovery takes this artist into account"]') as HTMLButtonElement;
    expect(star).not.toBeNull();
    await act(async () => star.click()); await flush();
    expect(server.list[0]).toMatchObject({ name: 'OsamaSon', pageId: 'dz:7', fans: 21296 });
  });

  it('an empty list says how to add artists', async () => {
    await act(async () => root.render(<FavArtistsSettings />));
    await flush();
    expect(host.textContent).toMatch(/No starred artists yet/);
  });
});
