import { describe, expect, it } from 'vitest';
import { listMixNote } from './list-mix-note';

const mix = (songs: number, placed: number) => ({ id: 'l', name: 'L', taste: null, songs, placed });

describe('listMixNote (PLAYLIST-MIX-001)', () => {
  it('says the mix covers the whole list', () => {
    expect(listMixNote(mix(12, 12))).toBe('From the genres of the 12 songs in this list. It redraws as you add or remove songs.');
  });
  it('says how many songs have no genre yet, never hiding them', () => {
    expect(listMixNote(mix(12, 9))).toMatch(/12 songs in this list\. 3 have no genre yet; they fill in as discovery looks them up\./);
    expect(listMixNote(mix(2, 1))).toMatch(/1 has no genre yet; it fills in as discovery looks it up\./);
  });
});
