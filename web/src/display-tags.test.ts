// TAGS-SAME-001 (owner, 2026-11-20): "Sometimes tags on the song list will be different tags on the player, ensure
// this can't happen on discover, radio, or saved". Measured on the phone: the radio player showed an identified song's
// own genres while the playing station's row showed the station's genres led by the song's — two rules for one thing.
// Now one rule per kind: every song row and the player use songTagBubbles; every station row, Saved programme
// bookmark and the radio player use radioTagBubbles with the same live state. No screen works tags out by itself.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { radioTagBubbles, songTagBubbles } from './engine/display-tags';
import type { Characteristics } from './api';

const station = { id: 's1', name: 'Power 92', tags: ['hip hop', 'rnb'], language: 'english', countryCode: 'US' } as never;
const song = { genres: ['trap', 'southern hip hop'] } as unknown as Characteristics;
const labels = (xs: { label: string }[]) => xs.map((x) => x.label);

describe('radioTagBubbles', () => {
  it('an identified song: its own genres (the same as any song row for it)', () => {
    expect(labels(radioTagBubbles(station, { identified: true, characteristics: song }))).toEqual(labels(songTagBubbles(song)));
  });
  it('nothing identified: what the station plays; the same with no live state at all', () => {
    expect(labels(radioTagBubbles(station, { identified: false, characteristics: null }))).toEqual(labels(radioTagBubbles(station)));
    expect(radioTagBubbles(station).length).toBeGreaterThan(0);
  });
});

describe('songTagBubbles', () => {
  it('genres from the measured characteristics, else from the song\'s stated tags', () => {
    expect(labels(songTagBubbles(song)).length).toBeGreaterThan(0);
    expect(labels(songTagBubbles(null, [{ name: 'trap', label: 'Trap' }] as never))).toEqual(labels(songTagBubbles({ genres: ['Trap'] } as unknown as Characteristics)));
  });
});

describe('no screen works tags out by itself', () => {
  const read = (f: string) => readFileSync(resolve(process.cwd(), 'src', f), 'utf8');
  for (const f of ['Radio.tsx', 'RadioPlayer.tsx', 'SavedView.tsx', 'Results.tsx', 'RowGenres.tsx']) {
    it(f, () => {
      const s = read(f);
      expect(s).not.toMatch(/\bgenreBubbles\(/);
      expect(s).not.toMatch(/\bclassifyStation\(/);
    });
  }
  it('the station row and the player pass the same live state', () => {
    expect(read('Radio.tsx')).toMatch(/radioTagBubbles\(s, active \? live : undefined\)/);
    expect(read('RadioPlayer.tsx')).toMatch(/radioTagBubbles\(s, r\)/);
    expect(read('SavedView.tsx')).toMatch(/radioTagBubbles\(station, liveRadio\.station\?\.id === station\.id \? liveRadio : undefined\)/);
  });
});
