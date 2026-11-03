import { describe, expect, it } from 'vitest';

import {
  MIN_CONTRAST,
  SWATCH_LIGHT,
  contrast,
  genreInk,
  genreSwatch,
  hexToRgb,
  hslToRgb,
  inkContrast,
  luminance,
  normalizeHue,
} from './genre-color';

/**
 * GENRE-COLOUR-001. The taste map's hue identifies a genre; the name beside it must carry the same
 * identity AND be readable. The panel is white, where the map's own fill is far too light for text.
 */
describe('genre colour', () => {
  // Every eighth of the circle, i.e. one per family band, plus the problem hues.
  const HUES = [0, 45, 60, 90, 120, 135, 180, 200, 225, 240, 270, 300, 315, 330, 359];

  it('wraps hue like a circle and refuses nonsense', () => {
    expect(normalizeHue(400)).toBe(40);
    expect(normalizeHue(-30)).toBe(330);
    expect(normalizeHue(360)).toBe(0);
    expect(normalizeHue(Number.NaN)).toBe(0);
    expect(normalizeHue(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('converts HSL to RGB correctly at known points', () => {
    expect(hslToRgb(0, 100, 50)).toEqual([1, 0, 0]);
    const [r, g, b] = hslToRgb(120, 100, 50);
    expect([Math.round(r), Math.round(g), Math.round(b)]).toEqual([0, 1, 0]);
    expect(hslToRgb(0, 0, 100)).toEqual([1, 1, 1]);
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]);
  });

  it('uses the published WCAG luminance coefficients, not an average', () => {
    // inkContrast() is built on luminance(), so every "is it readable" assertion in this file
    // would still pass with a wrong-but-self-consistent formula. These are the spec's own numbers,
    // checked independently: red .2126, green .7152, blue .0722.
    expect(luminance([1, 0, 0])).toBeCloseTo(0.2126, 6);
    expect(luminance([0, 1, 0])).toBeCloseTo(0.7152, 6);
    expect(luminance([0, 0, 1])).toBeCloseTo(0.0722, 6);
    // Green must dominate and blue must barely register; an average would make them equal.
    expect(luminance([0, 1, 0])).toBeGreaterThan(luminance([0, 0, 1]) * 5);
  });

  it('measures luminance and contrast to the WCAG definition', () => {
    const white = luminance([1, 1, 1]);
    const black = luminance([0, 0, 0]);
    expect(white).toBeCloseTo(1, 6);
    expect(black).toBeCloseTo(0, 6);
    // The defining case: black on white is 21:1.
    expect(contrast(white, black)).toBeCloseTo(21, 4);
    expect(contrast(white, white)).toBeCloseTo(1, 6);
  });

  it('parses both hex forms, and treats junk as white', () => {
    expect(hexToRgb('#fff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgb('000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('not a colour')).toEqual([1, 1, 1]);
  });

  it('paints the dot with the map’s own fill, so the colour matches the field', () => {
    // The field gradient is hsl(H 90% 62%); the dot must not be a different colour for the genre.
    expect(genreSwatch(200)).toBe(`hsl(200 90% ${SWATCH_LIGHT}%)`);
    expect(genreSwatch(400)).toBe(`hsl(40 90% ${SWATCH_LIGHT}%)`);
  });

  it('the title colour is READABLE on the white panel, at every hue', () => {
    // This is the whole point of the module: the map's fill would fail this badly.
    for (const h of HUES) {
      expect(inkContrast(h, '#ffffff'), `hue ${h}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });

  it('proves the naive approach would have failed', () => {
    // Using the map's fill directly as text: yellow on white is nowhere near the bar.
    const naive = contrast(luminance(hslToRgb(60, 90, SWATCH_LIGHT)), luminance([1, 1, 1]));
    expect(naive).toBeLessThan(2);
  });

  it('still keeps each genre’s hue — it does not collapse to grey or black', () => {
    for (const h of HUES) {
      const css = genreInk(h, '#ffffff');
      const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(css);
      expect(m, `hue ${h} produced ${css}`).not.toBeNull();
      expect(Number(m![1])).toBe(h % 360);
      expect(Number(m![2]), 'still saturated enough to read as a colour').toBeGreaterThanOrEqual(50);
    }
  });

  it('stays as vivid as the contrast bar allows, rather than going straight to near-black', () => {
    // A blue can be much lighter than a yellow and still pass; the result should reflect that.
    const blue = /(\d+)%\)$/.exec(genreInk(240))![1]!;
    const yellow = /(\d+)%\)$/.exec(genreInk(60))![1]!;
    expect(Number(blue)).toBeGreaterThan(Number(yellow));
  });

  it('different genres get visibly different colours', () => {
    const inks = new Set(HUES.map((h) => genreInk(h)));
    expect(inks.size).toBeGreaterThanOrEqual(HUES.length - 1);
  });

  it('lightens instead of darkening on a dark panel', () => {
    for (const h of HUES) {
      expect(inkContrast(h, '#111111'), `hue ${h} on dark`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
    const onDark = /(\d+)%\)$/.exec(genreInk(240, '#111111'))![1]!;
    const onLight = /(\d+)%\)$/.exec(genreInk(240, '#ffffff'))![1]!;
    expect(Number(onDark)).toBeGreaterThan(Number(onLight));
  });

  it('never returns an unusable colour for a nonsense hue', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -999]) {
      const css = genreInk(bad as number);
      expect(css).toMatch(/^(hsl\(\d+ \d+% \d+%\)|#[0-9a-f]{6})$/);
      expect(inkContrast(bad as number)).toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
});
