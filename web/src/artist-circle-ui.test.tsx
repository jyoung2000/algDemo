// @vitest-environment happy-dom
// ARTIST-CIRCLE-001: the artist page's Frequent collaborators and Similar artists sections.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { ArtistCircle } from './ArtistCircle';
import type { Track } from './api';

afterEach(cleanup);
const t = (title: string, artists: string[]) => ({ id: title, key: `k:${title}`, provider: 'deezer', platform_id: title, title, artists, artist: artists[0] }) as Track;
const songs = [t('One', ['Ken Carson', 'Destroy Lonely']), t('Two', ['Ken Carson', 'Destroy Lonely']), t('Three', ['Ken Carson', 'Lil Uzi Vert'])];
const similar = [{ id: 'dz:9', provider: 'deezer' as const, name: 'Yeat', picture: 'y.jpg', detail: null, url: '', from: ['deezer', 'ytmusic'] as ('deezer' | 'ytmusic')[] }];

describe('the artist circle', () => {
  it('lists frequent collaborators with how many songs, and similar artists with where they came from; each opens its page', () => {
    const onOpenArtist = vi.fn();
    const { container } = render(createElement(ArtistCircle, { name: 'Ken Carson', songs, features: [], similar, waiting: false, onOpenArtist }));
    const heads = [...container.querySelectorAll('h3')].map((h) => h.textContent);
    expect(heads).toEqual(['Frequent collaborators (1)', 'Similar artists (1)']);
    const collab = container.querySelector<HTMLButtonElement>('[aria-label="Open Destroy Lonely, 2 songs together"]')!;
    expect(collab.textContent).toContain('2 songs together');
    expect(container.textContent).not.toContain('Lil Uzi Vert');
    fireEvent.click(collab);
    expect(onOpenArtist).toHaveBeenLastCalledWith({ name: 'Destroy Lonely' });
    const sim = container.querySelector<HTMLButtonElement>('[aria-label="Open Yeat"]')!;
    expect(sim.textContent).toMatch(/Deezer.*YouTube Music/);
    expect(container.textContent).toContain('Deezer’s related artists');
    fireEvent.click(sim);
    expect(onOpenArtist).toHaveBeenLastCalledWith({ id: 'dz:9', name: 'Yeat' });
  });
  it('says plainly when there is nothing, and that it is still looking while songs load', () => {
    const { container, rerender } = render(createElement(ArtistCircle, { name: 'Solo', songs: [t('Alone', ['Solo'])], features: [], similar: [], waiting: true, onOpenArtist: () => {} }));
    expect(container.textContent).toContain('Looking through Solo’s songs for collaborators');
    rerender(createElement(ArtistCircle, { name: 'Solo', songs: [t('Alone', ['Solo'])], features: [], similar: [], waiting: false, onOpenArtist: () => {} }));
    expect(container.textContent).toContain('No artist shares 2 or more songs with Solo');
    expect(container.textContent).toContain('Neither Deezer nor YouTube Music listed similar artists for Solo.');
  });
});
