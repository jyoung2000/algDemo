/**
 * ALGO-MANAGER-001. Recommendation algorithms: one built-in, read-only "jPlay default" derived
 * from DEFAULT_ENGINE, plus the listener's own copies. This module is the single source of truth
 * for the parameters, the readable six-line formula, validation, import/export and the mapping onto
 * the engine's EngineConfig. Pure: no store, no network, no DOM.
 */
import { DEFAULT_ENGINE, FRESH_WEIGHT_MULTIPLIER, MODE_MULTIPLIERS, validateWeights, type EngineConfig, type Factor, type Weights } from './config';
import { TASTE_WEIGHT } from './taste';
import { TASTE2_MAX_WEIGHT } from './taste2';
import { compileRankingFormula, DEFAULT_RANKING_FORMULA, MAX_FORMULA_LENGTH, parseRankingFormula } from './ranking-formula';
import { exportFavs, importFavs, type FavArtist } from './fav-artists';

export const SEED_WEIGHT_KEYS = ['audio', 'genre', 'artist', 'provider', 'feedback', 'tempo'] as const;
export const GLOBAL_WEIGHT_KEYS = ['feedback', 'freshness', 'novelty'] as const;
export type SeedWeightKey = (typeof SEED_WEIGHT_KEYS)[number];
export type GlobalWeightKey = (typeof GLOBAL_WEIGHT_KEYS)[number];

export interface AlgorithmParams {
  seedWeights: Record<SeedWeightKey, number>;
  bestSeedShare: number;
  globalWeights: Record<GlobalWeightKey, number>;
  tasteWeight: number;
  coverageFloor: number;
  exposurePerShow: number;
  exposureMax: number;
}

export interface Algorithm {
  id: string;
  name: string;
  builtIn?: true;
  params: AlgorithmParams;
  /** The final step, in the ranking-formula expression language (engine/ranking-formula.ts). */
  finalFormula: string;
}

/** What Settings stores: only user-made algorithms, plus the id of the active one. */
export interface AlgorithmSettings {
  algorithms?: Algorithm[];
  active_algorithm?: string;
}

export const BUILT_IN_ID = 'airwave-default';
export const BUILT_IN_NAME = 'jPlay default';
/** Id and name a legacy `weights` / `ranking_formula` setting migrates into (deterministic, so re-reading is idempotent). */
export const MIGRATED_ID = 'my-formula';
export const MIGRATED_NAME = 'My formula';
export const MAX_USER_ALGORITHMS = 50;
export const MAX_NAME_LENGTH = 60;
export const MAX_WEIGHT = 100;
/** An algorithm file, with up to 200 starred artists of its own (ARTIST-FAV-ALGO-001). */
export const MAX_IMPORT_CHARS = 65_536;
export const EXPORT_FORMAT = 'airwave-algorithm';
export const EXPORT_VERSION = 1;

/** The parameters an engine configuration already implies. */
export function paramsFromEngine(cfg: EngineConfig): AlgorithmParams {
  const w = cfg.weights;
  return {
    seedWeights: { audio: w.audio, genre: w.genre, artist: w.artist, provider: w.provider, feedback: cfg.seedFeedbackWeight ?? w.feedback, tempo: w.tempo },
    bestSeedShare: cfg.bestSeedShare,
    globalWeights: { feedback: w.feedback, freshness: w.freshness, novelty: w.novelty },
    tasteWeight: cfg.tasteWeight,
    coverageFloor: cfg.coverageFloor,
    exposurePerShow: cfg.exposurePenalty,
    exposureMax: cfg.exposurePenaltyMax,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const BUILT_IN_ALGORITHM: Algorithm = deepFreeze({
  id: BUILT_IN_ID,
  name: BUILT_IN_NAME,
  builtIn: true as const,
  params: paramsFromEngine(DEFAULT_ENGINE),
  finalFormula: DEFAULT_RANKING_FORMULA,
});

export function cloneParams(p: AlgorithmParams): AlgorithmParams {
  return { ...p, seedWeights: { ...p.seedWeights }, globalWeights: { ...p.globalWeights } };
}

// ---- parameter catalogue (labels and plain-English meaning, used by the UI and validation) ----

export interface ParamField {
  path: string;
  label: string;
  meaning: string;
  kind: 'weight' | 'share';
}

export const PARAM_FIELDS: ParamField[] = [
  { path: 'seedWeights.audio', label: 'Sound (seed fit)', meaning: 'How much a close-sounding preview counts when matching a starting song.', kind: 'weight' },
  { path: 'seedWeights.genre', label: 'Genre (seed fit)', meaning: 'How much shared genres with a starting song count.', kind: 'weight' },
  { path: 'seedWeights.artist', label: 'Artist (seed fit)', meaning: 'How much the same or a related artist counts.', kind: 'weight' },
  { path: 'seedWeights.provider', label: 'Services (seed fit)', meaning: 'How much the music services ranking it as related counts.', kind: 'weight' },
  { path: 'seedWeights.feedback', label: 'Your feedback (seed fit)', meaning: 'How much known feedback adds to the evidence coverage of a match.', kind: 'weight' },
  { path: 'seedWeights.tempo', label: 'Tempo (seed fit)', meaning: 'How much a BPM close to a starting song counts.', kind: 'weight' },
  { path: 'bestSeedShare', label: 'Best starting song share', meaning: 'Share of the blend taken from the single best-matching starting song; the rest is the mean over all of them.', kind: 'share' },
  { path: 'globalWeights.feedback', label: 'Your feedback (global)', meaning: 'How much likes, full listens, skips and dislikes move the score.', kind: 'weight' },
  { path: 'globalWeights.freshness', label: 'New (global)', meaning: 'How much a recent release date raises the score.', kind: 'weight' },
  { path: 'globalWeights.novelty', label: 'Discovery (global)', meaning: 'How much an artist not already in your starting songs raises the score.', kind: 'weight' },
  { path: 'tasteWeight', label: 'Listening taste', meaning: 'Share of the score taken from the genres and tempo you finish or skip. Improved ranking (v2) scales its evidence-based share by the same factor.', kind: 'share' },
  { path: 'coverageFloor', label: 'Coverage floor', meaning: 'Share of the score a song keeps when it has little evidence.', kind: 'share' },
  { path: 'exposurePerShow', label: 'Repeat penalty per show', meaning: 'Subtracted for every time the song was already shown recently.', kind: 'share' },
  { path: 'exposureMax', label: 'Largest repeat penalty', meaning: 'The repeat penalty never goes above this.', kind: 'share' },
];

export function getParam(p: AlgorithmParams, path: string): number {
  const [a, b] = path.split('.') as [string, string | undefined];
  const v = (p as unknown as Record<string, unknown>)[a];
  return (b === undefined ? v : (v as Record<string, unknown>)[b]) as number;
}

export function setParam(p: AlgorithmParams, path: string, value: number): AlgorithmParams {
  const next = cloneParams(p);
  const [a, b] = path.split('.') as [string, string | undefined];
  if (b === undefined) (next as unknown as Record<string, number>)[a] = value;
  else (next as unknown as Record<string, Record<string, number>>)[a]![b] = value;
  return next;
}

// ---- formatting ------------------------------------------------------------------------------

const num = (x: number): string => String(Number(x.toFixed(4)));
/** At least two decimals, as the owner's formula writes the complement share ("0.30"). */
const num2 = (x: number): string => {
  const s = num(x);
  const dot = s.indexOf('.');
  if (dot < 0) return `${s}.00`;
  return s.length - dot - 1 < 2 ? `${s}0` : s;
};

/** The algorithm as one readable line per step, with its own numbers. The only formula formatter. */
export function formulaLines(alg: Pick<Algorithm, 'params' | 'finalFormula'>): string[] {
  const p = alg.params;
  const seed = SEED_WEIGHT_KEYS.map((k) => `${num(p.seedWeights[k])}·${k}`).join(' + ');
  const glob = GLOBAL_WEIGHT_KEYS.map((k) => `${num(p.globalWeights[k])}·${k}`).join(' + ');
  const t = num(p.tasteWeight);
  const floor = num(p.coverageFloor);
  const custom = (alg.finalFormula ?? '').trim();
  const final = !custom || custom === DEFAULT_RANKING_FORMULA
    ? `final = affinity′ × (${floor} + (1 − ${floor}) × coverage)`
    : `final = ${custom} (custom final step; affinity means affinity′, coverage_floor = ${floor})`;
  return [
    `seed fit = Σ w·factor / Σ w over [${seed}] (only factors with evidence)`,
    `blend = ${num(p.bestSeedShare)}·seed fit(best seed) + ${num2(1 - p.bestSeedShare)}·emphasis-weighted mean of seed fits`,
    `affinity = (blend·seedWeight + Σ w·global over [${glob}]) / (seedWeight + Σ w)`,
    `affinity′ = affinity × (1 − ${t}) + ${t} × taste`,
    final,
    `ranked = final − min(${num(p.exposureMax)}, ${num(p.exposurePerShow)} × shows)`,
  ];
}

export const formulaText = (alg: Pick<Algorithm, 'params' | 'finalFormula'>): string => formulaLines(alg).join('\n');

/**
 * FORMULA-NOTES-001. What the scorer does that the six lines do not show, with this algorithm's own numbers.
 * Every sentence was checked against engine.ts (scoreOne, modeWeights, select) in the 2026-11-18 formula audit;
 * the slider multipliers, the genre overlap, the taste ceiling and the artist limit are read from the same
 * constants the scorer uses.
 */
export function formulaNotes(alg: Pick<Algorithm, 'params' | 'finalFormula'>, base: EngineConfig = DEFAULT_ENGINE): string[] {
  const p = alg.params;
  const fb = num(p.seedWeights.feedback);
  const all = num(SEED_WEIGHT_KEYS.reduce((s, k) => s + p.seedWeights[k], 0));
  const side = (i: 0 | 1) => (Object.entries(MODE_MULTIPLIERS) as [Factor, readonly [number, number]][])
    .filter(([, m]) => m[i] !== 1).map(([k, m]) => `${k} ×${num(m[i])}`).join(', ');
  const t = num(p.tasteWeight);
  const tMax = num(Math.min(1, TASTE2_MAX_WEIGHT * (p.tasteWeight / TASTE_WEIGHT)));
  return [
    `Feedback is not averaged into seed fit. Its ${fb} there counts towards coverage only: coverage = (weights of what is known about the best starting song, + ${fb} when you gave feedback on the song, its artist or its album) / ${all}. With improved ranking on, sound is left out of both when no starting song has been analysed.`,
    `Genre counts ${base.genreProviderOverlap === 0.5 ? 'half' : `×${num(1 - base.genreProviderOverlap)}`} (${num(p.seedWeights.genre * (1 - base.genreProviderOverlap))}) when the music services also relate the song to that starting song, so one fact is not counted twice. With improved ranking on, the other part is left out of coverage too, so a song with every kind of evidence is fully covered.`,
    `The weights are for the middle of the Familiar–Adventurous slider. Familiar: ${side(0)}. Adventurous: ${side(1)}. “Prefer new releases”: freshness ×${num(FRESH_WEIGHT_MULTIPLIER)}.`,
    `Listening taste: with improved ranking on (the default) its share is not a fixed ${t}; it grows with your listening history from 0 up to ${tMax}. With improved ranking off it is ${t}. Without listening history there is no taste step.`,
    `The queue is then picked from the ranked songs: a share for close, related, new-artist and exploratory picks, at most ${base.maxPerArtist} songs per artist, less of what resembles the last few picks, a fair turn for each starting song, and a lift for new releases when that switch is on.`,
  ];
}

// ---- validation --------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strictKeys(where: string, v: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) errors.push(`${where} has an unknown field “${k}”.`);
}

function fieldLabel(path: string): string {
  return PARAM_FIELDS.find((f) => f.path === path)?.label ?? path;
}

function checkNumber(path: string, v: unknown, max: number, errors: string[]): void {
  const label = fieldLabel(path);
  if (typeof v !== 'number' || Number.isNaN(v)) errors.push(`${label} must be a number.`);
  else if (!Number.isFinite(v)) errors.push(`${label} must be a finite number.`);
  else if (v < 0 || v > max) errors.push(max === 1 ? `${label} must be between 0 and 1.` : `${label} must be 0 or more (at most ${max}).`);
}

/** Every problem with the parameters, in plain English; empty when they are valid. */
export function paramErrors(params: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(params)) return ['The parameters are missing.'];
  strictKeys('The parameters', params, ['seedWeights', 'bestSeedShare', 'globalWeights', 'tasteWeight', 'coverageFloor', 'exposurePerShow', 'exposureMax'], errors);
  const sw = params['seedWeights'];
  if (!isObj(sw)) errors.push('Seed-fit weights are missing.');
  else {
    strictKeys('Seed-fit weights', sw, SEED_WEIGHT_KEYS, errors);
    for (const k of SEED_WEIGHT_KEYS) checkNumber(`seedWeights.${k}`, sw[k], MAX_WEIGHT, errors);
    if (!errors.length && !SEED_WEIGHT_KEYS.some((k) => (sw[k] as number) > 0)) errors.push('At least one seed-fit weight must be above 0.');
  }
  const gw = params['globalWeights'];
  if (!isObj(gw)) errors.push('Global weights are missing.');
  else {
    strictKeys('Global weights', gw, GLOBAL_WEIGHT_KEYS, errors);
    for (const k of GLOBAL_WEIGHT_KEYS) checkNumber(`globalWeights.${k}`, gw[k], MAX_WEIGHT, errors);
  }
  for (const k of ['bestSeedShare', 'tasteWeight', 'coverageFloor', 'exposurePerShow', 'exposureMax']) checkNumber(k, params[k], 1, errors);
  // The feedback weight in seed fit only counts towards coverage (FORMULA-NOTES-001), so by itself it scores nothing:
  // with every other weight at 0 each song would score 0 and the queue would be in name order.
  if (!errors.length && isObj(sw) && isObj(gw)
    && !SEED_WEIGHT_KEYS.some((k) => k !== 'feedback' && (sw[k] as number) > 0) && !GLOBAL_WEIGHT_KEYS.some((k) => (gw[k] as number) > 0)) {
    errors.push('At least one seed fit or global weight must be above 0.');
  }
  return errors;
}

export function formulaError(source: unknown): string | null {
  if (typeof source !== 'string') return 'The final-step formula must be text.';
  if (source.length > MAX_FORMULA_LENGTH) return `The final-step formula is limited to ${MAX_FORMULA_LENGTH} characters.`;
  try { compileRankingFormula(source.trim() || DEFAULT_RANKING_FORMULA); return null; }
  catch (e) { return `Final-step formula: ${(e as Error).message}`; }
}

export function nameError(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'Give the algorithm a name.';
  if (name.trim().length > MAX_NAME_LENGTH) return `Algorithm names are limited to ${MAX_NAME_LENGTH} characters.`;
  return null;
}

/** Every problem with a whole algorithm, in plain English; empty when it is valid. */
export function algorithmErrors(value: unknown): string[] {
  if (!isObj(value)) return ['An algorithm must be an object.'];
  const errors: string[] = [];
  strictKeys('The algorithm', value, ['id', 'name', 'builtIn', 'params', 'finalFormula'], errors);
  if (typeof value['id'] !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value['id'])) errors.push('The algorithm id must be 1–64 letters, digits, dashes or underscores.');
  if ('builtIn' in value && value['builtIn'] !== true) errors.push('builtIn may only be true.');
  const n = nameError(value['name']); if (n) errors.push(n);
  errors.push(...paramErrors(value['params']));
  const f = formulaError(value['finalFormula']); if (f) errors.push(f);
  return errors;
}

/** Returns a normalised copy (trimmed name and formula) or throws one English message listing the problems. */
export function validateAlgorithm(value: unknown): Algorithm {
  const errors = algorithmErrors(value);
  if (errors.length) throw new Error(errors.join(' '));
  const v = value as Algorithm;
  const out: Algorithm = { id: v.id, name: v.name.trim(), params: cloneParams(v.params), finalFormula: v.finalFormula.trim() || DEFAULT_RANKING_FORMULA };
  if (v.builtIn) out.builtIn = true;
  return out;
}

// ---- engine mapping ------------------------------------------------------------------------------

/** The engine configuration this algorithm ranks with; everything it does not own comes from `base`. */
export function algorithmToEngine(alg: Algorithm, base: EngineConfig = DEFAULT_ENGINE): EngineConfig {
  const p = alg.params;
  const weights: Weights = {
    ...base.weights,
    audio: p.seedWeights.audio,
    genre: p.seedWeights.genre,
    artist: p.seedWeights.artist,
    provider: p.seedWeights.provider,
    tempo: p.seedWeights.tempo,
    feedback: p.globalWeights.feedback,
    freshness: p.globalWeights.freshness,
    novelty: p.globalWeights.novelty,
  };
  return {
    ...base,
    weights,
    seedFeedbackWeight: p.seedWeights.feedback,
    bestSeedShare: p.bestSeedShare,
    tasteWeight: p.tasteWeight,
    coverageFloor: p.coverageFloor,
    exposurePenalty: p.exposurePerShow,
    exposurePenaltyMax: p.exposureMax,
    // The default text maps to null: the engine's exact built-in path, not a re-evaluated copy.
    rankingFormula: parseRankingFormula(alg.finalFormula),
  };
}

// ---- creating, import and export ---------------------------------------------------------------

export function newAlgorithmId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = c?.randomUUID ? c.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `user-${raw.slice(0, 16)}`;
}

/** A new, editable user algorithm copying `alg`'s parameters and final step. */
export function createFrom(alg: Algorithm, name: string, id: string = newAlgorithmId()): Algorithm {
  const err = nameError(name);
  if (err) throw new Error(err);
  return validateAlgorithm({ id, name: name.trim(), params: cloneParams(alg.params), finalFormula: alg.finalFormula });
}

/** `base`, or `base 2`, `base 3`… so a new algorithm never shares a name with an existing one. */
export function uniqueName(base: string, existing: Algorithm[]): string {
  const names = new Set([BUILT_IN_NAME, ...existing.map((a) => a.name)].map((n) => n.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** The algorithm as a file; ARTIST-FAV-ALGO-001: with its own starred artists when given. */
export function serializeAlgorithm(alg: Algorithm, artists?: readonly FavArtist[]): string {
  const algorithm: Record<string, unknown> = { name: alg.name, params: alg.params, finalFormula: alg.finalFormula };
  if (artists) algorithm['artists'] = exportFavs(artists);
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, algorithm }, null, 2);
}

/** Reads an exported algorithm. Strict: unknown fields, other versions and oversized input are rejected. */
export function parseAlgorithm(text: unknown, id: string = newAlgorithmId()): Algorithm {
  return parseAlgorithmFile(text, id).algorithm;
}

/** An algorithm file and the starred artists it carries (none for a file from before ARTIST-FAV-ALGO-001). */
export function parseAlgorithmFile(text: unknown, id: string = newAlgorithmId()): { algorithm: Algorithm; artists: FavArtist[] } {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Paste algorithm JSON or choose a .json file.');
  if (text.length > MAX_IMPORT_CHARS) throw new Error(`This is too large to be an algorithm (${MAX_IMPORT_CHARS / 1024} KB maximum).`);
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('This is not valid JSON.'); }
  if (!isObj(data) || data['format'] !== EXPORT_FORMAT) throw new Error('This is not a jPlay algorithm file.');
  if (data['version'] !== EXPORT_VERSION) throw new Error(`Unsupported algorithm file version ${JSON.stringify(data['version'])}; this app reads version ${EXPORT_VERSION}.`);
  const errors: string[] = [];
  strictKeys('The file', data, ['format', 'version', 'algorithm'], errors);
  const a = data['algorithm'];
  if (!isObj(a)) errors.push('The file has no algorithm.');
  else strictKeys('The algorithm', a, ['name', 'params', 'finalFormula', 'artists'], errors);
  if (errors.length) throw new Error(errors.join(' '));
  const alg = a as Record<string, unknown>;
  const algorithm = validateAlgorithm({ id, name: alg['name'], params: alg['params'], finalFormula: alg['finalFormula'] });
  return { algorithm, artists: importFavs(alg['artists']) };
}

// ---- settings: storage, migration and the active algorithm ---------------------------------------

type Dict = Record<string, unknown>;

/** Strict check of a stored/PUT list: user-made only, unique ids, bounded size. */
export function validateAlgorithmList(value: unknown): Algorithm[] {
  if (!Array.isArray(value)) throw new Error('The algorithms setting must be a list.');
  if (value.length > MAX_USER_ALGORITHMS) throw new Error(`At most ${MAX_USER_ALGORITHMS} algorithms can be saved.`);
  const seen = new Set<string>();
  return value.map((v) => {
    const alg = validateAlgorithm(v);
    if (alg.builtIn || alg.id === BUILT_IN_ID) throw new Error(`“${BUILT_IN_NAME}” is built in and cannot be saved as your own algorithm.`);
    if (seen.has(alg.id)) throw new Error(`Two algorithms share the id “${alg.id}”.`);
    seen.add(alg.id);
    return alg;
  });
}

function hasLegacy(s: Dict): boolean {
  const w = s['weights'];
  const f = s['ranking_formula'];
  return (isObj(w) && Object.keys(w).length > 0) || (typeof f === 'string' && f.trim() !== '' && f.trim() !== DEFAULT_RANKING_FORMULA);
}

/** The user algorithm a legacy `weights` / `ranking_formula` setting stands for, or null when there is none. */
export function legacyAlgorithm(s: Dict): Algorithm | null {
  if (!hasLegacy(s)) return null;
  let params = cloneParams(BUILT_IN_ALGORITHM.params);
  const w = s['weights'];
  if (isObj(w) && Object.keys(w).length) {
    try {
      const merged = { ...DEFAULT_ENGINE.weights } as Weights;
      for (const k of Object.keys(merged) as Factor[]) if (k in w) merged[k] = Number(w[k]);
      params = paramsFromEngine({ ...DEFAULT_ENGINE, weights: validateWeights(merged) });
    } catch { /* an invalid legacy value never ranked; keep the built-in weights */ }
  }
  let finalFormula = DEFAULT_RANKING_FORMULA;
  try { finalFormula = parseRankingFormula(s['ranking_formula'] ?? null) ?? DEFAULT_RANKING_FORMULA; } catch { /* as above */ }
  return { id: MIGRATED_ID, name: MIGRATED_NAME, params, finalFormula };
}

/**
 * Settings as stored -> settings with `algorithms` (valid user algorithms) and `active_algorithm`.
 * A legacy `weights` / `ranking_formula` (from before algorithms existed) becomes the active user
 * algorithm "My formula" once, so nobody's ranking silently changes; the legacy keys are dropped.
 * Tolerant: invalid stored entries are skipped and an unknown active id falls back to the built-in.
 */
export function migrateAlgorithmSettings(stored: Dict): Dict {
  const s: Dict = { ...stored };
  let list: Algorithm[] = [];
  let active = typeof s['active_algorithm'] === 'string' ? (s['active_algorithm'] as string) : BUILT_IN_ID;
  if (Array.isArray(s['algorithms'])) {
    const seen = new Set<string>();
    for (const v of (s['algorithms'] as unknown[]).slice(0, MAX_USER_ALGORITHMS)) {
      if (algorithmErrors(v).length) continue;
      const alg = validateAlgorithm(v);
      if (alg.builtIn || alg.id === BUILT_IN_ID || seen.has(alg.id)) continue;
      seen.add(alg.id);
      list.push(alg);
    }
  } else {
    const legacy = legacyAlgorithm(s);
    if (legacy) { list = [legacy]; active = legacy.id; }
  }
  delete s['weights'];
  delete s['ranking_formula'];
  if (active !== BUILT_IN_ID && !list.some((a) => a.id === active)) active = BUILT_IN_ID;
  s['algorithms'] = list;
  s['active_algorithm'] = active;
  return s;
}

export function allAlgorithms(userAlgorithms: Algorithm[]): Algorithm[] {
  return [BUILT_IN_ALGORITHM, ...userAlgorithms];
}

export function findAlgorithm(userAlgorithms: Algorithm[], id: string | null | undefined): Algorithm {
  return userAlgorithms.find((a) => a.id === id) ?? BUILT_IN_ALGORITHM;
}

/** The active algorithm of a settings object (stored or already migrated). */
export function activeAlgorithm(settings: Dict): Algorithm {
  const s = migrateAlgorithmSettings(settings);
  return findAlgorithm(s['algorithms'] as Algorithm[], s['active_algorithm'] as string);
}

/** The EngineConfig the active algorithm ranks with. */
export function engineFromSettings(settings: Dict, base: EngineConfig = DEFAULT_ENGINE): EngineConfig {
  return algorithmToEngine(activeAlgorithm(settings), base);
}

/**
 * Applies the algorithm keys of a settings PUT to the current (migrated) settings and returns the new
 * `algorithms` / `active_algorithm`. Throws an English message on any invalid input so the caller can
 * reject the whole request. Legacy `weights` / `ranking_formula` writes go into the active user
 * algorithm; when the built-in is active, a copy named "My formula" is created and activated.
 */
export function applyAlgorithmPatch(cur: Dict, body: Dict, makeId: () => string = newAlgorithmId): { algorithms: Algorithm[]; active_algorithm: string } {
  const migrated = migrateAlgorithmSettings(cur);
  let list = migrated['algorithms'] as Algorithm[];
  let active = migrated['active_algorithm'] as string;
  if ('algorithms' in body) list = validateAlgorithmList(body['algorithms']);
  if ('active_algorithm' in body) {
    const id = body['active_algorithm'];
    if (typeof id !== 'string' || (id !== BUILT_IN_ID && !list.some((a) => a.id === id))) throw new Error('The active algorithm must be the built-in algorithm or one of your saved algorithms.');
    active = id;
  } else if (active !== BUILT_IN_ID && !list.some((a) => a.id === active)) active = BUILT_IN_ID;

  const editActive = (edit: (a: Algorithm) => Algorithm) => {
    if (active === BUILT_IN_ID) {
      const copy = createFrom(BUILT_IN_ALGORITHM, uniqueName(MIGRATED_NAME, list), makeId());
      list = [...list, copy];
      active = copy.id;
    }
    list = list.map((a) => (a.id === active ? validateAlgorithm(edit(a)) : a));
  };
  if ('weights' in body) {
    const w = body['weights'];
    if (w === null || (isObj(w) && Object.keys(w).length === 0)) {
      if (active !== BUILT_IN_ID) editActive((a) => ({ ...a, params: { ...a.params, seedWeights: { ...BUILT_IN_ALGORITHM.params.seedWeights }, globalWeights: { ...BUILT_IN_ALGORITHM.params.globalWeights } } }));
    } else {
      if (!isObj(w)) throw new Error('Weights must be an object of factor weights.');
      editActive((a) => {
        const cfg = algorithmToEngine(a);
        const merged = { ...cfg.weights };
        for (const k of Object.keys(merged) as Factor[]) if (k in w) merged[k] = Number(w[k]);
        const p = paramsFromEngine({ ...cfg, weights: validateWeights(merged) });
        // A legacy feedback weight sets both feedback roles, as it did before algorithms existed.
        if ('feedback' in w) p.seedWeights.feedback = p.globalWeights.feedback;
        return { ...a, params: p };
      });
    }
  }
  if ('ranking_formula' in body) {
    const src = parseRankingFormula(body['ranking_formula']);
    if (src !== null || active !== BUILT_IN_ID) editActive((a) => ({ ...a, finalFormula: src ?? DEFAULT_RANKING_FORMULA }));
  }
  return { algorithms: list, active_algorithm: active };
}

/** Settings as the API returns them: migrated, plus the read-only `ranking_formula` of the active algorithm. */
export function settingsWithAlgorithms(stored: Dict): Dict {
  const s = migrateAlgorithmSettings(stored);
  s['ranking_formula'] = parseRankingFormula(findAlgorithm(s['algorithms'] as Algorithm[], s['active_algorithm'] as string).finalFormula);
  return s;
}
