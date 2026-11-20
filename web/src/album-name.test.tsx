// @vitest-environment happy-dom
// ALBUM-NAME-001 (owner, 2026-11-20): "sometimes albums are called the first song title instead of the album name".
// Measured: 16 of 83 Discover rows on Windows and 54 of 138 on the phone showed the song's own title as its album
// ("Look Back at It" for A Boogie's song from Hoodie SZN): services had answered with the single, not the album.
// Now a single's name is never shown as the album, and the genre look-up also finds the album the song is on.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { albumFromMusicBrainz, realAlbumFrom, singleNamed, wantsAlbum } from './engine/album-name';
import { SongCredits } from './SongCredits';
import { mergeGenres, rowPlaced } from './useQueueGenres';
import type { RecItem, RecResult, Track } from './api';

afterEach(cleanup);
const t = (title: string, album: string | null, artists = ['A Boogie Wit da Hoodie'], extra: Record<string, unknown> = {}) => ({ key: `${artists[0]}|${title}`, title, album, artists, provider: 'deezer', platform_id: title, ...extra }) as unknown as Track;

describe('singleNamed', () => {
  it('the album is only the song\'s own name (feat. parts and case ignored), or marked as a single', () => {
    expect(singleNamed(t('Look Back at It', 'Look Back at It'))).toBe(true);
    expect(singleNamed(t('Upper Echelon (feat. T.I. & 2 Chainz)', 'Upper Echelon'))).toBe(true);
    expect(singleNamed(t('WTF GOIN (feat. 21 Savage)', 'WTF GOIN (feat. 21 Savage)'))).toBe(true);
    expect(singleNamed(t('Rich Flex', 'Rich Flex - Single'))).toBe(true);
    expect(singleNamed(t('Look Back at It', 'Hoodie SZN'))).toBe(false);
    expect(singleNamed(t('Look Back at It', null))).toBe(false);
  });
  it('wantsAlbum: a single-named row not yet checked', () => {
    expect(wantsAlbum(t('Look Back at It', 'Look Back at It'))).toBe(true);
    expect(wantsAlbum(t('Look Back at It', 'Look Back at It', undefined, { album_looked: 2 }))).toBe(false);
    expect(wantsAlbum(t('Look Back at It', 'Hoodie SZN'))).toBe(false);
  });
});

describe('realAlbumFrom', () => {
  const song = t('Look Back at It', 'Look Back at It');
  it('the same song by the same artist on a real album', () => {
    const cands = [t('Look Back at It', 'Look Back at It', undefined, { album_id: '1' }), t('Look Back at It', 'Hoodie SZN', undefined, { album_id: '2' }), t('Look Back at It', 'Rap Hits 2019', ['Various'], { album_id: '3' })];
    expect(realAlbumFrom(song, cands as never)).toEqual({ album: 'Hoodie SZN', album_id: '2' });
  });
  it('another song, or only the single: nothing', () => {
    expect(realAlbumFrom(song, [t('Drowning', 'Hoodie SZN')] as never)).toBeNull();
    expect(realAlbumFrom(song, [t('Look Back at It', 'Look Back at It')] as never)).toBeNull();
  });
  it('a compilation by other artists never counts', () => {
    expect(realAlbumFrom(song, [t('Look Back at It', 'Hip Hop Hits', ['Various Artists'])] as never)).toBeNull();
  });
});

describe('song rows', () => {
  it('a single reads "Single" (still opening the single), never the song title posing as the album; a real album shows', () => {
    const open = (() => undefined) as never;
    render(<SongCredits track={t('Look Back at It', 'Look Back at It')} onOpenAlbum={open} />);
    expect(screen.queryByText('Look Back at It')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open the single Look Back at It' }).textContent).toBe('Single');
    cleanup();
    render(<SongCredits track={t('Look Back at It', 'Hoodie SZN')} />);
    expect(screen.getByText('Hoodie SZN')).toBeTruthy();
  });
});

describe('the queue asks the engine about such rows, and takes the album it finds', () => {
  const item = { track: t('Look Back at It', 'Look Back at It'), rank: 1, reasons: [], playback: {}, characteristics: { genres: ['hip hop'], family: 'Hip-hop' } } as unknown as RecItem;
  it('a row with genres but a single-named album still counts as not placed', () => {
    expect(rowPlaced(item)).toBe(false);
    expect(rowPlaced({ ...item, track: { ...item.track, album_looked: 2 } as never })).toBe(true);
  });
  it('the answer\'s album lands on the row', () => {
    const r = mergeGenres({ items: [item] } as unknown as RecResult, [{ key: item.track.key, tags: [], characteristics: {} as never, album: 'Hoodie SZN', album_id: '2', album_looked: 2 }]);
    expect(r.items[0]!.track).toMatchObject({ album: 'Hoodie SZN', album_id: '2', album_looked: 2 });
  });
  it('the engine looks it up in the same pass as genres', () => {
    const api = readFileSync(resolve(process.cwd(), 'src', 'engine', 'local-api.ts'), 'utf8');
    expect(api).toMatch(/wantsAlbum\(dated\)[\s\S]{0,600}realAlbumFrom\(/);
  });
});

describe('albumFromMusicBrainz (Deezer often lists only the single)', () => {
  type R = [string, string, string[], string?, string?, string?];
  const rec = (title: string, artist: string, releases: R[]) => ({ title, 'artist-credit': [{ name: artist }],
    releases: releases.map(([t, type, sec, date, status = 'Official', relArtist]) => ({ title: t, date, status, ...(relArtist ? { 'artist-credit': [{ name: relArtist }] } : {}), 'release-group': { 'primary-type': type, 'secondary-types': sec } })) });
  const song = t('Wake Up in the Sky', 'Wake Up in the Sky', ['Gucci Mane', 'Bruno Mars']);
  it('the artist\'s own official album, earliest first; singles, compilations, live and remix releases never', () => {
    const body = { recordings: [
      rec('Wake Up in the Sky', 'Gucci Mane', [['Wake Up in the Sky', 'Single', []], ['Now Hip Hop 2019', 'Album', ['Compilation'], '2019'], ['Evil Genius (Deluxe)', 'Album', [], '2019-02-01'], ['Evil Genius', 'Album', [], '2018-12-07']]),
      rec('Wake Up in the Sky', 'Tribute Band', [['Covers', 'Album', [], '2019']]),
    ] };
    expect(albumFromMusicBrainz(body, song)).toEqual({ album: 'Evil Genius', titleTrack: false });
  });
  it('bootlegs never count; nothing suitable gives null', () => {
    expect(albumFromMusicBrainz({ recordings: [rec('Wake Up in the Sky', 'Gucci Mane', [['Red', 'Album', ['Mixtape/Street'], '2014', 'Bootleg'], ['In Abundance', 'Album', [], '2016', 'Bootleg']])] }, song)).toBeNull();
    expect(albumFromMusicBrainz({ recordings: [rec('Wake Up in the Sky', 'Gucci Mane', [['Wake Up in the Sky', 'Single', []]])] }, song)).toBeNull();
    expect(albumFromMusicBrainz({}, song)).toBeNull();
  });
  it('a mixtape counts when there is no album, but not one credited to other artists (Owl Pharaoh, not the XXL tape)', () => {
    const upper = t('Upper Echelon (feat. T.I. & 2 Chainz)', 'Upper Echelon', ['Travis Scott']);
    const body = { recordings: [rec('Upper Echelon', 'Travis Scott', [['2013 XXL Freshmen Mixtape', 'Album', ['Mixtape/Street'], '2013', 'Official', 'Various Artists'], ['Owl Pharaoh', 'Album', ['Mixtape/Street'], '2013-05-21']])] };
    expect(albumFromMusicBrainz(body, upper)).toEqual({ album: 'Owl Pharaoh', titleTrack: false });
  });
  it('a studio album beats a mixtape; a title track is a real album (Honest on Honest)', () => {
    const honest = t('Honest', 'Honest', ['Future']);
    const body = { recordings: [rec('Honest', 'Future', [['5 Years In Jersey', 'Album', ['Mixtape/Street'], '2013'], ['Honest', 'Album', [], '2014']])] };
    expect(albumFromMusicBrainz(body, honest)).toEqual({ album: 'Honest', titleTrack: true });
  });
  it('a confirmed title track shows its album on the row', () => {
    render(<SongCredits track={t('Honest', 'Honest', ['Future'], { album_confirmed: true })} />);
    expect(screen.getByText('Honest')).toBeTruthy();
  });
  it('the engine asks MusicBrainz when Deezer has only the single', () => {
    const api = readFileSync(resolve(process.cwd(), 'src', 'engine', 'local-api.ts'), 'utf8');
    expect(api).toMatch(/realAlbumFrom\([\s\S]{0,900}musicbrainz\.org\/ws\/2\/recording[\s\S]{0,600}albumFromMusicBrainz\(/);
  });
});
