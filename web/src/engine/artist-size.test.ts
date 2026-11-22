// ARTIST-SIZE-001 (owner, 2026-11-21): "if I'm playing underground hip hop or underground rage, dont recommend me a ken
// carson or other main stream acts, try to have artist of similar sizes when recommending music".
// Sizes measured on Deezer the same day (nb_fan): Ken Carson 113,248; Destroy Lonely 68,587; Bladee 23,598;
// OsamaSon 21,296; Nettspend 13,505; Summrs 10,708; Autumn! 10,194; LAZER DIM 700 6,950; Kankan 5,386; SLAYR 4,176;
// 1oneam 3,746; Yhapojj 1,466.
import { describe, expect, it } from 'vitest';
import { BIGGER_OK, referenceSize, sizeFit, smallScene } from './artist-size';

describe('artists of a similar size (ARTIST-SIZE-001)', () => {
  it('the reference is the typical size of the artists the listener started from, ignoring unknowns', () => {
    expect(referenceSize([21296, 10708, null, 5386])).toBe(10_709);
    expect(referenceSize([null, undefined])).toBeNull();
    expect(referenceSize([])).toBeNull();
  });
  it('keeps artists up to a few times bigger, and the same scene’s smaller acts, at full weight', () => {
    expect(sizeFit(21296 * BIGGER_OK, 21296)).toBe(1);
    expect(sizeFit(13505, 21296)).toBe(1);
    expect(sizeFit(1466, 21296)).toBe(1);
  });
  it('pushes a mainstream act well down for an underground listener (Ken Carson against OsamaSon and Summrs)', () => {
    expect(sizeFit(113248, 21296)).toBeLessThan(0.45);
    expect(sizeFit(113248, 10708)).toBeLessThan(0.2);
    expect(sizeFit(1_500_000, 10708)).toBe(0.05);
  });
  it('gently lowers very small acts for a listener of big artists, never as hard', () => {
    const tiny = sizeFit(500, 2_000_000);
    expect(tiny).toBeLessThan(1); expect(tiny).toBeGreaterThan(sizeFit(2_000_000 * 25, 2_000_000));
  });
  it('changes nothing when either size is unknown', () => {
    expect(sizeFit(null, 21296)).toBe(1);
    expect(sizeFit(113248, null)).toBe(1);
    expect(sizeFit(0, 21296)).toBe(1);
  });
  it('an underground reference skips the genre charts, which list the biggest acts', () => {
    expect(smallScene(21296)).toBe(true);
    expect(smallScene(400_000)).toBe(false);
    expect(smallScene(null)).toBe(false);
  });
});
