/**
 * The one scoring implementation. TypeScript port of server/airwave_discovery/engine.py. Pure and
 * deterministic: same seeds, candidates, feedback, vectors, settings and `now` give the same queue.
 * Dates are passed as ISO strings (YYYY-MM-DD) and `now` as a Date at UTC midnight, matching Python's date.
 */
import * as G from './genres';
import { AFFINITY_FACTORS, DEFAULT_ENGINE, FEEDBACK_WEIGHTS, type EngineConfig, type Weights, type Factor } from './config';
import { splitArtists } from './identity';
import { TASTE_WEIGHT, tasteFit, type TasteProfile } from './taste';
import { tasteFit2, type TasteBlend } from './taste2';
import { SEED_GUESS_SOURCE, SOUND_GUESS_SOURCE } from './infer';

export const SEED_FACTORS = ['audio', 'genre', 'artist', 'provider', 'tempo'] as const;
export const GLOBAL_FACTORS = ['feedback', 'freshness', 'novelty'] as const;

// relation: [strength, human label, counts as provider evidence]
export const RELATION: Record<string, [number, string, boolean]> = {
  related_song: [1.0, 'YouTube Music lists it under “You might also like” for', true],
  radio: [0.85, "It plays on YouTube Music's radio for", true],
  sc_recommended: [0.85, 'SoundCloud recommends it next to', true],
  artist_radio: [0.7, "It is on Deezer's artist radio for", true],
  related_artist_top: [0.55, 'A top song by an artist Deezer relates to', true],
  ytm_related_artist: [0.55, 'A song by an artist YouTube Music lists as similar to', true],
  seed_artist_top: [0.6, 'Another song by the artist of', true],
  recent: [0.45, 'A recent release connected to', true],
  genre_chart: [0.0, 'From the Deezer genre chart matching', false], // exploration pool, not relatedness
  // Apple's search for the seed's own title and artist: the same catalogue, not a platform's view of relatedness.
  search_match: [0.5, 'Apple Music’s catalogue turns it up for', false],
};
export const EXPLORATION_RELATIONS = new Set(['genre_chart']);

export interface Settings {
  adventurous: number; // 0 familiar .. 1 adventurous; 0.5 is neutral scoring
  fresh: boolean; // favour songs released recently, when the source gives a real date
  vocals: 'any';
}

export function normaliseSettings(s: Partial<Settings>): Settings {
  const a = Number(s.adventurous ?? 0.5);
  return { adventurous: Math.min(1, Math.max(0, a)), fresh: Boolean(s.fresh), vocals: 'any' };
}

export interface Release {
  date: string;
  precision: 'day' | 'month' | 'year';
  kind?: string;
  source?: string;
}

export interface Provenance {
  seed: string;
  relation: string;
  rank?: number;
  via?: string;
  /** Gathering source id (e.g. "deezer-artist-radio"); its first segment names the provider family. */
  source?: string;
}

export interface Track {
  key: string;
  title: string;
  artists: string[];
  tags: G.Tag[];
  provenance: Provenance[];
  release: Release | null;
  bpm: number | null;
  unavailable?: boolean;
  artist_from_url?: boolean;
  emphasis?: number;
}

export interface Reason {
  factor: string;
  text: string;
  weight: number;
}

export interface Scored {
  track: Track;
  final: number;
  affinity: number;
  coverage: number;
  bestSeed: string | null;
  perSeed: Record<string, number>;
  factors: Record<string, number | null>;
  weightsUsed: Record<string, number>;
  tier: string;
  exposurePenalty: number;
  reasons: Reason[];
  uncertainty: string[];
  newRelease: boolean;
}

// ---------------------------------------------------------------------------------------------
// factor helpers
// ---------------------------------------------------------------------------------------------
export function calibrateAudio(cos: number): number {
  return Math.min(1, Math.max(0, (cos - 0.3) / 0.55));
}

export function tempoFit(a: number | null | undefined, b: number | null | undefined): number | null {
  if (!a || !b || a <= 0 || b <= 0) return null;
  let r = Math.abs(Math.log2(a / b));
  r = Math.min(r, Math.abs(r - 1.0)); // half/double time
  return Math.max(0, 1.0 - r / 0.25);
}

/** Days from `now` to the date; null unless the precision is day or month. */
export function ageDays(rel: Release | null | undefined, now: Date): number | null {
  if (!rel || (rel.precision !== 'day' && rel.precision !== 'month')) return null;
  const s = rel.date;
  const iso = rel.precision === 'day' ? s : s + '-15';
  const d = parseIsoDate(iso);
  if (!d) return null;
  return Math.round((utcMidnight(now) - d) / 86400000);
}

function parseIsoDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // reject impossible dates such as 2026-02-30 (Python's fromisoformat raises for them)
  const back = new Date(t);
  if (back.getUTCMonth() !== Number(m[2]) - 1 || back.getUTCDate() !== Number(m[3])) return null;
  return t;
}

function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Day/month-precision dates only; a year alone does not say how fresh something is. */
export function freshness(rel: Release | null | undefined, now: Date): number | null {
  const age = ageDays(rel, now);
  if (age === null || age < -7) return null;
  let score = Math.max(0, 1.0 - Math.max(0, age) / 365.0);
  if (rel!.kind === 'upload') score *= 0.5; // an upload date is not a release date
  if (rel!.precision === 'month') score *= 0.8;
  return score;
}

export function isNewRelease(rel: Release | null | undefined, now: Date, window: number): boolean {
  if (!rel || rel.precision !== 'day' || rel.kind !== 'release') return false;
  const age = ageDays(rel, now);
  return age !== null && age >= -7 && age <= window;
}

export function primaryArtist(t: Pick<Track, 'artists'>): string {
  const names = splitArtists(t.artists ?? []);
  return names[0] ?? '';
}

export function artistSet(t: Pick<Track, 'artists'>): Set<string> {
  return new Set(splitArtists(t.artists ?? []));
}

// ---------------------------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------------------------
export interface FeedbackEvent {
  event_id: string;
  key: string;
  kind: string;
  artist?: string;
  ts: number; // unix seconds
  /** v2 schema (all optional; stored v1 rows simply lack them) */
  listened?: number | null; // seconds actually heard (seek/pause-corrected by the player)
  duration?: number | null; // known total length of what played, seconds; null = unknown
  coverage?: number | null; // unique content heard, seconds; rewinds excluded
  medium?: string | null; // 'preview' | 'full' | 'embed'
  session?: string | null; // player session id
  origin?: string | null; // 'queue' | 'manual' | 'import:<source>'
  confidence?: number | null; // telemetry confidence 0..1 (imports < live playback)
}

export interface FeedbackView {
  track: Record<string, number>;
  artist: Record<string, number>;
  excluded: Set<string>;
  hidden: Set<string>;
  likedArtists: Set<string>;
  events: number;
}

export function decay(ts: number, nowTs: number, halfLifeDays: number): number {
  const age = Math.max(0, (nowTs - ts) / 86400.0);
  return Math.pow(0.5, age / halfLifeDays);
}

/** Deduplicated by event_id upstream (UNIQUE) and again here. Seed selections are never events. */
export function buildFeedback(events: FeedbackEvent[], nowTs: number, cfg: EngineConfig = DEFAULT_ENGINE): FeedbackView {
  const seen = new Set<string>();
  const track: Record<string, number> = {};
  const artist: Record<string, number> = {};
  const skippedByArtist = new Map<string, Set<string>>();
  const latest = new Map<string, [number, string]>();
  const hidden = new Set<string>();
  const sorted = [...events].sort((x, y) => x.ts - y.ts || (x.event_id < y.event_id ? -1 : x.event_id > y.event_id ? 1 : 0));
  for (const e of sorted) {
    if (seen.has(e.event_id) || !(e.kind in FEEDBACK_WEIGHTS) || e.kind === 'seed') continue;
    seen.add(e.event_id);
    const w = FEEDBACK_WEIGHTS[e.kind]! * decay(e.ts, nowTs, cfg.feedbackHalfLifeDays);
    track[e.key] = (track[e.key] ?? 0) + w;
    const a = e.artist ?? '';
    if (e.kind === 'like' || e.kind === 'dislike' || e.kind === 'hide') latest.set(e.key, [e.ts, e.kind]);
    if (e.kind === 'hide' && nowTs - e.ts < 30 * 86400) hidden.add(e.key);
    if (!a) continue;
    if (e.kind === 'skip') {
      if (!skippedByArtist.has(a)) skippedByArtist.set(a, new Set());
      skippedByArtist.get(a)!.add(e.key);
    } else {
      artist[a] = (artist[a] ?? 0) + w * 0.5;
    }
  }
  // One skipped song never colours an artist; three distinct ones propagate weakly.
  for (const [a, keys] of skippedByArtist) {
    if (keys.size >= cfg.artistSkipThreshold) artist[a] = (artist[a] ?? 0) - 0.5 * keys.size;
  }
  const excluded = new Set<string>();
  for (const [k, [, kind]] of latest) if (kind === 'dislike') excluded.add(k);
  const liked = new Set(Object.keys(artist).filter((a) => artist[a]! > 1.0));
  return { track, artist, excluded, hidden, likedArtists: liked, events: seen.size };
}

/**
 * v2 feedback: one listening session is one endorsement, not four.
 *
 *  - complete/replay events are grouped per (track, UTC day): the first counts fully, the second
 *    half, later ones nothing — so looping a song all night is two endorsements, not forty.
 *  - a preview completion is 60% of a full-track completion, and a known completion ratio below
 *    90% scales the weight down linearly (never below half); unknown duration stays at full weight
 *    rather than manufacturing a ratio.
 *  - telemetry confidence (imports) scales the event.
 *  - artist spillover grows with the square root of the number of distinct endorsed songs, not the
 *    raw sum, so 40 plays of one song never outweigh 4 different liked songs.
 *  - explicit judgements (like/save/dislike/hide) are unchanged — a person saying so stays the
 *    strongest signal; the skip threshold rule is kept as in v1.
 */
export function buildFeedback2(events: FeedbackEvent[], nowTs: number, cfg: EngineConfig = DEFAULT_ENGINE): FeedbackView {
  const seen = new Set<string>();
  const track: Record<string, number> = {};
  const artistPos = new Map<string, Map<string, number>>(); // artist -> key -> best positive weight
  const artistNeg: Record<string, number> = {};
  const skippedByArtist = new Map<string, Set<string>>();
  const latest = new Map<string, [number, string]>();
  const hidden = new Set<string>();
  const perDay = new Map<string, number>(); // `${key}|${day}` -> behavioral events already counted
  const sorted = [...events].sort((x, y) => x.ts - y.ts || (x.event_id < y.event_id ? -1 : x.event_id > y.event_id ? 1 : 0));
  for (const e of sorted) {
    if (seen.has(e.event_id) || !(e.kind in FEEDBACK_WEIGHTS) || e.kind === 'seed') continue;
    seen.add(e.event_id);
    let base = FEEDBACK_WEIGHTS[e.kind]!;
    const conf = e.confidence === null || e.confidence === undefined ? 1 : Math.min(1, Math.max(0, e.confidence));
    if (e.kind === 'complete' || e.kind === 'replay' || e.kind === 'qualified') {
      const day = Math.floor(e.ts / 86400);
      const slot = `${e.key}|${day}`;
      const had = perDay.get(slot) ?? 0;
      perDay.set(slot, had + 1);
      if (had >= 2) continue; // third+ behavioral endorsement of the same song that day says nothing new
      if (had === 1) base *= 0.5;
      if (e.medium === 'preview') base *= 0.6; // 30 seconds heard, not the song
      const heard = e.coverage ?? e.listened;
      const dur = Number(e.duration), lis = Number(heard);
      if (e.kind === 'complete' && e.duration != null && heard != null && Number.isFinite(dur) && dur > 0 && Number.isFinite(lis) && lis >= 0) {
        const ratio = Math.min(1, lis / dur);
        if (ratio < 0.9) base *= Math.max(0.5, ratio); // partial hear counts partially; unknown duration is left alone
      }
    }
    const w = base * conf * decay(e.ts, nowTs, cfg.feedbackHalfLifeDays);
    track[e.key] = (track[e.key] ?? 0) + w;
    const a = e.artist ?? '';
    if (e.kind === 'like' || e.kind === 'dislike' || e.kind === 'hide') latest.set(e.key, [e.ts, e.kind]);
    if (e.kind === 'hide' && nowTs - e.ts < 30 * 86400) hidden.add(e.key);
    if (!a) continue;
    if (e.kind === 'skip') {
      if (!skippedByArtist.has(a)) skippedByArtist.set(a, new Set());
      skippedByArtist.get(a)!.add(e.key);
    } else if (w > 0) {
      const m = artistPos.get(a) ?? new Map<string, number>();
      artistPos.set(a, m);
      m.set(e.key, Math.max(m.get(e.key) ?? 0, w));
    } else {
      artistNeg[a] = (artistNeg[a] ?? 0) + w * 0.5;
    }
  }
  const artist: Record<string, number> = { ...artistNeg };
  for (const [a, m] of artistPos) {
    // sqrt over distinct endorsed songs: breadth of liking an artist, with diminishing returns
    let sum = 0;
    for (const v of m.values()) sum += v;
    const mean = sum / m.size;
    artist[a] = (artist[a] ?? 0) + 0.5 * mean * Math.sqrt(m.size);
  }
  for (const [a, keys] of skippedByArtist) {
    if (keys.size >= cfg.artistSkipThreshold) artist[a] = (artist[a] ?? 0) - 0.5 * keys.size;
  }
  const excluded2 = new Set<string>();
  for (const [k, [, kind]] of latest) if (kind === 'dislike') excluded2.add(k);
  const liked2 = new Set(Object.keys(artist).filter((a) => artist[a]! > 1.0));
  return { track, artist, excluded: excluded2, hidden, likedArtists: liked2, events: seen.size };
}

export function feedbackFit(t: Track, fb: FeedbackView): number | null {
  let s = 0;
  let found = false;
  if (t.key in fb.track) {
    s += fb.track[t.key]!;
    found = true;
  }
  for (const a of artistSet(t)) {
    if (a in fb.artist) {
      s += fb.artist[a]!;
      found = true;
    }
  }
  if (!found) return null;
  return 0.5 + 0.5 * Math.tanh(s / 8.0);
}

// ---------------------------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------------------------
/** Multiplier for one factor: `near` at slider 0, 1.0 at 0.5, `far` at slider 1, linear in between. */
export function blend(near: number, far: number, a: number): number {
  if (a <= 0.5) return 1.0 + ((near - 1.0) * (0.5 - a)) / 0.5;
  return 1.0 + ((far - 1.0) * (a - 0.5)) / 0.5;
}

/** Scoring weights for a point on the Familiar..Adventurous slider, plus the new-releases switch. */
export function modeWeights(w: Weights, adventurous: number, fresh = false): Record<Factor, number> {
  const d: Record<Factor, number> = { ...w };
  const a = Math.min(1, Math.max(0, adventurous));
  // factor: (multiplier at Familiar, multiplier at Adventurous)
  const mult: Partial<Record<Factor, [number, number]>> = {
    audio: [1.3, 1.0],
    artist: [1.3, 0.7],
    provider: [1.2, 1.0],
    novelty: [0.3, 2.5],
  };
  for (const [key, [near, far]] of Object.entries(mult) as [Factor, [number, number]][]) d[key] *= blend(near, far, a);
  if (fresh) d.freshness *= 5.0;
  return d;
}

export interface Context {
  seeds: Track[];
  vectors: Map<string, Float64Array>; // recording key -> vector (float64, as in Python; one model/preprocess id only)
  relatedArtists: Map<string, Set<string>>; // seed key -> folded related artist names (when fetched)
  feedback: FeedbackView;
  impressions: Record<string, number>;
  settings: Settings;
  now: Date;
  cfg?: EngineConfig;
  /** Listening taste from real playback. Absent (the golden parity path) means it is not scored. */
  taste?: TasteProfile | null;
  /**
   * Ranking v2 (the improved scorer). Absent or false keeps the exact v1/Python-parity behaviour;
   * every v2 change below is gated on this so the golden fixtures stay byte-stable.
   */
  rankV2?: boolean;
  /** Long/recent/session taste blend (v2 only); when present it replaces `taste` in scoring. */
  taste2?: TasteBlend | null;
}

export function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

export function seedFactors(c: Track, s: Track, ctx: Context): Record<string, number | null> {
  const v2 = Boolean(ctx.rankV2);
  const f: Record<string, number | null> = {};
  const va = ctx.vectors.get(c.key), vb = ctx.vectors.get(s.key);
  f.audio = va && vb ? calibrateAudio(dot(va, vb)) : null;
  // v2: a tag the seed itself donated (inferFromSeed) is not independent evidence of fitting that
  // seed, and a tag voted in by audio neighbours correlates with the audio factor when both exist.
  const cTags = v2
    ? (c.tags ?? []).filter((t) => !(t.inferred && (t.source === SEED_GUESS_SOURCE || (f.audio !== null && t.source === SOUND_GUESS_SOURCE))))
    : (c.tags ?? []);
  f.genre = G.similarity(s.tags ?? [], cTags);
  const shared = [...artistSet(c)].some((x) => artistSet(s).has(x));
  const rel = ctx.relatedArtists.get(s.key);
  if (shared) f.artist = 1.0;
  else if (rel !== undefined) f.artist = [...artistSet(c)].some((x) => rel.has(x)) ? 0.7 : 0.0;
  else f.artist = null;
  let best: number | null = null;
  let bestRelation: string | null = null;
  const families = new Set<string>();
  let anyCounting = false;
  for (const p of c.provenance ?? []) {
    if (p.seed !== s.key) continue;
    const [strength, , counts] = RELATION[p.relation] ?? [0.0, '', false];
    if (!counts) continue;
    anyCounting = true;
    if (typeof p.source === 'string' && p.source) families.add(p.source.split('-')[0]!);
    const v = strength * (1.0 / (1.0 + 0.03 * Math.max(0, p.rank ?? 0)));
    if (best === null || v > best) {
      best = v;
      bestRelation = p.relation;
    }
  }
  if (v2) {
    // Null stays null unless a relatedness list was actually consulted for this seed: a candidate
    // whose only link is a non-counting relation (catalogue search, genre chart) was never "asked
    // about", so its absence from nothing is not negative evidence.
    const asked = anyCounting || Boolean(ctx.relatedArtists.get(s.key)?.size);
    if (best !== null) {
      // Bounded corroboration: each extra *distinct provider family* that independently lists the
      // song adds a little. Duplicate rows from one family never stack (the set).
      best = Math.min(1, best + 0.08 * Math.max(0, families.size - 1));
      // The same fact counted twice: "another song by the seed's artist" already scores artist=1.0.
      if (bestRelation === 'seed_artist_top' && shared) best *= 0.5;
    }
    f.provider = best !== null ? best : asked ? 0.0 : null;
  } else {
    // This seed's providers were asked; not being in their lists is weak negative evidence.
    const asked = (c.provenance ?? []).some((p) => p.seed === s.key) || Boolean(ctx.relatedArtists.get(s.key)?.size);
    f.provider = best !== null ? best : asked ? 0.0 : null;
  }
  f.tempo = tempoFit(c.bpm, s.bpm);
  return f;
}

export function scoreOne(c: Track, ctx: Context): Scored {
  const cfg = ctx.cfg ?? DEFAULT_ENGINE;
  const w = modeWeights(cfg.weights, ctx.settings.adventurous, ctx.settings.fresh);
  const perSeed: Record<string, number> = {};
  const perSeedFactors: Record<string, Record<string, number | null>> = {};
  const perSeedWsum: Record<string, number> = {};
  const perSeedWs: Record<string, Record<string, number>> = {};
  for (const s of ctx.seeds) {
    const f = seedFactors(c, s, ctx);
    const ws: Record<string, number> = {};
    for (const k of SEED_FACTORS) {
      const v = f[k];
      if (v !== null && v !== undefined && w[k] > 0) ws[k] = w[k];
    }
    if ('genre' in ws && 'provider' in ws && (f.provider ?? 0) > 0) ws.genre! *= 1.0 - cfg.genreProviderOverlap;
    const total = Object.values(ws).reduce((x, y) => x + y, 0);
    perSeedFactors[s.key] = f;
    perSeedWsum[s.key] = total;
    perSeedWs[s.key] = ws;
    if (total > 0) {
      let num = 0;
      for (const k of Object.keys(ws)) num += ws[k]! * Math.min(1, Math.max(0, f[k]!));
      perSeed[s.key] = num / total;
    }
  }
  let bestKey: string | null = null;
  for (const k of Object.keys(perSeed)) {
    if (bestKey === null) bestKey = k;
    else {
      const a = perSeed[k]!, b = perSeed[bestKey]!;
      const wa = perSeedWsum[k]!, wb = perSeedWsum[bestKey]!;
      if (a > b || (a === b && (wa > wb || (wa === wb && k > bestKey)))) bestKey = k;
    }
  }
  let blendVal = 0, seedW = 0;
  if (bestKey !== null) {
    const seedKeys = Object.keys(perSeed);
    const emph: Record<string, number> = {};
    for (const s of ctx.seeds) if (s.key in perSeed) emph[s.key] = Math.max(0.1, Number(s.emphasis ?? 1.0));
    let emphSum = 0, mean = 0;
    for (const k of seedKeys) {
      mean += perSeed[k]! * emph[k]!;
      emphSum += emph[k]!;
    }
    mean /= emphSum;
    blendVal = cfg.bestSeedShare * perSeed[bestKey]! + (1 - cfg.bestSeedShare) * mean;
    seedW = perSeedWsum[bestKey]!;
  }
  const g: Record<string, number | null> = {
    feedback: feedbackFit(c, ctx.feedback),
    freshness: freshness(c.release, ctx.now),
    novelty: null,
  };
  const seedArtists = new Set<string>();
  for (const s of ctx.seeds) for (const a of artistSet(s)) seedArtists.add(a);
  const relatedAll = new Set<string>();
  for (const set of ctx.relatedArtists.values()) for (const a of set) relatedAll.add(a);
  const ca = artistSet(c);
  const inSeeds = [...ca].some((a) => seedArtists.has(a));
  const inRelated = [...ca].some((a) => relatedAll.has(a));
  if (inSeeds) g.novelty = 0.0;
  else if (inRelated) g.novelty = 0.5; // liking an artist is rewarded by feedback; it must not also cost novelty
  else g.novelty = 1.0;
  let num = blendVal * seedW;
  let den = seedW;
  const used: Record<string, number> = {};
  for (const k of GLOBAL_FACTORS) {
    const gv = g[k];
    if (gv !== null && gv !== undefined && w[k] > 0) {
      num += w[k] * Math.min(1, Math.max(0, gv));
      den += w[k];
      used[k] = w[k];
    }
  }
  let affinity = den > 0 ? num / den : 0.0;
  // Listening taste blends in only when the caller passes it; without it the score is unchanged.
  // v2 passes a long/recent/session blend whose weight grows with evidence (confidence-aware).
  if (ctx.rankV2 && ctx.taste2) {
    const tf2 = tasteFit2(c, ctx.taste2);
    if (tf2) {
      g.taste = tf2.value;
      affinity = affinity * (1 - tf2.weight) + tf2.weight * tf2.value;
    }
  } else {
    const tf = ctx.taste ? tasteFit(c, ctx.taste) : null;
    if (tf) {
      g.taste = tf.value;
      affinity = affinity * (1 - TASTE_WEIGHT) + TASTE_WEIGHT * tf.value;
    }
  }
  // coverage over affinity factors (seed factors of the best seed + feedback when present)
  // v2: when no seed in the run has a vector, nothing can have audio evidence, so audio is not
  // "missing" — it is impossible, and it leaves the denominator instead of flattening everyone.
  let allAff = AFFINITY_FACTORS.reduce((x, k) => x + w[k], 0);
  if (ctx.rankV2) {
    const anySeedVector = ctx.seeds.some((s) => ctx.vectors.has(s.key));
    if (!anySeedVector) allAff -= w.audio;
  }
  const have = seedW + (g.feedback !== null && g.feedback !== undefined ? w.feedback : 0.0);
  const coverage = allAff ? Math.min(1, have / allAff) : 0.0;
  const final = affinity * (cfg.coverageFloor + (1 - cfg.coverageFloor) * coverage);
  const factors: Record<string, number | null> = bestKey ? { ...perSeedFactors[bestKey] } : {};
  Object.assign(factors, g);
  let weightsUsed: Record<string, number>;
  if (bestKey) {
    weightsUsed = { ...perSeedWs[bestKey] };
    Object.assign(weightsUsed, used);
  } else {
    weightsUsed = used;
  }
  const imp = ctx.impressions[c.key] ?? 0;
  const pen = Math.min(cfg.exposurePenaltyMax, cfg.exposurePenalty * imp);
  return {
    track: c,
    final,
    affinity,
    coverage,
    bestSeed: bestKey,
    perSeed,
    factors,
    weightsUsed,
    tier: 'related',
    exposurePenalty: pen,
    reasons: [],
    uncertainty: [],
    newRelease: isNewRelease(c.release, ctx.now, cfg.newReleaseDays),
  };
}

export function scoreAll(candidates: Track[], ctx: Context): Scored[] {
  const seedKeys = new Set(ctx.seeds.map((s) => s.key));
  const out: Scored[] = [];
  for (const c of candidates) {
    if (seedKeys.has(c.key) || ctx.feedback.excluded.has(c.key) || ctx.feedback.hidden.has(c.key)) continue;
    if (c.unavailable) continue;
    out.push(scoreOne(c, ctx));
  }
  out.sort((x, y) => y.final - x.final || (x.track.key < y.track.key ? -1 : x.track.key > y.track.key ? 1 : 0));
  assignTiers(out, ctx);
  for (const s of out) {
    const [reasons, uncertainty] = explain(s, ctx);
    s.reasons = reasons;
    s.uncertainty = uncertainty;
  }
  return out;
}

export function assignTiers(scored: Scored[], ctx: Context): void {
  if (!scored.length) return;
  const finals = scored.map((s) => s.final).sort((a, b) => b - a);
  const q = finals[Math.max(0, Math.floor(finals.length / 4) - 1)]!;
  for (const s of scored) {
    const rels = new Set((s.track.provenance ?? []).map((p) => p.relation));
    const exploration = rels.size > 0 && [...rels].every((r) => EXPLORATION_RELATIONS.has(r));
    if (exploration) s.tier = 'experimental';
    else if (s.final >= q && s.coverage >= 0.4) s.tier = 'strong';
    else if (s.factors.novelty === 1.0) s.tier = 'emerging';
    else s.tier = 'related';
    if (ctx.settings.fresh && s.newRelease && s.tier === 'experimental') s.tier = 'emerging';
  }
}

export function tierShares(adventurous: number, cfg: EngineConfig = DEFAULT_ENGINE): Record<string, number> {
  const t = cfg.tiers;
  const base = { strong: t.strong, related: t.related, emerging: t.emerging, experimental: t.experimental };
  const safe = { strong: 0.6, related: 0.3, emerging: 0.08, experimental: 0.02 };
  const bold = { strong: 0.2, related: 0.25, emerging: 0.3, experimental: 0.25 };
  const a = Math.min(1, Math.max(0, adventurous));
  const out: Record<string, number> = {};
  if (a <= 0.5) {
    const k = a / 0.5;
    for (const n of Object.keys(base) as (keyof typeof base)[]) out[n] = safe[n] + (base[n] - safe[n]) * k;
  } else {
    const k = (a - 0.5) / 0.5;
    for (const n of Object.keys(base) as (keyof typeof base)[]) out[n] = base[n] + (bold[n] - base[n]) * k;
  }
  return out;
}

function sim(a: Scored, b: Scored, vectors: Map<string, Float64Array>): number {
  const va = vectors.get(a.track.key), vb = vectors.get(b.track.key);
  if (va && vb) return Math.max(0, dot(va, vb));
  const ta = a.track.tags ?? [], tb = b.track.tags ?? [];
  if (ta.length && tb.length) return G.similarity(ta, tb) ?? 0.0;
  return 0.0;
}

/** Selection keeps soft tier quotas, at most maxPerArtist per artist, seed coverage and an MMR-style penalty. */
export function select(scored: Scored[], ctx: Context): Scored[] {
  const cfg = ctx.cfg ?? DEFAULT_ENGINE;
  const n = cfg.queueSize;
  const shares = tierShares(ctx.settings.adventurous, cfg);
  const pools: Record<string, Scored[]> = {};
  for (const k of Object.keys(shares)) pools[k] = [];
  for (const s of scored) pools[s.tier]?.push(s);
  for (const k of Object.keys(pools)) {
    pools[k]!.sort((x, y) => y.final - y.exposurePenalty - (x.final - x.exposurePenalty) || (x.track.key < y.track.key ? -1 : x.track.key > y.track.key ? 1 : 0));
  }
  const chosen: Scored[] = [];
  const perArtist: Record<string, number> = {};
  const perSeed: Record<string, number> = {};
  const seeds = ctx.seeds.map((s) => s.key);
  const emphOf = (s: Track) => Math.max(0.1, Number(s.emphasis ?? 1.0));
  const emphTotal = ctx.seeds.reduce((x, s) => x + emphOf(s), 0) || 1.0;
  const seedShare: Record<string, number> = {};
  for (const s of ctx.seeds) seedShare[s.key] = emphOf(s) / emphTotal;
  const filled: Record<string, number> = {};
  for (const k of Object.keys(shares)) filled[k] = 0;
  const lam = 0.06 + 0.06 * Math.min(1.0, 2 * ctx.settings.adventurous);
  while (chosen.length < n) {
    // tier with the largest deficit that still has an eligible item
    const order = Object.keys(shares).sort((a, b) => {
      const da = -(shares[a]! * (chosen.length + 1) - filled[a]!);
      const db = -(shares[b]! * (chosen.length + 1) - filled[b]!);
      return da - db || (a < b ? -1 : a > b ? 1 : 0);
    });
    let picked: [string, Scored] | null = null;
    for (const tier of order) {
      let best: Scored | null = null;
      let bestVal = -1e9;
      for (const s of pools[tier] ?? []) {
        const pa = primaryArtist(s.track);
        if ((perArtist[pa] ?? 0) >= cfg.maxPerArtist) continue;
        let val = s.final - s.exposurePenalty;
        if (chosen.length) {
          const recent = chosen.slice(-6);
          val -= lam * Math.max(...recent.map((r) => sim(s, r, ctx.vectors)));
        }
        if (s.bestSeed && seeds.length > 1) {
          const expected = (seedShare[s.bestSeed] ?? 0) * (chosen.length + 1);
          val += 0.06 * Math.max(-1.0, Math.min(1.0, expected - (perSeed[s.bestSeed] ?? 0)));
        }
        if (ctx.settings.fresh && s.newRelease) val += 0.15;
        if (val > bestVal || (val === bestVal && best !== null && s.track.key < best.track.key)) {
          best = s;
          bestVal = val;
        }
      }
      if (best !== null) {
        picked = [tier, best];
        break;
      }
    }
    if (picked === null) break;
    const [tier, s] = picked;
    pools[tier] = (pools[tier] ?? []).filter((x) => x !== s);
    chosen.push(s);
    filled[tier] = (filled[tier] ?? 0) + 1;
    const pa = primaryArtist(s.track);
    perArtist[pa] = (perArtist[pa] ?? 0) + 1;
    if (s.bestSeed) perSeed[s.bestSeed] = (perSeed[s.bestSeed] ?? 0) + 1;
  }
  return chosen;
}

// ---------------------------------------------------------------------------------------------
// explanations (only from factors that actually had evidence)
// ---------------------------------------------------------------------------------------------
function seedTitle(ctx: Context, key: string | null): string {
  for (const s of ctx.seeds) if (s.key === key) return `“${s.title}”`;
  return 'your starting songs';
}

export function explain(s: Scored, ctx: Context): [Reason[], string[]] {
  const reasons: Reason[] = [];
  const f = s.factors;
  const seed = seedTitle(ctx, s.bestSeed);
  const t = s.track;
  const contrib: Record<string, number> = {};
  for (const k of Object.keys(s.weightsUsed)) contrib[k] = (s.weightsUsed[k] ?? 0) * (f[k] ?? 0);
  if (f.taste !== null && f.taste !== undefined && f.taste >= 0.6 && ctx.taste) {
    const tf = tasteFit(t, ctx.taste);
    const g = tf?.genre;
    const what = g && (tf?.genrePart ?? 0) > 0.2 ? `${g.label} songs you have finished` : 'the tempo of songs you keep playing';
    reasons.push({ factor: 'taste', text: `Fits your listening: ${what}${t.bpm ? ` (${Math.round(t.bpm)} BPM)` : ''}.`, weight: 0.001 });
  } else if (f.taste !== null && f.taste !== undefined && f.taste <= 0.4 && ctx.taste) {
    reasons.push({ factor: 'taste', text: 'Your skips lean away from this kind of song, so it is here on other evidence.', weight: 0 });
  }
  const provs = (t.provenance ?? []).filter((p) => p.seed === s.bestSeed);
  provs.sort((a, b) => -(RELATION[a.relation]?.[0] ?? 0) + (RELATION[b.relation]?.[0] ?? 0));
  if (provs.length && (f.provider ?? 0) > 0) {
    const label = RELATION[provs[0]!.relation]![1];
    const extra = provs[0]!.via ? ` (${provs[0]!.via})` : '';
    // v2: name the independent families that corroborated it — only when more than one really did.
    const fams = ctx.rankV2 ? new Set(provs.filter((p) => RELATION[p.relation]?.[2] && p.source).map((p) => p.source!.split('-')[0]!)) : new Set<string>();
    const corro = fams.size > 1 ? ` ${fams.size} services list it independently.` : '';
    reasons.push({ factor: 'provider', text: `${label} ${seed}${extra}.${corro}`, weight: contrib.provider ?? 0 });
  }
  if (f.audio !== null && f.audio !== undefined && f.audio >= 0.55) {
    reasons.push({ factor: 'audio', text: `Sounds close to ${seed}: timbre and production compared on 30-second previews (audio model).`, weight: contrib.audio ?? 0 });
  } else if (f.audio !== null && f.audio !== undefined && f.audio < 0.25) {
    reasons.push({ factor: 'audio', text: `Sounds quite different from ${seed} on the previews; it is here on other evidence.`, weight: 0 });
  }
  if (f.genre && f.genre >= 0.5) {
    const seedObj = ctx.seeds.find((x) => x.key === s.bestSeed);
    const st = new Set((seedObj?.tags ?? []).map((g) => g.name));
    const shared = (t.tags ?? []).filter((g) => st.has(g.name));
    const g = shared[0] ?? (t.tags ?? [])[0];
    if (g) {
      reasons.push({
        factor: 'genre',
        text: `${shared.length ? 'Shares' : 'Close to'} ${g.label} with ${seed} (${g.source.toLowerCase()}, ${g.scope} level).`,
        weight: contrib.genre ?? 0,
      });
    }
  }
  if (f.artist === 1.0) reasons.push({ factor: 'artist', text: `Same artist as ${seed}.`, weight: contrib.artist ?? 0 });
  else if (f.artist === 0.7) reasons.push({ factor: 'artist', text: `By an artist the providers list as related to ${seed}.`, weight: contrib.artist ?? 0 });
  if (f.tempo !== null && f.tempo !== undefined && f.tempo >= 0.6 && t.bpm) {
    const sb = ctx.seeds.find((x) => x.key === s.bestSeed)?.bpm;
    if (sb) reasons.push({ factor: 'tempo', text: `Similar tempo: ${Math.round(t.bpm)} vs ${Math.round(sb)} BPM (Deezer).`, weight: contrib.tempo ?? 0 });
  }
  if (f.feedback !== null && f.feedback !== undefined) {
    const txt = f.feedback > 0.55 ? 'You liked songs by this artist.' : 'Your earlier feedback lowered it.';
    reasons.push({ factor: 'feedback', text: txt, weight: contrib.feedback ?? 0 });
  }
  const rel = t.release;
  if (s.newRelease) reasons.push({ factor: 'freshness', text: `New release: ${rel!.date} (${rel!.source}).`, weight: contrib.freshness ?? 0 });
  if (f.novelty === 1.0 && ctx.settings.adventurous > 0.5) {
    reasons.push({ factor: 'novelty', text: 'An artist that is new to your starting songs.', weight: contrib.novelty ?? 0 });
  }
  const explore = (t.provenance ?? []).find((p) => EXPLORATION_RELATIONS.has(p.relation));
  if (explore && !reasons.some((r) => r.factor === 'provider' || r.factor === 'audio' || r.factor === 'artist')) {
    const g = explore.via;
    reasons.push({
      factor: 'exploration',
      text: `An exploration pick from Deezer's ${g ? g + ' ' : 'genre '}chart, a genre Deezer gives ${seed}.`,
      weight: 0.001,
    });
  }
  // Evidence first; "new artist" and freshness describe the pick rather than why it fits.
  const several = reasons.length > 1;
  reasons.sort((a, b) => {
    const ka = (several && (a.factor === 'novelty' || a.factor === 'freshness') ? 1 : 0) as number;
    const kb = (several && (b.factor === 'novelty' || b.factor === 'freshness') ? 1 : 0) as number;
    return ka - kb || b.weight - a.weight;
  });
  const unc: string[] = [];
  if (rel && rel.kind === 'upload') unc.push(`Date shown is the upload date (${rel.date}), not a release date.`);
  if (rel && rel.precision === 'year') unc.push(`Only the release year (${rel.date}) is known.`);
  if (t.artist_from_url) unc.push('Artist name comes from the uploader\'s address on SoundCloud.');
  if (s.coverage < 0.4) unc.push('Little evidence about this one; it is a looser suggestion.');
  if (f.audio === null || f.audio === undefined) {
    unc.push('No audio comparison: no legitimately available preview for it, or it was not analysed in this request.');
  }
  return [reasons, unc];
}

export function recommend(candidates: Track[], ctx: Context): Scored[] {
  return select(scoreAll(candidates, ctx), ctx);
}

export function withSettings(ctx: Context, patch: Partial<Settings>): Context {
  return { ...ctx, settings: normaliseSettings({ ...ctx.settings, ...patch }) };
}
