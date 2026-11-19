/**
 * MOOD-QUEUE-001 (owner, 2026-11-19): the now playing queue follows the CURRENT listening mood.
 * "If a user is listening to rap and electronic music don't queue up smooth jazz next": the songs
 * still to come are re-arranged by genre, subgenre and measured sound, starring a song and "Find
 * similar sound" count most, a dislike pushes its kind of song away, and the Familiar <-> Adventurous
 * slider sets how tightly the order holds the mood.
 *
 * Merged from the two design answers (claude-fable-5, gpt-6-astra; scratch/ui-mood/*.md):
 *  - mood = the last 32 signals within 90 minutes, each halved every 15 minutes;
 *  - weights: complete +2, replay +3, star +5, similar +6, dislike -6, early skip -1.5, current +3;
 *  - per song: M = (.40 G + .25 U + .35 E) over the terms that exist (a song with no measured sound is
 *    not a poor match: the term is left out and the rest re-weighted), D the same against dislikes;
 *  - S = (1 - lambda) B + lambda M - .30 D, lambda = c (.65 - .30 a), c = confidence, a = adventurous;
 *  - only the next 12 movable songs are planned, and an order is only taken when it is clearly better,
 *    so a tiny score change never shuffles the list.
 * This module is pure: callers own what is movable (played, current, hand-added songs never are).
 */
import { cosine, DIM } from './audio';
import { calibrateAudio } from './engine';
import { familyIdentity, genreIdentity, subIdentity, type GenreIdentity } from './genre-identity';
import { MOOD_FIT_UNKNOWN } from './mood-shuffle';

export type MoodKind = 'complete' | 'replay' | 'like' | 'similar' | 'dislike' | 'skip' | 'current';

/** One thing the listener did, with what the song is. */
export interface MoodSignal {
  key: string;
  kind: MoodKind;
  /** Seconds since the epoch. */
  ts: number;
  tags: MoodTags;
  vector: ArrayLike<number> | null;
  /** For a skip: seconds heard and the song's length, to tell an early skip from a late one. */
  listened?: number | null;
  duration?: number | null;
}

export interface MoodTags {
  /** Broad genre (the Taste Picker family): rap and hip hop are one, smooth jazz is jazz. */
  mains: string[];
  /** Finer: the genre word and the subgenre ("genre:rap", "sub:rage"). */
  subs: string[];
  /** The name each finer key is shown by ("Rap", "Rage"). */
  labels?: Record<string, string>;
}

export interface MoodCandidate {
  key: string;
  tags: MoodTags;
  vector: ArrayLike<number> | null;
}

export const MOOD = {
  window: 32,
  maxAgeS: 90 * 60,
  halfLifeS: 15 * 60,
  /** Songs planned ahead; the rest keep the engine's order. */
  plan: 12,
  /** The first songs, which must fit the mood when enough songs do. */
  lead: 3,
  /** Weighted mean score gain an order must bring before it replaces the one on screen. */
  minGain: 0.02,
  dislikePenalty: 0.3,
  /** Two stars of one song inside this many seconds are one signal. */
  repeatS: 30,
} as const;

// MOOD-NOW-001 (owner, 2026-11-19): the song playing now is what the listener is in the mood for, so it
// counts like a replay: on its own it is enough for the queue to start following it.
const WEIGHT: Record<MoodKind, number> = { complete: 2, replay: 3, like: 5, similar: 6, dislike: -6, skip: -1.5, current: 3 };

/** An early skip (before 30 s AND before a quarter of the song) says "not this"; a late one says nothing. */
export function signalWeight(s: Pick<MoodSignal, 'kind' | 'listened' | 'duration'>): number {
  if (s.kind !== 'skip') return WEIGHT[s.kind];
  const heard = s.listened ?? 0;
  const quarter = s.duration && s.duration > 0 ? s.duration * 0.25 : Infinity;
  return heard < 30 && heard < quarter ? WEIGHT.skip : 0;
}

/** The mood's genres, words and sound, for what the listener liked and, separately, what they did not. */
interface Side {
  mains: Map<string, number>;
  subs: Map<string, number>;
  protos: { v: ArrayLike<number>; w: number }[];
  weight: number;
}
export interface Mood {
  pos: Side;
  neg: Side;
  /** 0..1: how much listening the mood rests on (six points of positive evidence is full). */
  confidence: number;
  /** For the screen: the leading broad genres, strongest first. */
  leading: string[];
}

const side = (): Side => ({ mains: new Map(), subs: new Map(), protos: [], weight: 0 });
const add = (m: Map<string, number>, k: string, w: number) => m.set(k, (m.get(k) ?? 0) + w);
const realVector = (v: ArrayLike<number> | null | undefined): v is ArrayLike<number> => Boolean(v && v.length === DIM);

/** Builds the mood from signals; anything older than 90 minutes or past the newest 32 is ignored. */
export function buildMood(signals: MoodSignal[], nowS: number): Mood {
  const recent = signals
    .filter((s) => s.ts <= nowS + 60 && nowS - s.ts <= MOOD.maxAgeS)
    .sort((a, b) => b.ts - a.ts);
  // One star (or one "similar") of a song counts once however often it is pressed in a row.
  const seen = new Map<string, number>();
  const kept: MoodSignal[] = [];
  for (const s of recent) {
    if (s.kind === 'like' || s.kind === 'similar' || s.kind === 'dislike') {
      const id = `${s.kind}:${s.key}`;
      const last = seen.get(id);
      if (last !== undefined && last - s.ts < MOOD.repeatS) continue;
      seen.set(id, s.ts);
    }
    kept.push(s);
    if (kept.length >= MOOD.window) break;
  }
  const pos = side();
  const neg = side();
  for (const s of kept) {
    const w0 = signalWeight(s);
    if (!w0) continue;
    const w = Math.abs(w0) * Math.pow(0.5, Math.max(0, nowS - s.ts) / MOOD.halfLifeS);
    const into = w0 > 0 ? pos : neg;
    into.weight += w;
    for (const g of s.tags.mains) add(into.mains, g, w);
    for (const g of s.tags.subs) add(into.subs, g, w);
    if (realVector(s.vector)) into.protos.push({ v: s.vector, w });
  }
  // Prototypes too faint to mean anything are dropped (a decayed weight under 0.25).
  pos.protos = pos.protos.filter((p) => p.w >= 0.25);
  neg.protos = neg.protos.filter((p) => p.w >= 0.25);
  // For the screen: the main genres the mood leans on ("Rap", "Electronic"), strongest first.
  const labels: Record<string, string> = {};
  for (const s of kept) Object.assign(labels, s.tags.labels ?? {});
  const ranked = [...pos.subs.entries()].filter(([k]) => labels[k]).sort((a, b) => b[1] - a[1]);
  const mainsFirst = [...ranked.filter(([k]) => k.startsWith('genre:')), ...ranked.filter(([k]) => !k.startsWith('genre:'))];
  const leading = [...new Set(mainsFirst.map(([k]) => labels[k]!))].slice(0, 2);
  return { pos, neg, confidence: Math.min(1, pos.weight / 6), leading };
}

/** 0..1: how well the tags line up with one side, against that side's strongest tag. */
function affinity(tags: string[], m: Map<string, number>): number | null {
  if (!m.size || !tags.length) return null;
  let top = 0;
  for (const v of m.values()) top = Math.max(top, v);
  if (top <= 0) return null;
  let best = 0;
  for (const t of tags) best = Math.max(best, (m.get(t) ?? 0) / top);
  return Math.min(1, best);
}

/** 0..1 measured sound match against a side's songs: mostly the closest one, partly all of them. */
function soundAffinity(v: ArrayLike<number> | null, s: Side): number | null {
  if (!realVector(v) || !s.protos.length) return null;
  let max = 0;
  let num = 0;
  let den = 0;
  for (const p of s.protos) {
    const m = Math.max(0, Math.min(1, calibrateAudio(cosine(v, p.v))));
    max = Math.max(max, m);
    num += m * p.w;
    den += p.w;
  }
  return 0.7 * max + 0.3 * (den ? num / den : 0);
}

function blend(parts: [number | null, number][]): number | null {
  let num = 0;
  let den = 0;
  for (const [v, w] of parts) if (v !== null) { num += v * w; den += w; }
  return den ? num / den : null;
}

/** M (fit to the mood) and D (fit to what was disliked); null M means nothing to judge it by. */
export function moodMatch(c: MoodCandidate, mood: Mood): { m: number | null; d: number } {
  const m = mood.pos.weight > 0
    ? blend([[affinity(c.tags.mains, mood.pos.mains), 0.4], [affinity(c.tags.subs, mood.pos.subs), 0.25], [soundAffinity(c.vector, mood.pos), 0.35]])
    : null;
  const d = mood.neg.weight > 0
    ? blend([[affinity(c.tags.mains, mood.neg.mains), 0.15], [affinity(c.tags.subs, mood.neg.subs), 0.2], [soundAffinity(c.vector, mood.neg), 0.65]]) ?? 0
    : 0;
  return { m, d: Math.max(0, Math.min(1, d)) };
}

export interface MoodPlan {
  /** Every candidate's key, in the order to play. */
  order: string[];
  /** The order differs from the one on screen (`shown`, else the one given) and is clearly better. */
  changed: boolean;
  /** Keys whose place changed. */
  moved: string[];
  /** How much better the plan scores, for tests and logs. */
  gain: number;
}

/**
 * The upcoming MOVABLE songs, in their current (engine) order, re-arranged for the mood.
 * `adventurous` 0..1 is the Familiar <-> Adventurous slider: Familiar holds the mood tightly,
 * Adventurous lets the engine's own exploration lead.
 */
export function moodOrder(upcoming: MoodCandidate[], mood: Mood, adventurous: number, o: { plan?: number; minGain?: number; force?: boolean; shown?: string[] } = {}): MoodPlan {
  const keys = upcoming.map((c) => c.key);
  const same: MoodPlan = { order: keys, changed: false, moved: [], gain: 0 };
  const n = upcoming.length;
  if (n < 2 || (mood.pos.weight <= 0 && mood.neg.weight <= 0)) return same;
  const a = Math.max(0, Math.min(1, adventurous));
  const plan = Math.min(n, o.plan ?? MOOD.plan);
  const lambda = mood.confidence * (0.65 - 0.3 * a);
  const threshold = 0.65 - 0.3 * a;
  // The engine's order, as a score: one place is worth 1/24, so on a short list the mood is not
  // drowned by a big step between neighbours, and on a long one the far end stays far.
  const span = Math.max(n - 1, 2 * MOOD.plan);
  const scored = upcoming.map((c, i) => {
    const b = 1 - i / span;
    const { m, d } = moodMatch(c, mood);
    const s = (1 - lambda) * b + lambda * (m ?? b) - MOOD.dislikePenalty * d;
    return { c, i, s, m };
  });
  // Only the next `plan` songs are re-arranged, chosen from the whole list: a song further down
  // that fits the mood may move up into them; what they push out keeps the engine's order after.
  const byScore = [...scored].sort((x, y) => y.s - x.s || x.i - y.i);
  // What is on screen now: the order the listener sees (songs new to it after, in engine order).
  // A new plan has to beat THIS order, so a fresh engine re-rank does not jolt the list back and forth.
  const at = new Map((o.shown ?? []).map((k, j) => [k, j] as const));
  const ref = o.shown ? [...scored].sort((x, y) => (at.get(x.c.key) ?? n + x.i) - (at.get(y.c.key) ?? n + y.i)) : scored;
  const refKeys = ref.map((x) => x.c.key);
  const picked: typeof scored = [];
  const taken = new Set<number>();
  // The lead rule: with a settled mood, the next songs fit it whenever enough songs do. It is a
  // rule, not a score, so it applies even when the engine ranked the fitting song far down.
  let leadMoved = false;
  if (mood.confidence >= 0.5) {
    const lead = Math.min(MOOD.lead, plan);
    const fitsNow = ref.slice(0, lead).filter((x) => x.m !== null && x.m >= threshold).length;
    for (const x of byScore) {
      if (picked.length >= lead) break;
      if (x.m !== null && x.m >= threshold) { picked.push(x); taken.add(x.i); }
    }
    leadMoved = picked.length > fitsNow;
  }
  for (const x of byScore) {
    if (picked.length >= plan) break;
    if (!taken.has(x.i)) { picked.push(x); taken.add(x.i); }
  }
  const rest = scored.filter((x) => !taken.has(x.i));
  const next = [...picked, ...rest];
  // Earlier places matter more: score each order by its songs' scores, weighted 1/(1+place).
  const value = (list: typeof scored) => list.slice(0, plan).reduce((t, x, j) => t + x.s / (1 + j), 0);
  let norm = 0;
  for (let j = 0; j < plan; j++) norm += 1 / (1 + j);
  const gain = (value(next) - value(ref)) / norm;
  const order = next.map((x) => x.c.key);
  const moved = order.filter((k, j) => refKeys[j] !== k);
  if (!moved.length || (!o.force && !leadMoved && gain < (o.minGain ?? MOOD.minGain))) return { order: refKeys, changed: false, moved: [], gain };
  return { order, changed: true, moved, gain };
}

/** Broad genre and finer genre words of a song, from the characteristics the listing shows. */
export function moodTags(c: { genres?: string[] | null; family?: string | null; subgenre?: string | null; families?: { family: string; subgenre?: string | null }[] | null; styles?: string[] | null } | null | undefined): MoodTags {
  if (!c) return { mains: [], subs: [] };
  const ids: (GenreIdentity | null)[] = [
    ...(c.genres ?? []).flatMap((g) => g.split(/\s*[/·,]\s*/)).filter(Boolean).slice(0, 4).map(genreIdentity),
    ...(c.families ?? []).flatMap((f) => [familyIdentity(f.family), f.subgenre ? subIdentity(f.subgenre) : null]),
    c.family ? familyIdentity(c.family) : null,
    c.subgenre ? subIdentity(c.subgenre) : null,
    ...(c.styles ?? []).slice(0, 3).map(genreIdentity),
  ];
  const mains = new Set<string>();
  const subs = new Set<string>();
  const labels: Record<string, string> = {};
  for (const id of ids) {
    if (!id) continue;
    if (id.family) mains.add(`family:${id.family}`);
    if (!id.key.startsWith('family:')) { subs.add(id.key); labels[id.key] = id.label; }
  }
  return { mains: [...mains], subs: [...subs], labels };
}

/**
 * MOOD-SHUFFLE-001 (owner, 2026-11-19: "shuffle shouldn't ignore my listening mood"): how well each song
 * fits the mood right now, 0..1 (the mood match less the dislike penalty). Songs with nothing to judge
 * them by are left out; callers treat them as middling. Empty while there is no listening to go by.
 */
export function moodFit(cands: MoodCandidate[], mood: Mood): { fit: Record<string, number>; confidence: number } {
  const fit: Record<string, number> = {};
  if (mood.pos.weight <= 0 && mood.neg.weight <= 0) return { fit, confidence: 0 };
  for (const c of cands) {
    const { m, d } = moodMatch(c, mood);
    if (m === null && d === 0) continue;
    fit[c.key] = Math.round(Math.max(0, Math.min(1, (m ?? MOOD_FIT_UNKNOWN) - MOOD.dislikePenalty * d)) * 1000) / 1000;
  }
  return { fit, confidence: mood.confidence };
}

export { MOOD_FIT_UNKNOWN, moodShufflePick } from './mood-shuffle';
