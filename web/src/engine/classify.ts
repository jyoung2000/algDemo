/**
 * Classifies a song into the Taste Picker's families and subgenres, and gives it the picker's colour.
 *
 * The picker places a song in a family by its hue (the spectrum band) and in a subgenre by its tempo
 * within that family. Here a song's tags pick the family and subgenre; when there is no tag, the
 * tempo alone picks the subgenre inside a family that the tags name. Colour follows the picker:
 * family -> hue band, and the subgenre's energy and brightness shade it.
 */
import { CATALOG } from './taste-catalog';
import { FAMILIES, FAMILY_TAGS, SUBS, type SubDef } from './genre-table';
import { fold } from './identity';
import type { Tag } from './genres';

export interface Classification {
  family: string; // family name, e.g. 'Electronic'
  familySlug: string;
  subgenre: string | null; // picker subgenre name, e.g. 'Tech house'
  key: string | null; // canonical subgenre key, e.g. 'tech-house'
  tempoFit: number | null; // 0..1: how well the song's tempo sits in the subgenre's range
  hue: number; // 0..360, the picker's band colour
  energy: number | null;
  brightness: number | null;
  color: string; // css colour
}

const BAND = 45;
const CATALOG_BY_NAME = new Map(CATALOG.flatMap((f) => f.subs.map((s) => [s.name, s] as const)));
const SUB_BY_KEY = new Map(SUBS.map((s) => [s.key, s] as const));
const SUBS_BY_FAMILY = new Map<string, SubDef[]>();
for (const s of SUBS) {
  const list = SUBS_BY_FAMILY.get(s.family) ?? [];
  list.push(s);
  SUBS_BY_FAMILY.set(s.family, list);
}
const FAMILY_INDEX = new Map(FAMILIES.map((f, i) => [f.slug, i] as const));
const ALIAS = new Map<string, SubDef>();
for (const s of SUBS) {
  for (const a of [s.key, s.name, ...s.aliases]) {
    const k = fold(a);
    if (k && !ALIAS.has(k)) ALIAS.set(k, s);
  }
}

/** Hue of a family's band, the picker's `i*45 + 22.5`. */
export function familyHue(slug: string): number {
  const i = FAMILY_INDEX.get(slug) ?? 0;
  return i * BAND + BAND / 2;
}

/** Tempo fit inside a subgenre: 1 inside its range (half and double time count), falling to 0 at 25% off. */
export function tempoFitIn(bpm: number, lo: number, hi: number, halftime: boolean): number {
  const near = (x: number) => (x >= lo && x <= hi ? 1 : Math.max(0, 1 - Math.min(Math.abs(x - lo), Math.abs(x - hi)) / (0.25 * ((lo + hi) / 2))));
  const direct = near(bpm);
  // Half and double time are the same groove counted two ways: a 130 BPM track is felt as 65.
  // Counted at the other rate it can still belong to the range, a little less certainly.
  const other = near(bpm * 2) * 0.9;
  const half = near(bpm / 2) * 0.9;
  return Math.max(direct, other, half);
}

function shade(hue: number, energy: number | null, brightness: number | null): string {
  const sat = 60 + 30 * (energy ?? 0.5);
  const light = 40 + 25 * (brightness ?? 0.5);
  return `hsl(${Math.round(hue)} ${Math.round(sat)}% ${Math.round(light)}%)`;
}

/** Subgenre whose name or alias appears in a tag or genre label. */
function subFromTags(tags: Tag[]): SubDef | null {
  // Strongest tags first; a subgenre match beats a family match.
  const ordered = [...tags].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  for (const t of ordered) {
    const hit = ALIAS.get(fold(t.name)) ?? ALIAS.get(fold(t.label ?? ''));
    if (hit) return hit;
  }
  return null;
}

function familyFromTags(tags: Tag[]): string | null {
  const ordered = [...tags].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  for (const t of ordered) {
    const f = FAMILY_TAGS[t.name];
    if (f) return f;
  }
  return null;
}

/**
 * Classify a song. Subgenre from its tags first; if the tags only name a family, the tempo picks the
 * subgenre inside that family (best fit). With no genre tag, the tempo alone places it.
 */
export function classify(tags: Tag[] | null | undefined, bpm: number | null | undefined): Classification | null {
  const tg = (tags ?? []).filter((t) => t && typeof t.name === 'string');
  const b = typeof bpm === 'number' && bpm > 30 && bpm < 300 ? bpm : null;
  let sub = subFromTags(tg);
  let familySlug = sub?.family ?? familyFromTags(tg);
  if (!familySlug && b === null) return null;

  if (!sub && familySlug && b !== null) {
    // A family word alone ('alternative', 'electronic') does not name a subgenre, however the tempo
    // falls: the family stays and the subgenre is left null. Tempo still places a song that carries
    // no genre tag at all (below).
    sub = null;
  } else if (!sub && b !== null) {
    // No genre at all: tempo alone, across the whole catalog. Weak evidence: the family is inferred.
    sub = bestByTempo(SUBS, b);
    familySlug = sub?.family ?? null;
  }
  if (!familySlug || !sub) {
    if (!familySlug) return null;
  }
  const family = FAMILIES.find((f) => f.slug === familySlug)!;
  const cat = sub ? CATALOG_BY_NAME.get(sub.name) : undefined;
  const hue = familyHue(familySlug);
  const fit = sub && cat && b !== null ? tempoFitIn(b, cat.lo, cat.hi, cat.halftime) : null;
  return {
    family: family.name,
    familySlug,
    subgenre: sub?.name ?? null,
    key: sub?.key ?? null,
    tempoFit: fit === null ? null : Math.round(fit * 100) / 100,
    hue,
    energy: cat?.energy ?? null,
    brightness: cat?.brightness ?? null,
    color: shade(hue, cat?.energy ?? null, cat?.brightness ?? null),
  };
}

function bestByTempo(list: SubDef[], bpm: number): SubDef | null {
  let best: SubDef | null = null;
  let bestFit = -1;
  for (const s of list) {
    const c = CATALOG_BY_NAME.get(s.name);
    if (!c) continue;
    const f = tempoFitIn(bpm, c.lo, c.hi, c.halftime);
    if (f > bestFit) {
      bestFit = f;
      best = s;
    }
  }
  return best;
}

export { SUB_BY_KEY };
