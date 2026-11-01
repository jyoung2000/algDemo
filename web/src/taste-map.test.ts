import { describe, expect, it } from 'vitest';
import { MAP_SUBS, fitsAt, placeGenre, placeSong, pointFor, subAt, familyAt, BAND } from './taste-map';

describe('taste map', () => {
  it('has the 83 picker subgenres in 8 families', () => {
    expect(MAP_SUBS).toHaveLength(83);
    expect(new Set(MAP_SUBS.map((s) => s.family)).size).toBe(8);
  });

  it('a point selects the subgenre it was jumped to', () => {
    for (const s of MAP_SUBS) {
      const p = pointFor(s);
      expect(subAt(p.hue, p.bpm).key).toBe(s.key);
    }
  });

  it('picks by tempo inside a band', () => {
    const rock = MAP_SUBS.filter((s) => s.family === 0);
    const slow = rock.find((s) => s.name === 'Slowcore revival')!;
    expect(subAt(BAND / 2, slow.lo + 5).name).toBe('Slowcore revival');
  });

  it('falls back to the nearest subgenre when no range covers the tempo', () => {
    const s = subAt(BAND / 2 + 1, 215);
    expect(s.family).toBe(0);
  });

  it('lights only the subgenres whose range covers the tempo', () => {
    const fits = fitsAt(0, 80);
    expect(fits.every((i) => i >= 0)).toBe(true);
    expect(fits.length).toBeLessThan(MAP_SUBS.filter((s) => s.family === 0).length);
  });

  it('places a picker subgenre key on its own point and leaves an unknown genre off the map', () => {
    const placed = placeGenre('tech-house');
    expect(placed?.sub.key).toBe('tech-house');
    expect(familyAt(placed!.hue)).toBe(placed!.family);
    expect(placeGenre('not-a-real-genre-xyz')).toBeNull();
  });

  it('places a played song by its family and its own tempo, and leaves one with no genre off the map', () => {
    const fam = placeSong(['alternative'], 90);
    expect(fam).not.toBeNull();
    expect(fam!.bpm).toBe(90);
    const sub = placeSong(['tech-house'], 124);
    expect(sub?.bpm).toBe(124);
    expect(familyAt(sub!.hue)).toBe(placeGenre('tech-house')!.family);
    expect(placeSong(['tech-house'], null)?.bpm).toBe(placeGenre('tech-house')!.bpm);
    expect(placeSong(['alternative'], null)).toBeNull();
    expect(placeSong([], 120)).toBeNull();
    expect(placeSong(['not-a-real-genre-xyz'], 120)).toBeNull();
  });
});
