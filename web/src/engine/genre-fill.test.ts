import { describe, expect, it } from 'vitest';
import { eraLabel, fillGenres, isStyleWord, mainGenre, styleFamily, styleLabel, stylesFor, stylesFromArtist, stylesOfTags } from './genre-fill';
import type { Tag } from './genres';

/**
 * GENRE-ALL-001 — owner: "all songs need to have genres and sub genre tags".
 *
 * Measured first (2026-11-16): of 66 rows on the phone 30 showed no genre and 16 a main genre with no
 * subgenre; on Windows 53 of 61 showed none. Asking MusicBrainz about the artists showed why a
 * subgenre was so rare: its listeners DO name one ("sophisti-pop", "smooth soul", "contemporary r&b",
 * "new jack swing"), but every word the Taste Picker has no cell for was thrown away. And for an
 * artist nobody has tagged (Bob.B Randhawa, Sonder, Tyla) no service names a subgenre at all.
 *
 * So: a real word is shown even when the picker has no cell for it; and where nothing is stated the
 * gap is filled from what IS known, and marked as worked out, never passed off as the service's word.
 */
const T = (name: string, label = name, over: Partial<Tag> = {}): Tag => ({ name, label, source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false, ...over });
const mb = (name: string, ...tags: [string, number][]) => ({ artists: [{ name, score: 100, tags: tags.map(([n, count]) => ({ name: n, count })) }] });

describe('a real subgenre word the picker has no cell for (GENRE-ALL-001)', () => {
  it('knows a style word: a genre word with something said about it', () => {
    for (const w of ['sophisti-pop', 'smooth soul', 'jazz pop', 'pop soul', 'contemporary r&b', 'smooth jazz', 'pop rock', 'new jack swing', 'contemporary country', 'hip house', 'International Pop', 'quiet storm']) expect(isStyleWord(w), w).toBe(true);
  });

  it('does not take a plain genre, another spelling of one, or a word that is not about the music', () => {
    for (const w of ['pop', 'hip hop', 'Rap/Hip Hop', 'rnb', 'Soul & Funk', 'soul and funk', 'r&b soul', 'jazz and blues', 'dance and edm', "children's music", 'neo soul', 'female singer', 'female vocals', 'queer', 'ninjas', '2010s', 'icon', 'british', 'seen live', 'rock and roll hall of fame', 'american rock', '']) expect(isStyleWord(w), w).toBe(false);
  });

  it('reads the most-voted style words off MusicBrainz\u2019s answer for exactly that artist', () => {
    const sade = mb('Sade', ['smooth jazz', 7], ['soul', 4], ['jazz pop', 4], ['female singer', 4], ['contemporary r&b', 4], ['smooth soul', 3], ['sophisti-pop', 3]);
    expect(stylesFromArtist(sade, 'Sade')).toEqual(['smooth jazz', 'jazz pop']);
    expect(stylesFromArtist(sade, 'Sade Adu')).toEqual([]);
    expect(stylesFromArtist(mb('Tyla', ['spike', 1]), 'Tyla')).toEqual([]);
    expect(stylesFromArtist({ artists: [{ name: 'Sade', score: 80, tags: [{ name: 'smooth soul', count: 3 }] }] }, 'Sade')).toEqual([]);
  });

  it('reads a style word off a tag whose own word says more than the genre it was filed under', () => {
    expect(stylesOfTags([T('jazz', 'smooth jazz'), T('r&b', 'Contemporary R&B'), T('pop', 'Pop')])).toEqual(['smooth jazz', 'Contemporary R&B']);
    // A plain genre is not a style, on the picker or off it.
    expect(stylesOfTags([T('asian', 'Asian Music')])).toEqual([]);
    // A guess of ours is not a service's word.
    expect(stylesOfTags([T('jazz', 'smooth jazz', { inferred: true })])).toEqual([]);
  });

  it('names it in one case and gives it its genre\u2019s family', () => {
    expect(styleLabel('Contemporary R&B')).toBe('Contemporary R&B');
    expect(styleLabel('sophisti-pop')).toBe('Sophisti-pop');
    expect(styleLabel('uk hard house')).toBe('UK hard house');
    expect(styleLabel('Asian Music')).toBe('Asian music');
    expect(styleFamily('smooth soul')).toBe('soul-jazz-funk');
    expect(styleFamily('pop rock')).toBe('rock');
    expect(styleFamily('new jack swing')).toBe('rnb-afro-latin');
    expect(styleFamily('Asian Music')).toBeNull();
  });
});

describe('the styles shown on one song (GENRE-ALL-001)', () => {
  it('takes the song\u2019s own, then its artist\u2019s in the song\u2019s own genre, two at most, each once', () => {
    // "jazz pop" is a pop style; this song is filed under jazz, so it is not lent to it.
    expect(stylesFor([T('jazz', 'Jazz')], ['smooth jazz', 'jazz pop'])).toEqual(['Smooth jazz']);
    expect(stylesFor([T('jazz', 'smooth jazz')], ['Smooth Jazz', 'acid jazz', 'cool jazz'])).toEqual(['Smooth jazz', 'Acid jazz']);
    // A song nothing has placed takes what its artist is known for.
    expect(stylesFor([], ['smooth jazz', 'jazz pop'])).toEqual(['Smooth jazz', 'Jazz pop']);
    expect(stylesFor([T('pop', 'Pop')], undefined)).toEqual([]);
  });
});

describe('the era of a song is a subgenre nobody has to guess (GENRE-ALL-001)', () => {
  it('names the decade and the genre', () => {
    expect(eraLabel('Pop', 1982)).toBe('80s pop');
    expect(eraLabel('R&B', 1994)).toBe('90s R&B');
    expect(eraLabel('Hip-hop', 2016)).toBe('2010s hip-hop');
    expect(eraLabel('Country', 2025)).toBe('2020s country');
    expect(eraLabel('Jazz', 1938)).toBe('1930s jazz');
  });
});

describe('every song ends with a main genre and a subgenre (GENRE-ALL-001)', () => {
  const list = [
    { tags: [T('hip-hop', 'Rap/Hip Hop'), T('trap', 'trap', { source: 'MusicBrainz artist tags', scope: 'artist', confidence: 0.5 })], styles: [] },
    { tags: [T('hip-hop', 'Rap/Hip Hop')], styles: ['desi hip hop'] },
    { tags: [T('pop', 'Pop')], styles: [] },
    { tags: [T('hip-hop', 'hip hop')], styles: ['desi hip hop'] },
  ];

  it('adds nothing to a song the services already placed twice over', () => {
    expect(fillGenres({ tags: [T('hip-hop', 'Rap/Hip Hop'), T('rage', 'rage')], styles: [], year: 2023, artist: 'Ken Carson', list })).toEqual([]);
    expect(fillGenres({ tags: [T('jazz', 'Jazz')], styles: ['smooth jazz'], year: 1992, artist: 'Sade', list })).toEqual([]);
  });

  it('gives a song with a main genre and a year its era, and says that is where it came from', () => {
    expect(fillGenres({ tags: [T('pop', 'Pop')], styles: [], year: 1982, artist: 'Michael Jackson', list })).toEqual([{ label: '80s pop', sub: true, guess: false, why: 'Released in 1982' }]);
  });

  it('prefers the subgenre the artist\u2019s other songs carry, as an estimate', () => {
    const artistGenres = { 'ken carson': { 'hip-hop': 3, rage: 2.4, pop: 0.2 } };
    expect(fillGenres({ tags: [T('hip-hop', 'Rap/Hip Hop')], styles: [], year: 2023, artist: 'Ken Carson', artistGenres, list })).toEqual([{ label: 'Rage', sub: true, guess: true, why: 'The artist\u2019s other songs' }]);
  });

  it('with no year, lends the subgenre most songs of the same genre in the list carry', () => {
    // The row's own bubble reads "Rap" (Deezer's "Rap/Hip Hop"), so the note says rap; a list song a
    // service calls "hip hop" is the same genre and counts with it.
    expect(fillGenres({ tags: [T('hip-hop', 'Rap/Hip Hop')], styles: [], year: null, artist: 'Nobody', list })).toEqual([{ label: 'desi hip hop', sub: true, guess: true, why: 'Other rap songs in this list' }]);
    expect(mainGenre([T('hip-hop', 'Rap/Hip Hop')])!.label).toBe('Rap');
    expect(mainGenre([T('hip-hop', 'hip hop')])!.key).toBe(mainGenre([T('hip-hop', 'Rap/Hip Hop')])!.key);
  });

  it('gives a song nothing has named the genre of the artist\u2019s other songs, or of most of the list', () => {
    const artistGenres = { nobody: { 'r&b': 2 } };
    expect(fillGenres({ tags: [], styles: [], year: 1994, artist: 'Nobody', artistGenres, list })).toEqual([
      { label: 'R&B', sub: false, guess: true, why: 'The artist\u2019s other songs' },
      { label: '90s R&B', sub: true, guess: false, why: 'Released in 1994' },
    ]);
    expect(fillGenres({ tags: [], styles: [], year: null, artist: 'Unknown', list })).toEqual([
      { label: 'Rap', sub: false, guess: true, why: 'Most songs in this list' },
      { label: 'desi hip hop', sub: true, guess: true, why: 'Other rap songs in this list' },
    ]);
  });

  it('keeps a genre the service named as the main genre even when the picker has no place for it', () => {
    // Deezer files Punjabi music under "Asian Music". That is the service's word, so it is not replaced
    // by a guess of ours; only the subgenre is filled in.
    expect(mainGenre([T('asian', 'Asian Music')])).toEqual({ key: 'off:asian music', label: 'Asian music', family: null, onPicker: false });
    expect(fillGenres({ tags: [T('asian', 'Asian Music')], styles: [], year: 2024, artist: 'Unknown', list })).toEqual([
      { label: '2020s Asian music', sub: true, guess: false, why: 'Released in 2024' },
    ]);
  });

  it('says "other songs", not "most songs", when no one genre holds more than half the list', () => {
    const split = [{ tags: [T('pop', 'Pop')], styles: [] }, { tags: [T('rock', 'Rock')], styles: [] }];
    expect(fillGenres({ tags: [], styles: [], year: null, artist: 'Unknown', list: split })).toEqual([{ label: 'Pop', sub: false, guess: true, why: 'Other songs in this list' }]);
  });

  it('says so when the year is that of a same-named song by the artist, not proved to be this recording', () => {
    expect(fillGenres({ tags: [T('pop', 'Pop')], styles: [], year: null, yearHint: 2019, artist: 'Nobody', list: [] })).toEqual([
      { label: '2010s pop', sub: true, guess: true, why: 'A song of this name by the artist came out in 2019' },
    ]);
  });

  it('last of all, estimates the era from the years of the songs around it', () => {
    const dated = [{ tags: [T('pop', 'Pop')], styles: [], year: 2021 }, { tags: [T('pop', 'Pop')], styles: [], year: 2023 }, { tags: [T('rock', 'Rock')], styles: [], year: 1999 }, { tags: [], styles: [], year: null }];
    expect(fillGenres({ tags: [T('hip-hop', 'Rap/Hip Hop')], styles: [], year: null, artist: 'Nobody', list: dated })).toEqual([
      { label: '2020s rap', sub: true, guess: true, why: 'Most dated songs in this list are from the 2020s' },
    ]);
    // A subgenre the same-genre songs carry is better evidence than the list's era.
    expect(fillGenres({ tags: [T('hip-hop', 'Rap/Hip Hop')], styles: [], year: null, artist: 'Nobody', list: [...dated, ...list] })[0]!.label).toBe('desi hip hop');
  });

  it('invents nothing when nothing at all is known', () => {
    expect(fillGenres({ tags: [], styles: [], year: 2020, artist: 'Unknown', list: [] })).toEqual([]);
  });
});
