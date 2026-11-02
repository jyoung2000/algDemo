/**
 * The "Your sound" view model: what the learned taste looks like as families, subgenres and a
 * gradient, and what changed between two states. Pure, so both apps draw the same thing and the
 * rules are unit-tested.
 *
 * Colour follows the Taste Picker: a family owns a hue band (classify.familyHue); a subgenre is
 * shaded by its energy and brightness (classify.color). Every colour is paired with a label in the
 * UI, never used alone.
 */
import type { TasteGenre, TasteSummary } from './api';
import { classify, familyHue } from './engine/classify';
import { FAMILIES, SUBS } from './engine/genre-table';
import type { Tag } from './engine/genres';

export interface SubView {
  key: string;
  label: string;
  color: string;
  /** Share of the liked taste, 0..1. */
  share: number;
  plays: number;
}

export interface FamilyView {
  slug: string;
  name: string;
  color: string;
  /** Share of the liked taste, 0..1; the shares of all families sum to 1. */
  share: number;
  subs: SubView[];
  /** Share that names only the family (a tag like 'hip-hop' without a subgenre). */
  broad: number;
}

export interface AvoidView {
  label: string;
  family: string | null;
  skips: number;
}

export interface SoundView {
  families: FamilyView[];
  /** What the bar blends: each subgenre (and each family's general share) with its own colour, by hue. */
  bar: { color: string; share: number }[];
  avoided: AvoidView[];
  bpm: number | null;
  events: number;
  /** Liked genres the 8 families do not cover (shown as text, never dropped silently). */
  unplaced: string[];
}

const FAMILY_NAME = new Map(FAMILIES.map((f) => [f.slug, f.name] as const));
// Soft, even-lightness colours: eight hues that sit next to each other without clashing when blended.
const familyColor = (slug: string) => `hsl(${Math.round(familyHue(slug))} 54% 62%)`;

const SUB_ORDER = new Map<string, { i: number; n: number }>();
for (const f of FAMILIES) {
  const list = SUBS.filter((x) => x.family === f.slug);
  list.forEach((x, i) => SUB_ORDER.set(x.key, { i, n: list.length }));
}
/** Half-width, in degrees of hue, that a family's subgenres spread across inside its own band. */
const SUB_SPREAD = 70;

/**
 * A subgenre's colour inside the bar: its family's hue moved by its place among the family's subgenres,
 * so two hip-hop subgenres read as neighbours on the spectrum instead of the same flat colour. The
 * Taste Picker's own colours (classify.color) are untouched.
 */
export function subColor(slug: string, key: string | null): string {
  const base = familyHue(slug);
  const o = key ? SUB_ORDER.get(key) : undefined;
  if (!o || o.n < 2) return familyColor(slug);
  const t = o.i / (o.n - 1) - 0.5; // -0.5 .. 0.5
  // Lightness steps with the hue so neighbours stay apart even where two hues look alike.
  return `hsl(${Math.round(base + t * 2 * SUB_SPREAD + 360) % 360} 58% ${Math.round(60 - t * 10)}%)`;
}

function tagOf(g: TasteGenre): Tag {
  return { name: g.name, label: g.label || g.name, source: 'taste', scope: 'track', confidence: 1, inferred: false };
}

function hueOf(slug: string, key: string): number {
  const o = SUB_ORDER.get(key);
  const base = familyHue(slug);
  return o && o.n > 1 ? base + (o.i / (o.n - 1) - 0.5) * 2 * SUB_SPREAD : base;
}

/** The taste summary as families and subgenres. Null until the engine has learned anything. */
export function soundView(taste: TasteSummary | null | undefined): SoundView | null {
  if (!taste || !taste.events) return null;
  const all: TasteGenre[] = taste.genres ?? [...taste.likes, ...taste.avoids];
  const liked = all.filter((g) => g.score > 0.05);
  const total = liked.reduce((a, g) => a + g.score, 0);

  const fam = new Map<string, FamilyView>();
  const unplaced: string[] = [];
  for (const g of liked) {
    const c = classify([tagOf(g)], null);
    if (!c) {
      unplaced.push(g.label || g.name);
      continue;
    }
    const share = total > 0 ? g.score / total : 0;
    let f = fam.get(c.familySlug);
    if (!f) {
      f = { slug: c.familySlug, name: c.family, color: familyColor(c.familySlug), share: 0, subs: [], broad: 0 };
      fam.set(c.familySlug, f);
    }
    f.share += share;
    if (c.key && c.subgenre) {
      const have = f.subs.find((s) => s.key === c.key);
      if (have) {
        have.share += share;
        have.plays += g.plays ?? 0;
      } else f.subs.push({ key: c.key, label: c.subgenre, color: c.color, share, plays: g.plays ?? 0 });
    } else f.broad += share;
  }
  for (const f of fam.values()) for (const sv of f.subs) sv.color = subColor(f.slug, sv.key);
  // Unplaced genres still carry share; renormalise over what is drawn so the bar fills.
  const drawn = [...fam.values()].reduce((a, f) => a + f.share, 0);
  const norm = drawn > 0 ? 1 / drawn : 1;
  const families = [...fam.values()]
    .map((f) => ({ ...f, share: f.share * norm, broad: f.broad * norm, subs: f.subs.map((s) => ({ ...s, share: s.share * norm })).sort((a, b) => b.share - a.share) }))
    .sort((a, b) => b.share - a.share);

  const avoided: AvoidView[] = all
    .filter((g) => g.score < -0.15)
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((g) => {
      const c = classify([tagOf(g)], null);
      return { label: (c?.subgenre ?? g.label) || g.name, family: c?.family ?? null, skips: g.skips ?? 0 };
    });

  // The bar: one entry per subgenre plus each family's general share, in spectrum order, at most 8
  // (the stylesheet animates eight stops). Smaller ones fold into the nearest kept neighbour's share.
  const leaves = families.flatMap((f) => [
    ...f.subs.map((x) => ({ color: x.color, share: x.share, hue: hueOf(f.slug, x.key) })),
    ...(f.broad > 0.005 || !f.subs.length ? [{ color: f.color, share: f.broad || (f.subs.length ? 0 : f.share), hue: familyHue(f.slug) }] : []),
  ]);
  const keep = [...leaves].sort((a, b) => b.share - a.share).slice(0, 8);
  const kept = keep.reduce((a, l) => a + l.share, 0) || 1;
  const bar = keep.sort((a, b) => a.hue - b.hue).map((l) => ({ color: l.color, share: l.share / kept }));

  return { families, bar, avoided, bpm: taste.bpm, events: taste.events, unplaced };
}

/** Plain-words list for assistive tech and for the collapsed bar: "Hip-hop 62%, Pop 25%". */
export function describeSound(v: SoundView | null, max = 3): string {
  if (!v || !v.families.length) return 'Still learning your sound';
  return v.families
    .slice(0, max)
    .map((f) => `${f.name} ${Math.round(f.share * 100)}%`)
    .join(', ');
}

/**
 * One continuous gradient for the whole bar. Each family's colour sits at the middle of its share and
 * fades into its neighbours, so no segment edges exist; the ends hold their own colour. Stop positions
 * are percentages so CSS can animate them.
 */
/** Percent of the bar at each end that stays one flat colour. */
const END_HOLD = 8;

export function gradientStops(families: { color: string; share: number }[]): { color: string; at: number }[] {
  if (!families.length) return [];
  if (families.length === 1) return [{ color: families[0]!.color, at: 50 }];
  const total = families.reduce((a, f) => a + f.share, 0) || 1;
  const out: { color: string; at: number }[] = [];
  let edge = 0;
  for (const f of families) {
    const w = (f.share / total) * 100;
    out.push({ color: f.color, at: edge + w / 2 });
    edge += w;
  }
  // A family's colour is only held at its stop, so a wide first or last share would paint a flat block
  // that reads as a box. Pull the outer stops in so the blend spans nearly the whole bar; the exact
  // shares stay in the rows below.
  const last = out.length - 1;
  out[0]!.at = Math.min(out[0]!.at, END_HOLD);
  out[last]!.at = Math.max(out[last]!.at, 100 - END_HOLD);
  return out;
}

export function gradientOf(families: { color: string; share: number }[]): string {
  const st = gradientStops(families);
  if (!st.length) return 'linear-gradient(90deg, transparent, transparent)';
  const stops = st.map((x) => `${x.color} ${x.at.toFixed(1)}%`);
  return `linear-gradient(90deg in oklch, ${st[0]!.color} 0%, ${stops.join(', ')}, ${st[st.length - 1]!.color} 100%)`;
}

export interface Change {
  label: string;
  dir: 'up' | 'down' | 'new';
}

/** What moved between two states: families and subgenres whose share changed by at least `min`. */
export function soundChanges(prev: SoundView | null, next: SoundView | null, min = 0.04): Change[] {
  if (!next || !prev) return [];
  const flat = (v: SoundView | null) => {
    const m = new Map<string, number>();
    if (!v) return m;
    for (const f of v.families) {
      m.set(f.name, f.share);
      for (const s of f.subs) m.set(s.label, s.share);
    }
    return m;
  };
  const a = flat(prev);
  const b = flat(next);
  const out: (Change & { d: number })[] = [];
  for (const [label, share] of b) {
    const was = a.get(label) ?? 0;
    const d = share - was;
    if (was === 0 && share >= min / 2) out.push({ label, dir: 'new', d: share });
    else if (d >= min) out.push({ label, dir: 'up', d });
    else if (d <= -min) out.push({ label, dir: 'down', d });
  }
  for (const [label, was] of a) if (!b.has(label) && was >= min) out.push({ label, dir: 'down', d: -was });
  return out.sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 4).map(({ label, dir }) => ({ label, dir }));
}

export interface Snapshot {
  t: number;
  events: number;
  segs: { slug: string; share: number }[];
}

export const SNAPSHOT_MAX = 16;

/** Adds the current state to the history when it differs from the newest one; keeps the last SNAPSHOT_MAX. */
export function pushSnapshot(list: Snapshot[], v: SoundView | null, now: number): Snapshot[] {
  if (!v || !v.families.length) return list;
  const segs = v.families.map((f) => ({ slug: f.slug, share: Math.round(f.share * 1000) / 1000 }));
  const last = list[list.length - 1];
  if (last && last.events === v.events && JSON.stringify(last.segs) === JSON.stringify(segs)) return list;
  return [...list, { t: now, events: v.events, segs }].slice(-SNAPSHOT_MAX);
}

export const snapshotColor = familyColor;
export const familyLabel = (slug: string) => FAMILY_NAME.get(slug) ?? slug;
