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
import { tooClose } from './artist-variety';
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
  /** WP6 (M3 via WP4's helper): the artist, as the engine names it, for spacing in the plan. */
  artist?: string;
  /** WP6 (M1): the engine's score for the row; v2's base term is its percentile in the list. */
  score?: number | null;
}

/** WP6: the mood plan version. 'v2' (the default setting) follows without locking in; 'v1' is the old order. */
export type MoodPlanVersion = 'v1' | 'v2';

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
  /** WP6 (M2, D2): seconds of the song playing before it counts in full. */
  rampS: 45,
  /** Option 2: the longest run of one main genre allowed from row 13 on (the setting: 3 / 5 / 8; off = no cap). */
  runCap: 5,
  /** Option 1: the mood may lift a fitting song from this far down the queue to the head. */
  passiveLeadFrom: 6,
  /** Option 1: how many songs in a row the mood may lead before it must let the queue through. */
  passiveLeadRun: 4,
  /** WP6 (M1): moved keys LocalApi remembers for the finished-song discount. */
  movedKeep: 64,
  /** WP6 (M3): artist gap inside the plan (WP4's tooClose). */
  artistGap: 3,
  /** WP6 (M1, D4): variety share of the plan at Familiar / middle / Adventurous, with only passive listening. */
  variety: [0.1, 0.2, 0.35],
  /** WP6 (M1): extra hysteresis for passive-only listening: bar = minGain x (1 + passiveBar x passive part). */
  passiveBar: 2,
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

/** WP6 (M2, D2): the song playing weighs 1 at second 0 and 3 once 45 s are heard. */
export function currentWeight(heardS: number | null | undefined): number {
  const h = Number.isFinite(heardS as number) ? Math.max(0, heardS as number) : 0;
  return 1 + 2 * Math.min(1, h / MOOD.rampS);
}

/** WP6 (M1): active evidence (star, Find similar, replay) vs passive (finished, playing). */
const ACTIVE: ReadonlySet<MoodKind> = new Set<MoodKind>(['like', 'similar', 'replay']);

/** WP6 (M1, D4): ε = base(a) × (1 − 0.75 × activeShare); base 0.10 / 0.20 / 0.35, linear between the slider's ends and middle. */
export function varietyShare(adventurous: number, activeShare: number): number {
  const a = Math.max(0, Math.min(1, adventurous));
  const [lo, mid, hi] = MOOD.variety;
  const base = a <= 0.5 ? lo + (mid - lo) * (a / 0.5) : mid + (hi - mid) * ((a - 0.5) / 0.5);
  return base * (1 - 0.75 * Math.max(0, Math.min(1, activeShare)));
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
  /** WP6: which plan built it (v1 = the old weights and confidence). */
  version?: MoodPlanVersion;
  /** WP6 (M1): decayed active / passive positive weight, and the active part of the positive weight. */
  active?: number;
  passive?: number;
  activeShare?: number;
  /** Option 1: how many of the songs just played in a row the mood itself moved there. */
  movedRun?: number;
}

const side = (): Side => ({ mains: new Map(), subs: new Map(), protos: [], weight: 0 });
const add = (m: Map<string, number>, k: string, w: number) => m.set(k, (m.get(k) ?? 0) + w);
const realVector = (v: ArrayLike<number> | null | undefined): v is ArrayLike<number> => Boolean(v && v.length === DIM);

/**
 * Builds the mood from signals; anything older than 90 minutes or past the newest 32 is ignored.
 * WP6 (M1, M2): with `plan: 'v2'` the song playing ramps 1 -> 3 over its first 45 s (`listened`), a finished song
 * whose key is in `moved` (the mood moved it) counts 1 instead of 2, and confidence = min(1, (active + 0.5 x passive) / 6).
 * Without options the old (v1) weights and confidence hold.
 */
export function buildMood(signals: MoodSignal[], nowS: number, o: { plan?: MoodPlanVersion; moved?: ReadonlySet<string> } = {}): Mood {
  const v2 = o.plan === 'v2';
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
  let active = 0;
  let passive = 0;
  for (const s of kept) {
    let w0 = signalWeight(s);
    if (v2 && s.kind === 'current') w0 = currentWeight(s.listened);
    if (v2 && s.kind === 'complete' && o.moved?.has(s.key)) w0 = 1;
    if (!w0) continue;
    const w = Math.abs(w0) * Math.pow(0.5, Math.max(0, nowS - s.ts) / MOOD.halfLifeS);
    const into = w0 > 0 ? pos : neg;
    into.weight += w;
    if (w0 > 0) { if (ACTIVE.has(s.kind)) active += w; else passive += w; }
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
  const confidence = v2 ? Math.min(1, (active + 0.5 * passive) / 6) : Math.min(1, pos.weight / 6);
  // Option 1: the run of songs just played that the mood itself moved to the head (newest first), so the mood can be
  // stopped from leading song after song without end.
  let movedRun = 0;
  for (const s of kept) {
    if (s.kind !== 'complete' && s.kind !== 'current') continue;
    if (!o.moved?.has(s.key)) break;
    movedRun++;
  }
  return { pos, neg, confidence, leading, version: v2 ? 'v2' : 'v1', active, passive, activeShare: active + passive > 0 ? active / (active + passive) : 0, movedRun };
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
  let d = 0;
  if (mood.neg.weight > 0) {
    const sound = soundAffinity(c.vector, mood.neg);
    const tags = blend([[affinity(c.tags.mains, mood.neg.mains), 0.15], [affinity(c.tags.subs, mood.neg.subs), 0.2]]);
    // WP6 (M5): without the sound term the tag match is not stretched to the full penalty: it counts half.
    d = mood.version === 'v2' && sound === null
      ? (tags ?? 0) * 0.5
      : blend([[affinity(c.tags.mains, mood.neg.mains), 0.15], [affinity(c.tags.subs, mood.neg.subs), 0.2], [sound, 0.65]]) ?? 0;
  }
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
  /** The mood (re-plan or lead) changed the order, not only the run cap. Drives the "re-arranged for your mood" note. */
  mood?: boolean;
}

/**
 * The upcoming MOVABLE songs, in their current (engine) order, re-arranged for the mood.
 * `adventurous` 0..1 is the Familiar <-> Adventurous slider: Familiar holds the mood tightly,
 * Adventurous lets the engine's own exploration lead.
 */
export interface MoodOrderOptions { plan?: number; minGain?: number; force?: boolean; shown?: string[]; version?: MoodPlanVersion; recentArtists?: readonly string[]; /** Setting: mood lead. On when omitted (the 0.20.19 default); false = off. */ lead?: boolean; /** Setting: genre run limit from row 13 on (3 / 5 / 8); 0 = off. Defaults to MOOD.runCap (5) when omitted. */ runLimit?: number }

/**
 * Option 2: no more than MOOD.runCap songs of one main genre in a row. Rows before index `fixed` (the planner's top
 * rows, owner decision) never move. Each step swaps an over-cap song with a different-genre song at or after `fixed`,
 * whichever swap lowers the total overshoot most (a swap moves two rows, however far apart). A song without a genre
 * never forms a run.
 */
export function capRuns(order: string[], byKey: Map<string, MoodCandidate>, fixed = 0, limit: number = MOOD.runCap): string[] {
  const out = [...order];
  const cap = limit;
  const genre = (k: string | undefined): string | null => (k === undefined ? null : byKey.get(k)?.tags.mains[0] ?? null);
  // Songs past the cap, counted inside their run. Zero means every run is within the cap.
  const excess = (seq: string[]): number => {
    let total = 0;
    let run = 0;
    let prev: string | null = null;
    for (const k of seq) {
      const g = genre(k);
      run = g !== null && g === prev ? run + 1 : g !== null ? 1 : 0;
      prev = g;
      if (run > cap) total++;
    }
    return total;
  };
  // Local search: swap one song of an over-cap run (never the head) with a different-genre song (never the head).
  // Each accepted swap strictly lowers the excess, so the loop ends; the nearest partner wins a tie.
  for (let guard = 0; guard < out.length && excess(out) > 0; guard++) {
    const block = new Array<number>(out.length).fill(1);
    for (let i = 1; i < out.length; i++) if (genre(out[i]) !== null && genre(out[i]) === genre(out[i - 1])) block[i] = block[i - 1]! + 1;
    for (let i = out.length - 2; i >= 0; i--) if (genre(out[i]) !== null && genre(out[i]) === genre(out[i + 1]) && block[i + 1]! > block[i]!) block[i] = block[i + 1]!;
    const base = excess(out);
    let best: { c: number; p: number; q: number } | null = null;
    for (let p = Math.max(1, fixed); p < out.length; p++) {
      const x = genre(out[p]);
      if (!x || block[p]! <= cap) continue;
      for (let q = Math.max(1, fixed); q < out.length; q++) {
        if (q === p || genre(out[q]) === x) continue;
        [out[p], out[q]] = [out[q]!, out[p]!];
        const c = excess(out);
        [out[p], out[q]] = [out[q]!, out[p]!];
        if (c < base && (!best || c < best.c || (c === best.c && Math.abs(q - p) < Math.abs(best.q - best.p)))) best = { c, p, q };
      }
    }
    if (!best) break;
    [out[best.p], out[best.q]] = [out[best.q]!, out[best.p]!];
  }
  return out;
}

/** Option 2 with no mood weight: the engine's order, changed only when the run cap moves a song. */
function capOnly(upcoming: MoodCandidate[], limit: number): MoodPlan {
  const keys = upcoming.map((c) => c.key);
  const capped = limit > 0 ? capRuns(keys, new Map(upcoming.map((c) => [c.key, c] as const)), MOOD.plan, limit) : keys;
  const moved = capped.filter((key, j) => keys[j] !== key);
  return { order: moved.length ? capped : keys, changed: moved.length > 0, moved, gain: 0 };
}

export function moodOrder(upcoming: MoodCandidate[], mood: Mood, adventurous: number, o: MoodOrderOptions = {}): MoodPlan {
  return (o.version ?? mood.version) === 'v2' ? moodOrderV2(upcoming, mood, adventurous, o) : moodOrderV1(upcoming, mood, adventurous, o);
}

/** The pre-WP6 order (mood_plan 'v1'): unchanged. */
function moodOrderV1(upcoming: MoodCandidate[], mood: Mood, adventurous: number, o: MoodOrderOptions): MoodPlan {
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
  return { order, changed: true, moved, gain, mood: true };
}

/**
 * WP6 (M1, M2, M5, D4): the order that follows without locking in.
 *  - b is the row's ENGINE score percentile (`score`), so the mood's own previous order does not feed back; the row's
 *    current place (`shown`) is only the hysteresis reference. Rows without a score fall back to their list place.
 *  - round(plan x ε) places keep the engine's best-scored rows whatever their fit (never one with dislike match >= 0.5),
 *    spread from place 4 onward.
 *  - the lead rule holds only with active evidence (a star, Find similar, a replay): passive listening leans, it does
 *    not hold.
 *  - artists are kept MOOD.artistGap apart inside the plan with WP4's tooClose.
 */
function moodOrderV2(upcoming: MoodCandidate[], mood: Mood, adventurous: number, o: MoodOrderOptions): MoodPlan {
  const keys = upcoming.map((c) => c.key);
  const n = upcoming.length;
  // No mood to follow: the engine's order, with only the run cap applied (option 2).
  if (n < 2 || (mood.pos.weight <= 0 && mood.neg.weight <= 0)) return capOnly(upcoming, o.runLimit ?? MOOD.runCap);
  const a = Math.max(0, Math.min(1, adventurous));
  const plan = Math.min(n, o.plan ?? MOOD.plan);
  const lambda = mood.confidence * (0.65 - 0.3 * a);
  const threshold = 0.65 - 0.3 * a;
  const span = Math.max(n - 1, 2 * MOOD.plan);
  const b = scorePercentile(upcoming, span);
  const scored = upcoming.map((c, i) => {
    const { m, d } = moodMatch(c, mood);
    const s = (1 - lambda) * b[i]! + lambda * (m ?? b[i]!) - MOOD.dislikePenalty * d;
    return { c, i, s, m, d, b: b[i]! };
  });
  const byScore = [...scored].sort((x, y) => y.s - x.s || y.b - x.b || x.i - y.i);
  const at = new Map((o.shown ?? []).map((k, j) => [k, j] as const));
  const ref = o.shown ? [...scored].sort((x, y) => (at.get(x.c.key) ?? n + x.i) - (at.get(y.c.key) ?? n + y.i)) : scored;
  const refKeys = ref.map((x) => x.c.key);
  // Variety places (D4): how many, and where (spread over places 4..plan).
  const lead = Math.min(MOOD.lead, plan);
  const k = plan > lead ? Math.min(plan - lead, Math.round(plan * varietyShare(a, mood.activeShare ?? 0))) : 0;
  const fitN = plan - k;
  const picked: typeof scored = [];
  const taken = new Set<number>();
  // Variety rows are reserved first: the engine's best-scored rows (never a dislike match >= 0.5), so the same rows
  // stay reserved from one plan to the next until they are heard.
  const variety = [...scored].sort((x, y) => y.b - x.b || x.i - y.i).filter((x) => x.d < 0.5).slice(0, k);
  for (const x of variety) taken.add(x.i);
  let leadMoved = false;
  if (mood.confidence >= 0.5 && (mood.active ?? 0) > 0) {
    const fitsNow = ref.slice(0, lead).filter((x) => x.m !== null && x.m >= threshold).length;
    for (const x of byScore) {
      if (picked.length >= lead) break;
      if (!taken.has(x.i) && x.m !== null && x.m >= threshold) { picked.push(x); taken.add(x.i); }
    }
    leadMoved = picked.length > fitsNow;
  }
  for (const x of byScore) {
    if (picked.length >= fitN) break;
    if (!taken.has(x.i)) { picked.push(x); taken.add(x.i); }
  }
  // WP4 helper (M3): keep one artist's songs MOOD.artistGap apart inside the fitted part of the plan.
  const spaced = spaceArtists(picked, o.recentArtists ?? []);
  // A variety row already on screen inside the plan keeps its shown place (it moves up as songs play, so it is heard);
  // a new one takes the next free spread slot from place 4 onward.
  const slots = varietySlots(variety.length, lead, plan);
  const place = new Map<number, (typeof scored)[number]>();
  const fresh: typeof scored = [];
  for (const x of variety) {
    const j = refKeys.indexOf(x.c.key);
    if (o.shown && j >= 0 && j < plan && !place.has(j)) place.set(j, x); else fresh.push(x);
  }
  for (const x of fresh) {
    const j = slots.find((q) => !place.has(q)) ?? Array.from({ length: plan }, (_, q) => q).reverse().find((q) => q >= lead && !place.has(q));
    if (j !== undefined) place.set(j, x);
  }
  const planned: typeof scored = [];
  const fill = [...spaced];
  for (let j = 0; planned.length < spaced.length + place.size; j++) {
    const v = place.get(j);
    if (v) planned.push(v); else if (fill.length) planned.push(fill.shift()!); else break;
  }
  for (const v of [...place.entries()].sort((x, y) => x[0] - y[0]).map((e) => e[1])) if (!planned.includes(v)) planned.push(v);
  // Rows past the plan keep their shown order: only the plan is re-planned (fewer rows moved, M1).
  const rest = ref.filter((x) => !taken.has(x.i));
  const next = [...planned, ...rest];
  const value = (list: typeof scored) => list.slice(0, plan).reduce((t, x, j) => t + x.s / (1 + j), 0);
  let norm = 0;
  for (let j = 0; j < plan; j++) norm += 1 / (1 + j);
  const gain = (value(next) - value(ref)) / norm;
  const order = next.map((x) => x.c.key);
  const moved = order.filter((key, j) => refKeys[j] !== key);
  // Passive listening leans: the less of the positive weight is active, the clearer the gain must be (x1 active .. x3
  // passive), so a passive session is not re-arranged on every small shift (M1: rows moved).
  // Dislikes are active evidence here too: only a session of plays alone gets the higher bar.
  const act = (mood.active ?? 0) + mood.neg.weight;
  const activity = act + (mood.passive ?? 0) > 0 ? act / (act + (mood.passive ?? 0)) : 0;
  const bar = (o.minGain ?? MOOD.minGain) * (1 + MOOD.passiveBar * (1 - activity));
  // Pipeline: the mood (re-plan, or the lead when the re-plan is not clearly better) gives the working order; the run
  // cap then applies from row 13 on (index MOOD.plan), so the top 12 never change and a lead move inside them is exempt.
  const byKey = new Map(upcoming.map((c) => [c.key, c] as const));
  const clearlyBetter = moved.length > 0 && (!!o.force || leadMoved || gain >= bar);
  const leadKeys = !clearlyBetter && o.lead !== false ? passiveLead(ref, refKeys, mood, threshold, o) : null;
  const moodKeys = clearlyBetter ? order : (leadKeys ?? refKeys);
  const limit = o.runLimit ?? MOOD.runCap;
  const capped = limit > 0 ? capRuns(moodKeys, byKey, MOOD.plan, limit) : moodKeys;
  const cappedMoved = capped.filter((key, j) => refKeys[j] !== key);
  return { order: capped, changed: cappedMoved.length > 0, moved: cappedMoved, gain, mood: moodKeys.some((key, j) => refKeys[j] !== key) };
}

/**
 * Option 1: a confident passive session leads with ONE song. Returns the order on screen with the first song that
 * fits the mood (within MOOD.passiveLeadFrom places) moved to the head, or null when the mood must not lead:
 * a head that already fits, no fitting song near the head, too little listening, any active signal (stars and
 * dislikes take the full lead rule above), or the mood already led the last MOOD.passiveLeadRun songs.
 */
function passiveLead(
  ref: readonly { c: MoodCandidate; m: number | null }[],
  refKeys: readonly string[],
  mood: Mood,
  threshold: number,
  o: MoodOrderOptions,
): string[] | null {
  if (!o.shown || mood.confidence < 0.5 || (mood.active ?? 0) > 0 || mood.neg.weight > 0) return null;
  if ((mood.movedRun ?? 0) >= MOOD.passiveLeadRun) return null;
  const head = ref[0];
  if (!head || (head.m !== null && head.m >= threshold)) return null;
  const j = ref.findIndex((x, q) => q > 0 && q <= MOOD.passiveLeadFrom && x.m !== null && x.m >= threshold);
  if (j < 1) return null;
  const keys = [...refKeys];
  // A swap, not a lift: the off-mood song takes the fitting song's place, so leading costs two places however far
  // down the fitting song was (a lift would shift every row in between, M1: rows moved).
  [keys[0], keys[j]] = [keys[j]!, keys[0]!];
  return keys;
}

/** WP6 (M1): b = 1 - rank / span, rank = rows scored higher (+ half the ties); list place when no row has a score. */
export function scorePercentile(cands: readonly Pick<MoodCandidate, 'score'>[], span = Math.max(cands.length - 1, 2 * MOOD.plan)): number[] {
  const has = cands.some((c) => typeof c.score === 'number' && Number.isFinite(c.score));
  const v = cands.map((c, i) => (has ? (typeof c.score === 'number' && Number.isFinite(c.score) ? c.score : -Infinity) : -i));
  return v.map((x) => {
    let higher = 0;
    let ties = 0;
    for (const y of v) { if (y > x) higher++; else if (y === x) ties++; }
    return 1 - (higher + (ties - 1) / 2) / span;
  });
}

/** WP6 (D4): the plan indices of [k] variety rows, spread evenly from place lead+1 (index [lead]) to the plan's end. */
export function varietySlots(k: number, lead: number, plan: number): number[] {
  const room = plan - lead;
  return Array.from({ length: k }, (_, j) => lead + Math.floor(((j + 1) * room) / (k + 1)));
}

function spaceArtists<T extends { c: MoodCandidate }>(list: T[], recent: readonly string[]): T[] {
  const pool = [...list];
  const out: T[] = [];
  const seen = [...recent];
  while (pool.length) {
    let j = pool.findIndex((x) => !tooClose(seen, x.c.artist ?? '', MOOD.artistGap));
    if (j < 0) j = 0;
    const [x] = pool.splice(j, 1);
    out.push(x!);
    seen.push(x!.c.artist ?? '');
  }
  return out;
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
