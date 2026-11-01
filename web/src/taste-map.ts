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

/** Every subgenre, in picker order, with its family index. */
export const MAP_SUBS: MapSub[] = CATALOG.flatMap((f, fi) =>
  f.subs.map((s) => {
    const key = SUBS.find((d) => d.name === s.name)?.key ?? s.name.toLowerCase();
    return { ...s, family: fi, key };
  }),
);

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

/** Where a taste genre name sits on the field, or null when it names no picker subgenre. */
export function placeGenre(name: string): { hue: number; bpm: number; sub: MapSub; family: number } | null {
  const c = classify([{ name, label: name, confidence: 1 } as never], null);
  if (!c?.key) return null;
  const sub = MAP_SUBS.find((s) => s.key === c.key);
  if (!sub) return null;
  return { ...pointFor(sub), sub, family: sub.family };
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
