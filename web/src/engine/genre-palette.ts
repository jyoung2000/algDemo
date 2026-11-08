/**
 * One palette for every genre and subgenre colour in the app (TAGS-COLOR-001).
 *
 * The Taste Picker paints the field by hue: eight family bands, 45 degrees each. Before this, a
 * subgenre was its family's hue with a slightly different saturation, so Rage sat a few percent away
 * from Hip-hop and twenty hip-hop subgenres looked like one colour. Here every colour is still read
 * off the picker's band, and is made measurably distinct:
 *
 *  - a family takes the picker's own band colour (its hue, converted to the perceptual OKLCH space),
 *    with lightness alternating around the wheel, so neighbouring families (Pop and Indie, Soul and
 *    Electronic) differ in lightness as well as hue;
 *  - each subgenre gets its own cell on a grid around its family's colour, lightness steps by hue
 *    steps within the band, in picker order, never the family's own cell.
 *
 * Distinctness is measured as OKLab delta E (Euclidean distance in OKLab; 0.02 is about one just
 * noticeable difference) and held to PALETTE_FLOORS by genre-palette.test.ts. Colours are sRGB hex,
 * gamut-mapped by lowering chroma, so every surface (CSS, SVG stops, canvas) draws them the same.
 */
import { FAMILIES, SUBS } from './genre-table';

type Lab = [number, number, number];

const BAND = 45;
/**
 * A family's colour is the one its tags have always had (0.12.3, which the owner checked: R&B red,
 * Rap yellow-green, Pop green): the centre of its Taste Picker band at 75% saturation, 53% lightness.
 */
const FAMILY_S = 0.75;
const FAMILY_HSL_L = 0.53;
/**
 * Where a family's subgenre colours may come from: lightness 0.32 to 0.86 (bubbles draw the colour as a
 * dot and a 20% tint under dark ink, so text contrast holds at either end), chroma 0.05 to 0.29
 * (gamut-mapped), hue within 95% of the family's half-band.
 */
const SUB_L = { lo: 0.32, hi: 0.86, steps: 25 } as const;
const SUB_CHROMA = [0.05, 0.09, 0.13, 0.17, 0.21, 0.25, 0.29] as const;
const SUB_HUE_STEPS = 15;
const SUB_HUE_REACH = 0.95;
/**
 * The family's own colour counts this many times nearer than it is when subgenres are picked: a card
 * always shows the family's general share beside its subgenres, so each subgenre keeps well clear of it.
 */
const FAMILY_KEEP_OUT = 1.7;

/**
 * The floors genre-palette.test.ts holds every pair to (OKLab delta E; about 0.02 is just noticeable),
 * and the least chroma a genre colour may have (below about 0.1 a 20% bubble tint reads as grey). The
 * sibling floor is set by hip-hop: 17 subgenres in a band only about 25 degrees of hue wide, all
 * colourful; every other family's siblings are further apart.
 */
export const PALETTE_FLOORS = { family: 0.1, subVsFamily: 0.08, sibling: 0.045, chroma: 0.1 } as const;

// ---------------------------------------------------------------- colour maths (OKLab, sRGB)
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function linearToOklab([r, g, b]: [number, number, number]): Lab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinear([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** OKLCH to hex, lowering chroma until the colour is inside sRGB (hue and lightness kept). */
function oklchHex(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const at = (c: number) => oklabToLinear([L, c * Math.cos(h), c * Math.sin(h)]);
  let lo = 0, hi = C;
  if (!inGamut(at(C))) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
  } else lo = C;
  const hex = at(lo).map((c) => Math.round(Math.min(1, Math.max(0, toGamma(Math.min(1, Math.max(0, c))))) * 255));
  return `#${hex.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  return linearToOklab([toLinear(((n >> 16) & 255) / 255), toLinear(((n >> 8) & 255) / 255), toLinear((n & 255) / 255)]);
}

const dist = (x: Lab, y: Lab) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);

/** How colourful a palette colour is (OKLCH chroma): 0 is grey. */
export function chromaOf(hex: string): number {
  const [, a, b] = hexToLab(hex);
  return Math.hypot(a, b);
}

/** Perceptual colour difference: Euclidean distance in OKLab (0 the same, about 1 black to white). */
export function deltaE(a: string, b: string): number {
  return dist(hexToLab(a), hexToLab(b));
}

/** The OKLCH hue of the picker's own band colour, hsl(h 90% 62%). */
function hslHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- the palette
const FAMILY_HEX = new Map(FAMILIES.map((f, i) => [f.slug, hslHex(i * BAND + BAND / 2, FAMILY_S, FAMILY_HSL_L)] as const));
const FAMILY_HUE = new Map(FAMILIES.map((f) => [f.slug, hueOf(FAMILY_HEX.get(f.slug)!)] as const));

const hueGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
/** Half the hue distance from a family to its nearer neighbour: the family's own part of the wheel. */
export function familyHalfBand(slug: string): number {
  const h = FAMILY_HUE.get(slug)!;
  return Math.min(...FAMILIES.filter((f) => f.slug !== slug).map((f) => hueGap(h, FAMILY_HUE.get(f.slug)!))) / 2;
}
/** The OKLCH hue of a palette colour, and of a family. */
export function hueOf(hex: string): number {
  const [, a, b] = hexToLab(hex);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}
export const familyHue = (slug: string) => FAMILY_HUE.get(slug)!;
export { hueGap };

const SUB_HEX = new Map<string, string>();
for (const f of FAMILIES) {
  const hue = FAMILY_HUE.get(f.slug)!;
  const reach = familyHalfBand(f.slug) * SUB_HUE_REACH;
  // Every colour the family's subgenres may take (gamut-mapped, deduplicated).
  const pool = new Map<string, Lab>();
  for (let i = 0; i < SUB_L.steps; i++) {
    const L = SUB_L.lo + ((SUB_L.hi - SUB_L.lo) * i) / (SUB_L.steps - 1);
    for (const C of SUB_CHROMA) {
      for (let j = 0; j < SUB_HUE_STEPS; j++) {
        const hex = oklchHex(L, C, hue - reach + (2 * reach * j) / (SUB_HUE_STEPS - 1));
        // Rounding to sRGB moves the hue of a pale or dull colour; one that leaves the band is not used.
        // Nor is one gamut mapping has left near grey: the owner's rule is no grey tags.
        if (!pool.has(hex) && chromaOf(hex) >= PALETTE_FLOORS.chroma && hueGap(hueOf(hex), hue) < familyHalfBand(f.slug)) pool.set(hex, hexToLab(hex));
      }
    }
  }
  // Farthest-point sampling: start from the family's own colour, then take, one at a time, the colour
  // farthest from everything already taken. Every subgenre ends as far from its family and its siblings
  // as the band allows. Deterministic: the pool's order is fixed and ties keep the first.
  const taken: Lab[] = [hexToLab(FAMILY_HEX.get(f.slug)!)];
  const nearest = new Map([...pool].map(([hex, lab]) => [hex, dist(lab, taken[0]!) / FAMILY_KEEP_OUT] as const));
  const picks: string[] = [];
  const subs = SUBS.filter((x) => x.family === f.slug);
  for (let n = 0; n < subs.length; n++) {
    let best = '', bestD = -1;
    for (const [hex, d] of nearest) if (d > bestD) { best = hex; bestD = d; }
    picks.push(best);
    const lab = pool.get(best)!;
    nearest.delete(best);
    for (const [hex, d] of nearest) nearest.set(hex, Math.min(d, dist(pool.get(hex)!, lab)));
  }
  // Picks come out roughly from far to near; give them out in picker order, alternating ends, so two
  // subgenres next to each other in the picker are not also next to each other in colour.
  const order = picks.map((_, i) => (i % 2 ? picks.length - 1 - (i >> 1) : i >> 1));
  subs.forEach((x, i) => SUB_HEX.set(x.key, picks[order[i]!]!));
}

/** A family's colour, by slug ('hip-hop'). */
export function familyColor(slug: string): string {
  return FAMILY_HEX.get(slug) ?? '#8a8a8a';
}

/** A picker subgenre's colour, by key ('rage'), or null for a key the picker does not have. */
export function subColorOf(key: string): string | null {
  return SUB_HEX.get(key) ?? null;
}
