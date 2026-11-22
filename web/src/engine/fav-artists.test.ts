// ARTIST-FAV-001 (owner, 2026-11-21).
import { describe, expect, it } from 'vitest';
import { addFav, favMap, favSeed, isFav, normaliseFavs, removeFav, type FavArtist } from './fav-artists';
import { BUILT_IN_ALGORITHM, parseAlgorithmFile, serializeAlgorithm } from './algorithms';

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

describe('starred artists travel with their algorithm (ARTIST-FAV-ALGO-001)', () => {
  it('reads an old bare list as the active algorithm\u2019s and keeps lists per algorithm id', () => {
    expect(Object.keys(favMap([{ name: 'OsamaSon' }], 'user-a'))).toEqual(['user-a']);
    const m = favMap({ 'user-a': [{ name: 'Summrs' }], 'bad id!': [{ name: 'X' }] }, 'user-a');
    expect(Object.keys(m)).toEqual(['user-a']);
  });
  it('an exported algorithm carries its artists and an import gets them back in order', () => {
    const text = serializeAlgorithm(BUILT_IN_ALGORITHM, [fav('OsamaSon', { deezerId: '7', fans: 21296, picture: 'https://x/p.jpg', addedAt: 2 }), fav('Summrs', { addedAt: 1 })]);
    const file = JSON.parse(text);
    expect(file.algorithm.artists).toEqual([{ name: 'OsamaSon', deezerId: '7', fans: 21296, pageId: null }, { name: 'Summrs', deezerId: null, fans: null, pageId: null }]);
    const back = parseAlgorithmFile(text);
    expect(back.artists.map((a) => [a.name, a.deezerId, a.fans])).toEqual([['OsamaSon', '7', 21296], ['Summrs', null, null]]);
  });
  it('a file from before has no artists, and artists that are not a list are refused', () => {
    expect(parseAlgorithmFile(serializeAlgorithm(BUILT_IN_ALGORITHM)).artists).toEqual([]);
    const bad = JSON.parse(serializeAlgorithm(BUILT_IN_ALGORITHM)); bad.algorithm.artists = 'OsamaSon';
    expect(() => parseAlgorithmFile(JSON.stringify(bad))).toThrow('The starred artists in this file must be a list.');
  });
});
