// @vitest-environment happy-dom
// PLAYER-ARTIST-HEART-001 (owner, 2026-11-22): where the volume was, "a button and icon to heart the current playing
// artist on the song and add them to your listening algorithim". It stars the song's artists (the same list the
// artist pages, Profile and the car's Star the artist button use), so discovery takes them into account.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const book = vi.hoisted(() => ({ artists: [] as { name: string }[], calls: [] as unknown[] }));
vi.mock('./api', () => ({
  api: {
    favArtists: vi.fn(async () => ({ artists: book.artists, algorithm: { id: 'a', name: 'A' } })),
    editFavArtists: vi.fn(async (b: { op: string; artist?: { name: string }; name?: string }) => {
      book.calls.push(b);
      if (b.op === 'add' && !book.artists.some((x) => x.name === b.artist!.name)) book.artists = [...book.artists, { name: b.artist!.name }];
      if (b.op === 'remove') book.artists = book.artists.filter((x) => x.name.toLowerCase() !== b.name!.toLowerCase());
      return { artists: book.artists, algorithm: { id: 'a', name: 'A' } };
    }),
  },
}));
import { PlayingArtistHeart } from './FavArtists';
import { favArtistsStore } from './fav-artists-store';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, f), 'utf8').replace(/\r\n/g, '\n');
beforeEach(() => { book.artists = []; book.calls = []; favArtistsStore.reset(); });
afterEach(() => cleanup());
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const btn = () => screen.getByRole('button') as HTMLButtonElement;

describe('the player\u2019s heart for the artist of the song playing', () => {
  it('stars every artist credited on the song, and then shows as on', async () => {
    render(<PlayingArtistHeart artists={['Daft Punk', 'Julian Casablancas']} />);
    await settle();
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    expect(btn().getAttribute('aria-label')).toBe('Star Daft Punk, Julian Casablancas: your discovery takes these artists into account');
    fireEvent.click(btn());
    await settle();
    expect(book.calls).toEqual([{ op: 'add', artist: expect.objectContaining({ name: 'Daft Punk' }) }, { op: 'add', artist: expect.objectContaining({ name: 'Julian Casablancas' }) }]);
    expect(btn().getAttribute('aria-pressed')).toBe('true');
    expect(btn().getAttribute('aria-label')).toBe('Unstar Daft Punk, Julian Casablancas');
  });

  it('adds only the artists not starred yet, and a second press takes them all off', async () => {
    book.artists = [{ name: 'daft punk' }];
    render(<PlayingArtistHeart artists={['Daft Punk', 'Julian Casablancas']} />);
    await settle();
    expect(btn().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn());
    await settle();
    expect(book.calls).toEqual([{ op: 'add', artist: expect.objectContaining({ name: 'Julian Casablancas' }) }]);
    book.calls = [];
    fireEvent.click(btn());
    await settle();
    expect(book.calls).toEqual([{ op: 'remove', name: 'Daft Punk' }, { op: 'remove', name: 'Julian Casablancas' }]);
    expect(btn().getAttribute('aria-pressed')).toBe('false');
  });

  it('names one artist in the singular, and is off when no artist is known', async () => {
    const { rerender } = render(<PlayingArtistHeart artists={['Sade']} />);
    await settle();
    expect(btn().getAttribute('aria-label')).toBe('Star Sade: your discovery takes this artist into account');
    rerender(<PlayingArtistHeart artists={[]} />);
    expect(btn().disabled).toBe(true);
    expect(btn().getAttribute('aria-label')).toBe('Star the artist: no artist is known for what is playing');
    fireEvent.click(btn());
    await settle();
    expect(book.calls).toEqual([]);
  });

  it('is a person with a heart, not the song\u2019s own heart beside it', async () => {
    const { container } = render(<PlayingArtistHeart artists={['Sade']} />);
    await settle();
    expect(container.querySelector('svg.glyph--artist-heart')).toBeTruthy();
    expect(container.querySelectorAll('svg path, svg circle').length).toBeGreaterThanOrEqual(3);
  });

  it('takes the volume\u2019s place in the song player, on the phone row and on the desktop bar, and in the radio player', () => {
    const p = src('Player.tsx');
    expect(p).toMatch(/only=\{\['download', 'similar'\]\}[^\n]*\/>\s*\{artistHeart\}\s*<\/div>/);
    expect(p).toMatch(/<div className="np__side">\s*\{artistHeart\}\s*<PlayerActions/);
    expect(p).not.toMatch(/\{volume\}/);
    expect(src('RadioPlayer.tsx')).toMatch(/<div className="radio-player__side">\s*<PlayingArtistHeart /);
  });
});
