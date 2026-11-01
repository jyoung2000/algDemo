/**
 * Listening taste: what the user's own listening says about genres and tempo, learned from real
 * playback and feedback events (complete, replay, like, save versus skip, dislike, hide).
 *
 * The per-song and per-artist `feedback` factor already rewards or punishes a song and its artist.
 * Taste generalises one level up: finishing three Hip-Hop songs makes other Hip-Hop songs rise, and
 * skipping fast songs makes fast songs sink. It is only scored when a Context carries `taste`, so
 * the Python-parity engine (and its golden tests) is unchanged without it.
 */
import type { Tag } from './genres';

/** Same curve as the engine's tempo factor (kept here so engine.ts can import this module). */
function tempoFit(a: number | null | undefined, b: number | null | undefined): number | null {
  if (!a || !b || a <= 0 || b <= 0) return null;
  let r = Math.abs(Math.log2(a / b));
  r = Math.min(r, Math.abs(r - 1.0));
  return Math.max(0, 1.0 - r / 0.25);
}

/** How much one event says about taste. Recent listening matters more than old (half-life below). */
export const TASTE_EVENT_WEIGHTS: Record<string, number> = {
  complete: 1.0,
  qualified: 0.5, // submitted play with unknown duration, not verified completion
  replay: 1.2,
  like: 1.5,
  save: 1.2,
  skip: -1.0,
  dislike: -1.5,
  hide: -0.8,
};

/** Taste follows recent listening: an event counts half after two weeks. */
export const TASTE_HALF_LIFE_DAYS = 14;
/** Weight of the taste factor next to the engine's own factors (they sum to 1.0). */
export const TASTE_WEIGHT = 0.15;

export interface TasteRow {
  key: string;
  kind: string;
  ts: number; // unix seconds
  track?: Record<string, unknown> | null;
}

export interface GenreTaste {
  name: string;
  label: string;
  score: number; // signed, decayed sum
  plays: number; // positive events
  skips: number; // negative events
}

export interface TasteProfile {
  genres: Record<string, GenreTaste>;
  /** Weighted mean BPM of songs the user kept listening to; null until there is any. */
  bpm: number | null;
  bpmEvidence: number;
  /** Weighted mean BPM of skipped songs, for the explanation only. */
  skipBpm: number | null;
  positives: number;
  negatives: number;
  events: number;
}

function decay(ts: number, nowTs: number): number {
  const age = Math.max(0, (nowTs - ts) / 86400);
  return Math.pow(0.5, age / TASTE_HALF_LIFE_DAYS);
}

function tagsOf(t: Record<string, unknown> | null | undefined): Tag[] {
  const v = t?.['tags'];
  return Array.isArray(v) ? (v as Tag[]).filter((g) => g && typeof g.name === 'string') : [];
}

function bpmOf(t: Record<string, unknown> | null | undefined): number | null {
  const b = Number(t?.['bpm']);
  return Number.isFinite(b) && b > 30 && b < 300 ? b : null;
}

export function buildTaste(rows: TasteRow[], nowTs: number): TasteProfile {
  const genres: Record<string, GenreTaste> = {};
  let bpmSum = 0, bpmW = 0, skipSum = 0, skipW = 0, pos = 0, neg = 0, events = 0;
  for (const r of rows) {
    const base = TASTE_EVENT_WEIGHTS[r.kind];
    if (base === undefined) continue;
    events++;
    const w = base * decay(r.ts, nowTs);
    if (base > 0) pos++;
    else neg++;
    // One song's genres share its weight, so a song with five tags does not count five times.
    const tags = tagsOf(r.track);
    const seen = new Set<string>();
    const uniq = tags.filter((g) => (seen.has(g.name) ? false : (seen.add(g.name), true)));
    const share = uniq.length ? 1 / Math.sqrt(uniq.length) : 0;
    for (const g of uniq) {
      const e = (genres[g.name] ??= { name: g.name, label: g.label || g.name, score: 0, plays: 0, skips: 0 });
      e.score += w * share * Math.max(0.3, Math.min(1, g.confidence ?? 1));
      if (base > 0) e.plays++;
      else e.skips++;
    }
    const b = bpmOf(r.track);
    if (b !== null) {
      if (base > 0) {
        bpmSum += b * w;
        bpmW += w;
      } else {
        skipSum += b * -w;
        skipW += -w;
      }
    }
  }
  return {
    genres,
    bpm: bpmW > 0 ? bpmSum / bpmW : null,
    bpmEvidence: bpmW,
    skipBpm: skipW > 0 ? skipSum / skipW : null,
    positives: pos,
    negatives: neg,
    events,
  };
}

export interface TasteFit {
  value: number; // 0..1, 0.5 neutral
  genre: GenreTaste | null; // the genre that moved it most
  genrePart: number | null; // -1..1
  tempoPart: number | null; // 0..1
}

/** How well a song fits the listening taste; null when the taste says nothing about it. */
export function tasteFit(t: { tags?: Tag[] | null; bpm?: number | null }, taste: TasteProfile | null | undefined): TasteFit | null {
  if (!taste || !taste.events) return null;
  let gNum = 0, gDen = 0;
  let strongest: GenreTaste | null = null;
  for (const g of t.tags ?? []) {
    const e = taste.genres[g.name];
    if (!e) continue;
    const c = Math.max(0.3, Math.min(1, g.confidence ?? 1));
    gNum += Math.tanh(e.score / 2) * c;
    gDen += c;
    if (!strongest || Math.abs(e.score) > Math.abs(strongest.score)) strongest = e;
  }
  const genrePart = gDen > 0 ? gNum / gDen : null;
  // Tempo only once a few kept songs had a known tempo; half/double time counts as close.
  const tempoPart = taste.bpm !== null && taste.bpmEvidence >= 1.5 ? tempoFit(t.bpm ?? null, taste.bpm) : null;
  if (genrePart === null && tempoPart === null) return null;
  let v: number;
  if (genrePart !== null && tempoPart !== null) v = 0.75 * (0.5 + 0.5 * genrePart) + 0.25 * tempoPart;
  else if (genrePart !== null) v = 0.5 + 0.5 * genrePart;
  else v = 0.35 + 0.3 * tempoPart!; // tempo alone is weak evidence: 0.35..0.65
  return { value: Math.min(1, Math.max(0, v)), genre: strongest, genrePart, tempoPart };
}

/** Plain-language summary for the UI: what the engine has learned so far. */
export function tasteSummary(taste: TasteProfile | null | undefined): Record<string, unknown> | null {
  if (!taste || !taste.events) return null;
  const list = Object.values(taste.genres);
  const liked = list.filter((g) => g.score > 0.15).sort((a, b) => b.score - a.score).slice(0, 4);
  const avoided = list.filter((g) => g.score < -0.15).sort((a, b) => a.score - b.score).slice(0, 3);
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    events: taste.events,
    positives: taste.positives,
    negatives: taste.negatives,
    bpm: taste.bpm !== null && taste.bpmEvidence >= 1.5 ? Math.round(taste.bpm) : null,
    skip_bpm: taste.skipBpm !== null ? Math.round(taste.skipBpm) : null,
    likes: liked.map((g) => ({ name: g.name, label: g.label, score: r(g.score), plays: g.plays })),
    avoids: avoided.map((g) => ({ name: g.name, label: g.label, score: r(g.score), skips: g.skips })),
  };
}
