// RADIO-ARTIST-001: the artist a radio row opens is the station's primary artist, cleaned of the
// way playout systems write it, or the catalogue's own artist (with its provider id) when a
// confident match for the same song exists. Strings below are shapes real ICY / station feeds send.
import { describe, expect, it } from 'vitest';
import { parseBroadcast } from './radio';
import { normaliseRadioArtist, radioArtistCredits, radioArtistTarget, radioSongFits, titleCaseRadioName } from './radio-artist';

describe('normaliseRadioArtist (RADIO-ARTIST-001)', () => {
  it.each([
    ['JACKSON 5, THE', 'The Jackson 5'],
    ['Jackson 5, The', 'The Jackson 5'],
    ['THE JACKSON 5', 'The Jackson 5'],
    ['The Jackson 5', 'The Jackson 5'],
    ['The Jackson 5 - ABC', 'The Jackson 5'],
    ['"The Jackson 5"', 'The Jackson 5'],
    ['The Jackson 5 | KISS 92.5', 'The Jackson 5'],
    ['The Jackson 5 [Motown Gold]', 'The Jackson 5'],
    ['Now playing: The Jackson 5', 'The Jackson 5'],
    ['Michael Jackson feat. The Jackson 5', 'Michael Jackson'],
    ['DRAKE FT. RIHANNA', 'Drake'],
    ['Calvin Harris (feat. Dua Lipa)', 'Calvin Harris'],
    ['Simon & Garfunkel', 'Simon'],
    ['Beyoncé & Jay-Z', 'Beyoncé'],
    ['Bob Marley & The Wailers', 'Bob Marley & The Wailers'],
    ['Mumford & Sons', 'Mumford & Sons'],
    ['Tyler, The Creator', 'Tyler, The Creator'],
    ['BEATLES, THE', 'The Beatles'],
    ['EARTH, WIND & FIRE', 'Earth'],
    ['ABBA', 'ABBA'],
    ['AC/DC', 'AC/DC'],
    ['DJ SHADOW', 'DJ Shadow'],
    ['THE O\'JAYS', 'The O\'Jays'],
    ['  - Adele -  ', 'Adele'],
  ])('%s → %s', (raw, want) => {
    expect(normaliseRadioArtist(raw)).toBe(want);
  });
  it('names no artist for placeholders', () => {
    for (const raw of ['', 'Unknown', 'UNKNOWN ARTIST', 'Various Artists', '---']) expect(normaliseRadioArtist(raw)).toBeNull();
    expect(normaliseRadioArtist(null)).toBeNull();
  });
  it('keeps every credit, lead first, once each', () => {
    expect(radioArtistCredits('MICHAEL JACKSON FEAT. JACKSON 5, THE')).toEqual(['Michael Jackson', 'The Jackson 5']);
    expect(radioArtistCredits('Drake feat. Rihanna & Future')).toEqual(['Drake', 'Rihanna', 'Future']);
    expect(radioArtistCredits('Adele / adele')).toEqual(['Adele']);
  });
  it('title-cases only names written in capitals', () => {
    expect(titleCaseRadioName('THE JACKSON 5')).toBe('The Jackson 5');
    expect(titleCaseRadioName('deadmau5')).toBe('deadmau5');
    expect(titleCaseRadioName('LCD Soundsystem')).toBe('LCD Soundsystem');
    expect(titleCaseRadioName('EARTH WIND AND FIRE')).toBe('Earth Wind and Fire');
  });
  it('reads the artist out of a raw ICY StreamTitle the same way', () => {
    const b = parseBroadcast('JACKSON 5, THE - ABC', 'Broadcaster ICY');
    expect(b.artist).toBe('JACKSON 5, THE'); // the broadcaster text stays as published on screen
    expect(radioArtistTarget(b.artist)).toEqual({ name: 'The Jackson 5' });
  });
});

describe('radioArtistTarget with a catalogue match (RADIO-ARTIST-001)', () => {
  const abc = { title: 'ABC', artist: 'Jackson 5', artists: ['Jackson 5'], artist_ids: { deezer: '75332' } };
  it('opens the matched catalogue artist with its Deezer id for "JACKSON 5, THE"', () => {
    expect(radioSongFits(abc, { title: 'ABC', artist: 'JACKSON 5, THE' })).toBe(true);
    expect(radioArtistTarget('JACKSON 5, THE', abc, { title: 'ABC' })).toEqual({ id: 'dz:75332', name: 'Jackson 5' });
    expect(radioArtistTarget('The Jackson 5', abc, { title: 'ABC' })).toEqual({ id: 'dz:75332', name: 'Jackson 5' });
  });
  it('uses a YouTube Music channel id when that is the provider id the match carries', () => {
    const yt = { ...abc, artist_ids: { ytmusic: 'UCimf1nPr_Wc0ddnienWKGdg' } };
    expect(radioArtistTarget('The Jackson 5', yt, { title: 'ABC (Remastered 2009)' })).toEqual({ id: 'yt:UCimf1nPr_Wc0ddnienWKGdg', name: 'Jackson 5' });
  });
  it('opens the lead credited on the record; a guest is opened by name only (ids belong to the lead)', () => {
    const duet = { title: 'Rude Boy', artists: ['Rihanna', 'Drake'], artist_ids: { deezer: '564' } };
    expect(radioArtistTarget('DRAKE FT. RIHANNA', duet, { title: 'Rude Boy' })).toEqual({ name: 'Drake' });
    expect(radioArtistTarget('Rihanna feat. Drake', duet, { title: 'Rude Boy' })).toEqual({ id: 'dz:564', name: 'Rihanna' });
  });
  it('ignores a match for another song or another artist and falls back to the cleaned name', () => {
    expect(radioArtistTarget('JACKSON 5, THE', { ...abc, title: 'I Want You Back' }, { title: 'ABC' })).toEqual({ name: 'The Jackson 5' });
    expect(radioArtistTarget('JACKSON 5, THE', { title: 'ABC', artists: ['Karaoke - The Jackson 5'], artist_ids: { deezer: '1546878' } }, { title: 'ABC' })).toEqual({ name: 'The Jackson 5' });
    expect(radioArtistTarget('Unknown', abc, { title: 'ABC' })).toBeNull();
  });
});
