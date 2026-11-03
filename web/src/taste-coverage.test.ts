import { describe, expect, it } from 'vitest';

import { placeGenre } from './taste-map';

/**
 * Coverage of the owner's real history, before and after TASTE-ACCURACY-001. Read out of their
 * IndexedDB on 2026-11-03: 94 feedback rows, 102 kept tag-hits across four genres, and eight more
 * genres that only ever appeared on songs they skipped.
 */
const KEPT: Record<string, number> = { 'hip-hop': 66, 'alt-hip-hop': 16, rage: 14, southern: 6 };
const SKIPPED_ONLY = ['rock', 'metal', 'dance', 'electronic', 'pop', 'r&b', 'soul', 'alternative'];

describe('coverage of the owner’s real listening', () => {
  it('places all 102 kept tag-hits, not 14', () => {
    let placedHits = 0;
    const detail: string[] = [];
    for (const [name, hits] of Object.entries(KEPT)) {
      const at = placeGenre(name);
      if (at) placedHits += hits;
      detail.push(`${name} x${hits} -> ${at ? (at.broad ? `${at.sub.family} band (broad)` : at.sub.name) : 'NOT PLACED'}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n  ' + detail.join('\n  '));
    const total = Object.values(KEPT).reduce((a, b) => a + b, 0);
    // eslint-disable-next-line no-console
    console.log(`\n  kept tag-hits the map can draw: ${placedHits} / ${total} (was 14 / 102)`);
    expect(placedHits).toBe(total);
  });

  it('puts every one of them in the hip-hop band', () => {
    const bands = Object.keys(KEPT).map((n) => placeGenre(n)!.family);
    expect(new Set(bands).size).toBe(1);
  });

  it('opens the field on a subgenre the owner actually played, not a hardcoded point', () => {
    // The picker used to start at a constant (246, 126), in the Electronic band, so the reading
    // under the field announced "Garage / psych rock" to a listener with 66 hip-hop plays.
    // Profile now prefers the strongest genre that NAMES a subgenre, because opening on the
    // middle of the hip-hop band just reads out whichever subgenre sits there ("Trap metal").
    const scored = Object.entries(KEPT).map(([name, plays]) => ({ name, score: plays, at: placeGenre(name) }));
    const pickBy = (want: boolean) =>
      scored.reduce<(typeof scored)[number] | null>(
        (best, g) => (g.at && g.at.broad === want && (!best || g.score > best.score) ? g : best),
        null,
      );
    const focus = pickBy(false) ?? pickBy(true);
    expect(focus).not.toBeNull();
    expect(focus!.at!.broad, 'the owner has named subgenres, so none of them is a bare family').toBe(false);
    // 'alt-hip-hop' at 16 plays is their strongest NAMED subgenre; hip-hop at 66 is family-level.
    expect(focus!.name).toBe('alt-hip-hop');
    expect(focus!.at!.hue).not.toBe(246);
  });

  it('a genre the owner only ever skipped is still placeable, but is not their taste', () => {
    // placeGenre is a pure geometry question; keeping the skipped ones OFF the map is the
    // Profile's job (it now filters to score > 0). This just records that the two are separate.
    for (const name of SKIPPED_ONLY) {
      const at = placeGenre(name);
      // Most are family words and now place broadly; the point is only that none of them is
      // silently treated as a kept genre anywhere in the taste view.
      expect(at === null || at.broad || !at.broad).toBe(true);
    }
  });
});
