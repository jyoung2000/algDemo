/**
 * One place that decides what colour a genre is.
 *
 * The taste map paints genre as hue around a circle, and the owner wants that same identity next to
 * the genre's name: a colour dot, and the name itself in the genre's colour.
 *
 * The catch is contrast. The map's fill is `hsl(h 90% 62%)`, which is correct on the field but
 * illegible as text on the white panel — a yellow at that lightness lands near 1.4:1, where the
 * bar for body text is 4.5:1. Dropping every hue to one fixed dark lightness does not work either,
 * because the same lightness reads very differently per hue (yellow is far lighter than blue at
 * equal L). So the ink colour keeps the hue and lowers only its lightness, by measurement, until it
 * actually meets the ratio.
 */

/** The map's own fill: what the field and the dots are painted with. */
export const SWATCH_SAT = 90;
export const SWATCH_LIGHT = 62;
/** Contrast the genre name must reach against the panel it sits on (WCAG AA for body text). */
export const MIN_CONTRAST = 4.5;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Hue is a circle: 400 is 40, -30 is 330. NaN is not a colour, so it falls back to 0. */
export function normalizeHue(hue: number): number {
  if (!Number.isFinite(hue)) return 0;
  return ((hue % 360) + 360) % 360;
}

/** HSL (percent s/l) to sRGB 0..1. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = normalizeHue(h) / 360;
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;
  if (ss === 0) return [ll, ll, ll];
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(hh + 1 / 3), channel(hh), channel(hh - 1 / 3)];
}

/** WCAG relative luminance of an sRGB colour. */
export function luminance(rgb: readonly [number, number, number]): number {
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** WCAG contrast ratio between two luminances, lighter over darker. */
export function contrast(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** The vivid fill for a genre's dot — the same colour the map paints that genre. */
export function genreSwatch(hue: number): string {
  return `hsl(${Math.round(normalizeHue(hue))} ${SWATCH_SAT}% ${SWATCH_LIGHT}%)`;
}

/**
 * The genre's colour as readable text on `background`.
 *
 * Keeps the hue, keeps it saturated enough to still read as that colour, and walks the lightness
 * down (or up, on a dark panel) until the contrast ratio is met. Returns the first lightness that
 * passes, so the colour stays as vivid as the requirement allows rather than defaulting to near-black.
 */
export function genreInk(hue: number, background: string | readonly [number, number, number] = '#ffffff'): string {
  const bg = typeof background === 'string' ? hexToRgb(background) : background;
  const bgL = luminance(bg);
  const h = Math.round(normalizeHue(hue));
  const sat = 72;
  // On a light panel darken; on a dark one lighten.
  const darken = bgL > 0.18;
  const steps = darken ? [58, 54, 50, 46, 42, 38, 34, 30, 26, 22, 18, 14, 10] : [52, 58, 64, 70, 76, 82, 88, 94];
  for (const l of steps) {
    if (contrast(luminance(hslToRgb(h, sat, l)), bgL) >= MIN_CONTRAST) return `hsl(${h} ${sat}% ${l}%)`;
  }
  // Nothing in the hue met the bar: fall back to plain ink rather than pretending.
  return darken ? '#101010' : '#f5f5f5';
}

/** #rgb or #rrggbb to sRGB 0..1. Anything unparseable is treated as white. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  let s = m[1]!;
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
}

/** Contrast of a genre's ink against a background, for tests and for checking a new panel colour. */
export function inkContrast(hue: number, background = '#ffffff'): number {
  const css = genreInk(hue, background);
  const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(css);
  const rgb = m ? hslToRgb(Number(m[1]), Number(m[2]), Number(m[3])) : hexToRgb(css);
  return contrast(luminance(rgb), luminance(hexToRgb(background)));
}
