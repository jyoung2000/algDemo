// ARTIST-FAV-001 (owner, 2026-11-21).
import { describe, expect, it } from 'vitest';
import { addFav, favSeed, isFav, normaliseFavs, removeFav, type FavArtist } from './fav-artists';

const fav = (name: string, more: Partial<FavArtist> = {}): FavArtist => ({ name, deezerId: null, fans: null, picture: null, pageId: null, addedAt: 1, ...more });

describe('starred artists (ARTIST-FAV-001)', () => {
  it('keeps one entry per artist however it is written, newest first, and drops junk', () => {
    const l = normaliseFavs([{ name: 'OsamaSon', addedAt: 1 }, { name: 'osamason', addedAt: 3 }, { name: '' }, null, { name: 'Summrs', addedAt: 2, pageId: 'dz:13807305', fans: 10708.4 }]);
    expect(l.map((a) => a.name)).toEqual(['osamason', 'Summrs']);
    expect(l[1]).toMatchObject({ deezerId: '13807305', fans: 10708, pageId: 'dz:13807305' });
  });
  it('adds to the top, replaces an artist starred again, and removes by name', () => {
    let l = addFav([], fav('Summrs', { addedAt: 1 }));
    l = addFav(l, fav('OsamaSon', { addedAt: 2 }));
    l = addFav(l, fav('summrs', { addedAt: 3 }));
    expect(l.map((a) => a.name)).toEqual(['summrs', 'OsamaSon']);
    expect(isFav(l, 'SUMMRS')).toBe(true);
    // An unknown size survives being stored and read back as unknown, not as zero followers.
    expect(normaliseFavs(JSON.parse(JSON.stringify(l)))[0]!.fans).toBeNull();
    expect(removeFav(l, 'Summrs').map((a) => a.name)).toEqual(['OsamaSon']);
  });
  it('becomes a starting point named by the artist, with only its Deezer artist id as a profile', () => {
    const { seed, profile } = favSeed(fav('OsamaSon'), '141771412');
    expect(seed).toMatchObject({ key: 'fav-artist|osamason', artists: ['OsamaSon'], fav_artist: true, emphasis: 1 });
    expect(profile).toEqual({ dz: { artist_ids: { deezer: '141771412' } }, ytm_vid: null, dz_uncertain: [] });
    expect(favSeed(fav('Unknown'), null).profile.dz).toBeNull();
  });
});
