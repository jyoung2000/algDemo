import { describe, expect, it } from 'vitest';
import { verifiedSourceFor } from './verified-sources';

const plantIsland = { title: 'Plant Island', artists: ['My Singing Monsters'], duration: 219, isrc: 'USHM81262832' };

describe('verifiedSourceFor', () => {
  it('returns the owner-confirmed SoundCloud source for Plant Island, by ISRC and by title+artist+duration', () => {
    const byIsrc = verifiedSourceFor(plantIsland);
    expect(byIsrc?.url).toBe('https://soundcloud.com/ghostmeow/my-singing-monsters-plant');
    expect(byIsrc?.source).toBe('soundcloud');
    // Without the ISRC it still matches on folded title + artist + duration.
    expect(verifiedSourceFor({ title: 'Plant Island', artists: ['My Singing Monsters'], duration: 220 })?.url)
      .toBe('https://soundcloud.com/ghostmeow/my-singing-monsters-plant');
  });

  it('never stands in for a different recording, a different length, or a same-title other song', () => {
    // A different-length edit (feat. Werdos & Dipsters is 195s) must not match.
    expect(verifiedSourceFor({ title: 'Plant Island', artists: ['My Singing Monsters'], duration: 195 })).toBeNull();
    // Same title, unrelated artist.
    expect(verifiedSourceFor({ title: 'Plant Island', artists: ['Someone Else'], duration: 219 })).toBeNull();
    // A wrong ISRC with the right title but wrong length still fails.
    expect(verifiedSourceFor({ title: 'Plant Island', artists: ['My Singing Monsters'], duration: 300, isrc: 'XXXX' })).toBeNull();
    // An unrelated song.
    expect(verifiedSourceFor({ title: 'Aria Math', artists: ['Piano Cartel'], duration: 290 })).toBeNull();
  });
});
