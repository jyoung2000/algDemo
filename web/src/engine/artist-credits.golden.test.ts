import { describe, expect, it } from 'vitest';
import golden from './golden/artist-credits.json';
import { splitArtists } from './identity';

/**
 * WP7-ARTIST-KEY-001: the shared golden file for the primary artist of a credit. The Android
 * PlayQueue.artistKey (its four-in-a-row shuffle rule) must split credits the same way identity.ts
 * does, so both sides read this one file. ArtistCreditsGoldenTest (JVM) is the other half.
 */
const primaryArtist = (credit: string): string => splitArtists(credit)[0] ?? '';

describe('primary artist credits (golden)', () => {
  it('covers the collaboration spellings the Android queue has to match', () => {
    expect(golden.credits.length).toBeGreaterThanOrEqual(30);
  });

  for (const { credit, first } of golden.credits) {
    it(`${JSON.stringify(credit)} -> ${JSON.stringify(first)}`, () => {
      expect(primaryArtist(credit)).toBe(first);
    });
  }
});
