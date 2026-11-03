/**
 * The Taste Picker's model, for the Profile: where a point on the field sits (family band,
 * tempo), which subgenre it names, and where the user's own taste genres fall on the field.
 *
 * Pure. The field is the picker's: left to right is the eight family bands (45 degrees each),
 * bottom to top is 40 to 220 BPM. The catalog is the generated taste-catalog.ts, the same data
 * the classifier uses, so the map and the song labels cannot disagree.
 */
import { CATALOG, type CatalogSub } from './engine/taste-catalog';
import { FAMILIES, SUBS } from './engine/genre-table';
import { classify, familyHue } from './engine/classify';

export const BPM_MIN = 40;
export const BPM_MAX = 220;
export const BAND = 45;

export interface MapSub extends CatalogSub {
  /** Family index 0..7 (the band the subgenre lives in). */
  family: number;
  /** Canonical key the classifier stores on tags, e.g. 'tech-house'. */
  key: string;
}

/**
 * Subgenres the classifier names that the generated picker catalog has no cell for.
 *
 * TASTE-ACCURACY-001: `genre-table.ts` carries six hip-hop subgenres added beyond the picker's 83,
 * deliberately without a tempo range so tempo can never invent them. The map was built from the
 * catalog alone, so those six could be classified but never placed — and all six are hip-hop. A
 * listener whose history was 66 plays of 'hip-hop', 16 of 'alt-hip-hop', 14 of 'rage' and 6 of
 * 'southern' had 2 of their 3 named subgenres silently dropped, leaving the map describing their
 * taste from 14 of 102 plays.
 *
 * These ranges are for PLACEMENT ONLY. They are not in CATALOG, so `classify`'s tempo matching
 * still cannot reach them, which keeps the "only a tag can name these" guarantee intact.
 */
const EXTRA_SUBS: Record<string, { lo: number; hi: number; halftime: boolean; years: string; sound: string; energy: number; brightness: number; artists: string[] }> = {
  'cloud-rap': { lo: 60, hi: 90, halftime: true, years: '2012–2025', energy: 0.4, brightness: 0.6, sound: 'Washed, reverb-heavy synths and sung-rapped melodies over slow, spacious drums.', artists: ['Yeat', 'Playboi Carti', 'Lil Uzi Vert'] },
  conscious: { lo: 80, hi: 100, halftime: false, years: '1990–2025', energy: 0.5, brightness: 0.5, sound: 'Sample-led, often jazz-rooted production under dense, narrative verses.', artists: ['Kendrick Lamar', 'MF DOOM', 'Mos Def'] },
  'west-coast': { lo: 90, hi: 105, halftime: false, years: '1992–2025', energy: 0.6, brightness: 0.55, sound: 'Funk basslines, portamento synth leads and laid-back swung drums.', artists: ['Dr. Dre', 'DJ Quik', 'Vince Staples'] },
  southern: { lo: 70, hi: 100, halftime: true, years: '1995–2025', energy: 0.7, brightness: 0.45, sound: 'Heavy sub-bass and 808s, chant hooks, chopped-and-screwed and crunk roots.', artists: ['Three 6 Mafia', 'UGK', 'Lil Jon'] },
  'alt-hip-hop': { lo: 80, hi: 100, halftime: false, years: '2000–2025', energy: 0.5, brightness: 0.5, sound: 'Left-field, often lo-fi or abstract production outside the chart-rap template.', artists: ['Tyler, The Creator', 'Earl Sweatshirt', 'JPEGMAFIA'] },
  grime: { lo: 135, hi: 145, halftime: false, years: '2002–2025', energy: 0.85, brightness: 0.6, sound: 'Fast, sparse square-wave riddims at 140 with clipped, rapid-fire UK delivery.', artists: ['Skepta', 'Stormzy', 'Dave'] },
};

const FAMILY_INDEX_BY_SLUG = new Map(FAMILIES.map((f, i) => [f.slug, i] as const));
const CATALOG_SUB_NAMES = new Set(CATALOG.flatMap((f) => f.subs.map((s) => s.name)));

/** Every subgenre the classifier can name, in picker order, with its family index. */
export const MAP_SUBS: MapSub[] = [
  ...CATALOG.flatMap((f, fi) =>
    f.subs.map((s) => {
      const key = SUBS.find((d) => d.name === s.name)?.key ?? s.name.toLowerCase();
      return { ...s, family: fi, key };
    }),
  ),
  // The classifier's extras, placed in their own family band.
  ...SUBS.filter((s) => !CATALOG_SUB_NAMES.has(s.name) && EXTRA_SUBS[s.key]).map((s) => {
    const extra = EXTRA_SUBS[s.key]!;
    return { name: s.name, ...extra, family: FAMILY_INDEX_BY_SLUG.get(s.family) ?? 0, key: s.key };
  }),
];

export const MAP_FAMILIES = CATALOG.map((f, i) => ({ name: f.name, sound: f.sound, index: i, hue: i * BAND + BAND / 2 }));
/** The family at a band index; the index is always 0..7 (see familyAt). */
export const familyName = (i: number) => MAP_FAMILIES[i]?.name ?? '';

/** Family band index for a hue 0..360. */
export function familyAt(hue: number): number {
  return Math.min(FAMILIES.length - 1, Math.max(0, Math.floor(hue / BAND)));
}

/** Subgenres of one family whose tempo range covers `bpm`. */
export function fitsAt(family: number, bpm: number): number[] {
  const subs = MAP_SUBS.filter((s) => s.family === family);
  return subs.map((s, i) => (bpm >= s.lo && bpm <= s.hi ? i : -1)).filter((i) => i >= 0);
}

/**
 * The subgenre under a point. Inside a band, the position across the band picks between the
 * subgenres whose range covers the tempo; with none covering it, the nearest by tempo wins.
 */
export function subAt(hue: number, bpm: number): MapSub {
  const fam = familyAt(hue);
  const subs = MAP_SUBS.filter((s) => s.family === fam);
  const frac = (hue - fam * BAND) / BAND;
  let candidates = fitsAt(fam, bpm);
  if (!candidates.length) {
    let best = 0;
    let bd = Infinity;
    subs.forEach((s, i) => {
      const d = bpm < s.lo ? s.lo - bpm : bpm - s.hi;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    candidates = [best];
  }
  const pick = candidates[Math.min(candidates.length - 1, Math.floor(frac * candidates.length))] ?? 0;
  return subs[pick] ?? subs[0]!;
}

/** Point on the field (hue, bpm) that selects a subgenre, the same rule the picker's jump uses. */
export function pointFor(sub: MapSub): { hue: number; bpm: number } {
  const mid = (sub.lo + sub.hi) / 2;
  const subs = MAP_SUBS.filter((s) => s.family === sub.family);
  const cands = fitsAt(sub.family, mid);
  const local = subs.indexOf(sub);
  const k = Math.max(0, cands.indexOf(local));
  const n = Math.max(1, cands.length);
  return { hue: sub.family * BAND + ((k + 0.5) / n) * BAND, bpm: mid };
}

/** Left-to-right position of a hue on the field, 0..100%. */
export const leftPct = (hue: number) => (hue / 360) * 100;
/** Bottom-to-top position of a bpm on the field, 0..100%. */
export const bottomPct = (bpm: number) => ((bpm - BPM_MIN) / (BPM_MAX - BPM_MIN)) * 100;

export interface GenrePlacement {
  hue: number;
  bpm: number;
  sub: MapSub;
  family: number;
  /**
   * True when the genre named only a family ('hip-hop', 'rock'). The point is the family band's
   * own centre; `sub` is the band's middle subgenre purely so the marker has somewhere to sit, and
   * the UI must NOT present its name as something the listener plays.
   */
  broad: boolean;
}

/**
 * Where a taste genre name sits on the field.
 *
 * TASTE-ACCURACY-001: this used to return null for anything that did not name a catalog subgenre,
 * which threw away the most common case by far — the bare family word. In the owner's real history
 * 'hip-hop' alone accounted for 66 of 102 kept plays and was dropped, so the map had nothing of
 * their actual taste to draw and whatever else sat nearby spoke for them. A family word now places
 * at its band's centre, flagged `broad` so it is labelled as the family and not as a subgenre.
 */
export function placeGenre(name: string): GenrePlacement | null {
  const c = classify([{ name, label: name, confidence: 1 } as never], null);
  if (!c) return null;
  if (c.key) {
    const sub = MAP_SUBS.find((s) => s.key === c.key);
    if (sub) return { ...pointFor(sub), sub, family: sub.family, broad: false };
  }
  // Family only: sit at the middle of the band, at the median tempo of what lives there.
  const fi = familyAt(c.hue);
  const subs = MAP_SUBS.filter((s) => s.family === fi);
  if (!subs.length) return null;
  const mids = subs.map((s) => (s.lo + s.hi) / 2).sort((a, b) => a - b);
  const bpm = mids[Math.floor(mids.length / 2)]!;
  const middle = subs[Math.floor(subs.length / 2)]!;
  return { hue: fi * BAND + BAND / 2, bpm, sub: middle, family: fi, broad: true };
}

/**
 * Where one played song sits on the field. Its tags give the band (a named subgenre also gives the
 * place inside the band), its own tempo gives the height; with no tempo, a named subgenre's middle
 * tempo stands in. A song whose tags name no family, or with neither a tempo nor a subgenre, is null.
 */
export function placeSong(genreNames: string[], bpm: number | null): { hue: number; bpm: number } | null {
  const tags = genreNames.map((name) => ({ name, label: name, confidence: 1 }) as never);
  const c = classify(tags, null);
  if (!c) return null;
  const sub = c.key ? MAP_SUBS.find((x) => x.key === c.key) : undefined;
  const height = bpm !== null && bpm >= BPM_MIN && bpm <= BPM_MAX ? bpm : sub ? pointFor(sub).bpm : null;
  if (height === null) return null;
  return { hue: sub ? pointFor(sub).hue : c.hue, bpm: height };
}

export { familyHue };
