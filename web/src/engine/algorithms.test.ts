/** ALGO-MANAGER-001: the algorithm data model, its formula text, validation, import/export, migration and engine mapping. */
import { describe, expect, it } from 'vitest';
import * as E from './engine';
import * as G from './genres';
import { DEFAULT_ENGINE, engineWithWeights, type EngineConfig } from './config';
import { DEFAULT_RANKING_FORMULA } from './ranking-formula';
import { buildTaste } from './taste';
import { buildTasteBlend } from './taste2';
import {
  BUILT_IN_ALGORITHM, BUILT_IN_ID, MIGRATED_ID, PARAM_FIELDS, algorithmErrors, algorithmToEngine, applyAlgorithmPatch, createFrom,
  engineFromSettings, formulaLines, formulaNotes, migrateAlgorithmSettings, paramErrors, parseAlgorithm, serializeAlgorithm, setParam,
  settingsWithAlgorithms, validateAlgorithm, type Algorithm,
} from './algorithms';

const NOW = new Date(Date.UTC(2026, 9, 26));
const NOW_TS = NOW.getTime() / 1000;

function track(key: string, artist: string, o: { tags?: string[]; prov?: [string, string, number][]; bpm?: number; release?: string } = {}): E.Track {
  return {
    key, title: key, artists: [artist],
    tags: (o.tags ?? []).map((t) => G.makeTag(t, 'Deezer', 'album', 0.9)!),
    provenance: (o.prov ?? []).map(([seed, relation, rank]) => ({ seed, relation, rank })),
    release: o.release ? { date: o.release, precision: 'day' } : null,
    bpm: o.bpm ?? null,
  };
}

const seeds = [track('s1', 'Seed A', { tags: ['soul', 'funk'], bpm: 100 }), track('s2', 'Seed B', { tags: ['house'], bpm: 124 })];
const cands = [
  track('c1', 'Seed A', { tags: ['soul'], bpm: 98, prov: [['s1', 'radio', 1]] }),
  track('c2', 'Other', { tags: ['house'], bpm: 125, prov: [['s2', 'related', 3]], release: '2026-10-01' }),
  track('c3', 'Liked', { tags: ['funk', 'disco'], bpm: 110, prov: [['s1', 'radio', 8]] }),
  track('c4', 'Skipped', { tags: ['metal'], bpm: 180 }),
  track('c5', 'New Face', { tags: ['soul', 'house'], bpm: 120, prov: [['s2', 'radio', 2], ['s1', 'radio', 5]] }),
];
const events: E.FeedbackEvent[] = [
  { event_id: 'e1', key: 'c3', kind: 'like', artist: 'liked', ts: NOW_TS - 3600 },
  { event_id: 'e2', key: 'c4', kind: 'skip', artist: 'skipped', ts: NOW_TS - 1800 },
  { event_id: 'e3', key: 'x9', kind: 'complete', artist: 'liked', ts: NOW_TS - 600 },
];
const tasteRows = [
  { key: 'c3', kind: 'complete', ts: NOW_TS - 3600, track: { tags: [G.makeTag('funk', 'Deezer', 'album', 0.9)], bpm: 110 } },
  { key: 'c4', kind: 'skip', ts: NOW_TS - 1800, track: { tags: [G.makeTag('metal', 'Deezer', 'album', 0.9)], bpm: 180 } },
];

function scores(cfg: EngineConfig, v2: boolean): Record<string, [number, number, number]> {
  const ctx: E.Context = {
    seeds, vectors: new Map(), relatedArtists: new Map(),
    feedback: v2 ? E.buildFeedback2(events, NOW_TS, cfg) : E.buildFeedback(events, NOW_TS, cfg),
    impressions: { c1: 2, c5: 9 }, settings: E.normaliseSettings({ adventurous: 0.5, fresh: false }), now: NOW, cfg,
    taste: buildTaste(tasteRows, NOW_TS), rankV2: v2, taste2: v2 ? buildTasteBlend(tasteRows, NOW_TS, null) : null,
  };
  return Object.fromEntries(E.scoreAll(cands, ctx).map((s) => [s.track.key, [s.final, s.exposurePenalty, s.coverage]]));
}

const user = (over: Partial<Algorithm> = {}): Algorithm => ({ ...createFrom(BUILT_IN_ALGORITHM, 'Mine', 'user-test'), ...over });

describe('built-in algorithm parity', () => {
  it('is derived from DEFAULT_ENGINE and prints the owner formula exactly', () => {
    expect(BUILT_IN_ALGORITHM).toMatchObject({ id: BUILT_IN_ID, name: 'jPlay default', builtIn: true, finalFormula: DEFAULT_RANKING_FORMULA });
    expect(BUILT_IN_ALGORITHM.params.seedWeights.audio).toBe(DEFAULT_ENGINE.weights.audio);
    expect(BUILT_IN_ALGORITHM.params.coverageFloor).toBe(DEFAULT_ENGINE.coverageFloor);
    expect(Object.isFrozen(BUILT_IN_ALGORITHM.params.seedWeights)).toBe(true);
    expect(formulaLines(BUILT_IN_ALGORITHM)).toEqual([
      'seed fit = Σ w·factor / Σ w over [0.35·audio + 0.15·genre + 0.15·artist + 0.1·provider + 0.1·feedback + 0.05·tempo] (only factors with evidence)',
      'blend = 0.7·seed fit(best seed) + 0.30·emphasis-weighted mean of seed fits',
      'affinity = (blend·seedWeight + Σ w·global over [0.1·feedback + 0.05·freshness + 0.05·novelty]) / (seedWeight + Σ w)',
      'affinity′ = affinity × (1 − 0.15) + 0.15 × taste',
      'final = affinity′ × (0.55 + (1 − 0.55) × coverage)',
      'ranked = final − min(0.16, 0.04 × shows)',
    ]);
  });

  // FORMULA-NOTES-001 (formula audit 2026-11-18): the six lines are the owner's wording and stay as they are. These
  // lines say, with the algorithm's own numbers, where the scorer does something the six lines do not show.
  it('says exactly how the scorer applies the numbers where the formula simplifies', () => {
    expect(formulaNotes(BUILT_IN_ALGORITHM)).toEqual([
      'Feedback is not averaged into seed fit. Its 0.1 there counts towards coverage only: coverage = (weights of what is known about the best starting song, + 0.1 when you gave feedback on the song, its artist or its album) / 0.9. With improved ranking on, sound is left out of both when no starting song has been analysed.',
      'Genre counts half (0.075) when the music services also relate the song to that starting song, so one fact is not counted twice. With improved ranking on, the other part is left out of coverage too, so a song with every kind of evidence is fully covered.',
      'The weights are for the middle of the Familiar–Adventurous slider. Familiar: audio ×1.3, artist ×1.3, provider ×1.2, novelty ×0.3. Adventurous: artist ×0.7, novelty ×2.5. “Prefer new releases”: freshness ×5.',
      'Listening taste: with improved ranking on (the default) its share is not a fixed 0.15; it grows with your listening history from 0 up to 0.25. With improved ranking off it is 0.15. Without listening history there is no taste step.',
      'The queue is then picked from the ranked songs: a share for close, related, new-artist and exploratory picks, at most 2 songs per artist, less of what resembles the last few picks, a fair turn for each starting song, and a lift for new releases when that switch is on.',
    ]);
  });
  it('the notes follow the algorithm’s own numbers', () => {
    const p = BUILT_IN_ALGORITHM.params;
    const mine = user({ params: setParam(setParam(setParam(p, 'seedWeights.feedback', 0.3), 'seedWeights.genre', 0.4), 'tasteWeight', 0.3) });
    const notes = formulaNotes(mine);
    expect(notes[0]).toContain('Its 0.3 there counts towards coverage only');
    expect(notes[0]).toContain('+ 0.3 when you gave feedback on the song, its artist or its album) / 1.35.');
    expect(notes[1]).toContain('Genre counts half (0.2)');
    expect(notes[3]).toContain('not a fixed 0.3; it grows with your listening history from 0 up to 0.5. With improved ranking off it is 0.3.');
    expect(formulaNotes(user({ finalFormula: '0.5 * genre' })).at(-1)).toMatch(/^The queue is then picked/);
  });

  it('reproduces today’s scores exactly (v1 and v2, with taste, feedback and exposure)', () => {
    const cfg = algorithmToEngine(BUILT_IN_ALGORITHM);
    expect(cfg.rankingFormula).toBeNull();
    for (const v2 of [false, true]) expect(scores(cfg, v2)).toEqual(scores(DEFAULT_ENGINE, v2));
    expect(engineFromSettings({})).toEqual(cfg);
  });

  it('every parameter of the active algorithm really changes scores', () => {
    const base = { v1: scores(DEFAULT_ENGINE, false), v2: scores(DEFAULT_ENGINE, true) };
    for (const f of PARAM_FIELDS) {
      const now = BUILT_IN_ALGORITHM.params;
      const value = f.path === 'exposurePerShow' ? 0.1 : f.path === 'exposureMax' ? 0.05 : f.kind === 'share' ? 0.95 : 0.9;
      const alg = user({ params: setParam(now, f.path, value) });
      const cfg = algorithmToEngine(alg);
      const changed = JSON.stringify(scores(cfg, false)) !== JSON.stringify(base.v1) || JSON.stringify(scores(cfg, true)) !== JSON.stringify(base.v2);
      expect(changed, f.path).toBe(true);
    }
    const custom = algorithmToEngine(user({ finalFormula: '0.5 * genre' }));
    expect(custom.rankingFormula).toBe('0.5 * genre');
    expect(scores(custom, true)).not.toEqual(base.v2);
  });
});

describe('validation', () => {
  it('accepts the built-in and a copy', () => {
    expect(algorithmErrors(BUILT_IN_ALGORITHM)).toEqual([]);
    expect(validateAlgorithm(user()).name).toBe('Mine');
  });
  it('refuses an algorithm with every weight at 0, which would score every song 0', () => {
    let p = BUILT_IN_ALGORITHM.params;
    for (const f of PARAM_FIELDS) if (f.kind === 'weight' && f.path !== 'seedWeights.feedback') p = setParam(p, f.path, 0);
    expect(paramErrors(p)).toEqual(['At least one seed fit or global weight must be above 0.']);
    expect(paramErrors(setParam(p, 'globalWeights.novelty', 0.01))).toEqual([]);
  });
  it('rejects bad values with clear English messages', () => {
    const p = BUILT_IN_ALGORITHM.params;
    expect(paramErrors(setParam(p, 'seedWeights.audio', -0.1))).toEqual(['Sound (seed fit) must be 0 or more (at most 100).']);
    expect(paramErrors(setParam(p, 'bestSeedShare', 1.5))).toEqual(['Best starting song share must be between 0 and 1.']);
    expect(paramErrors(setParam(p, 'exposureMax', Number.NaN))).toEqual(['Largest repeat penalty must be a number.']);
    expect(paramErrors(setParam(p, 'coverageFloor', Number.POSITIVE_INFINITY))).toEqual(['Coverage floor must be a finite number.']);
    let zero = p;
    for (const k of ['audio', 'genre', 'artist', 'provider', 'feedback', 'tempo']) zero = setParam(zero, `seedWeights.${k}`, 0);
    expect(paramErrors(zero)).toEqual(['At least one seed-fit weight must be above 0.']);
    expect(paramErrors({ ...p, extra: 1 })).toEqual(['The parameters has an unknown field “extra”.']);
    expect(algorithmErrors(user({ name: '  ' }))).toEqual(['Give the algorithm a name.']);
    expect(algorithmErrors(user({ finalFormula: 'genre +' }))[0]).toMatch(/^Final-step formula: /);
    expect(algorithmErrors(user({ id: 'bad id!' }))).toEqual(['The algorithm id must be 1–64 letters, digits, dashes or underscores.']);
    expect(() => validateAlgorithm(user({ params: setParam(p, 'tasteWeight', 2) }))).toThrow('Listening taste must be between 0 and 1.');
  });
});

describe('import and export', () => {
  it('round-trips through JSON with a schema version and a fresh id', () => {
    const mine = user({ name: 'Groove', params: setParam(BUILT_IN_ALGORITHM.params, 'globalWeights.novelty', 0.4), finalFormula: 'affinity * 0.9' });
    const text = serializeAlgorithm(mine);
    expect(JSON.parse(text)).toMatchObject({ format: 'airwave-algorithm', version: 1, algorithm: { name: 'Groove' } });
    expect(JSON.parse(text).algorithm.id).toBeUndefined();
    const back = parseAlgorithm(text, 'user-imported');
    expect(back).toEqual({ ...mine, id: 'user-imported' });
    expect(formulaLines(back)).toEqual(formulaLines(mine));
  });
  it('rejects unknown, wrong-version, malformed and oversized input', () => {
    const ok = JSON.parse(serializeAlgorithm(user()));
    expect(() => parseAlgorithm('{nope')).toThrow('This is not valid JSON.');
    expect(() => parseAlgorithm(JSON.stringify({ ...ok, format: 'other' }))).toThrow('This is not a jPlay algorithm file.');
    expect(() => parseAlgorithm(JSON.stringify({ ...ok, version: 2 }))).toThrow(/Unsupported algorithm file version 2/);
    expect(() => parseAlgorithm(JSON.stringify({ ...ok, extra: true }))).toThrow('The file has an unknown field “extra”.');
    expect(() => parseAlgorithm(JSON.stringify({ ...ok, algorithm: { ...ok.algorithm, builtIn: true } }))).toThrow('The algorithm has an unknown field “builtIn”.');
    expect(() => parseAlgorithm(JSON.stringify({ ...ok, algorithm: { ...ok.algorithm, params: { ...ok.algorithm.params, coverageFloor: 3 } } }))).toThrow('Coverage floor must be between 0 and 1.');
    // ARTIST-FAV-ALGO-001: the limit is 64 KB now that a file carries up to 200 starred artists.
    expect(() => parseAlgorithm(' '.repeat(70_000) + '{}')).toThrow(/too large/);
    expect(() => parseAlgorithm('')).toThrow(/Paste algorithm JSON/);
  });
});

describe('settings migration and patches', () => {
  it('migrates legacy weights and ranking_formula once into an active "My formula" with identical ranking', () => {
    const legacy = { adventurous: 0.5, weights: { audio: 0.2, novelty: 0.3 }, ranking_formula: 'affinity * 0.8' };
    const m = migrateAlgorithmSettings(legacy);
    expect(m['weights']).toBeUndefined();
    expect(m['ranking_formula']).toBeUndefined();
    expect(m['active_algorithm']).toBe(MIGRATED_ID);
    expect(m['algorithms']).toEqual([expect.objectContaining({ id: MIGRATED_ID, name: 'My formula', finalFormula: 'affinity * 0.8' })]);
    const before = { ...engineWithWeights(legacy.weights), rankingFormula: 'affinity * 0.8' };
    for (const v2 of [false, true]) expect(scores(engineFromSettings(legacy), v2)).toEqual(scores(before, v2));
    // Re-reading the migrated result is stable: nothing migrates twice.
    expect(migrateAlgorithmSettings(m)).toEqual(m);
    expect(settingsWithAlgorithms(legacy)['ranking_formula']).toBe('affinity * 0.8');
    // Default-valued legacy keys leave the built-in active.
    expect(migrateAlgorithmSettings({ weights: {}, ranking_formula: null })['active_algorithm']).toBe(BUILT_IN_ID);
  });

  it('drops invalid stored algorithms and an unknown active id instead of failing', () => {
    const m = migrateAlgorithmSettings({ algorithms: [user(), { id: 'x', name: 'Broken' }, { ...user(), id: BUILT_IN_ID }], active_algorithm: 'gone' });
    expect((m['algorithms'] as Algorithm[]).map((a) => a.id)).toEqual(['user-test']);
    expect(m['active_algorithm']).toBe(BUILT_IN_ID);
  });

  it('validates PUT patches and routes legacy writes into the active user algorithm', () => {
    const mine = user();
    expect(applyAlgorithmPatch({}, { algorithms: [mine], active_algorithm: mine.id })).toEqual({ algorithms: [mine], active_algorithm: mine.id });
    expect(() => applyAlgorithmPatch({}, { active_algorithm: 'nope' })).toThrow(/The active algorithm must be/);
    expect(() => applyAlgorithmPatch({}, { algorithms: [mine, mine] })).toThrow(/share the id/);
    expect(() => applyAlgorithmPatch({}, { algorithms: [{ ...mine, builtIn: true }] })).toThrow(/built in/);
    expect(() => applyAlgorithmPatch({}, { algorithms: 'x' })).toThrow('The algorithms setting must be a list.');
    const viaFormula = applyAlgorithmPatch({}, { ranking_formula: 'genre' }, () => 'user-new');
    expect(viaFormula.active_algorithm).toBe('user-new');
    expect(viaFormula.algorithms[0]).toMatchObject({ name: 'My formula', finalFormula: 'genre' });
    const viaWeights = applyAlgorithmPatch({ algorithms: [mine], active_algorithm: mine.id }, { weights: { audio: 0.5, feedback: 0.2 } });
    expect(viaWeights.algorithms[0]!.params.seedWeights).toMatchObject({ audio: 0.5, feedback: 0.2 });
    expect(viaWeights.algorithms[0]!.params.globalWeights.feedback).toBe(0.2);
    expect(() => applyAlgorithmPatch({}, { weights: { audio: 3 } })).toThrow(/within 0..1/);
    // Resetting the formula while the built-in is active changes nothing.
    expect(applyAlgorithmPatch({}, { ranking_formula: null })).toEqual({ algorithms: [], active_algorithm: BUILT_IN_ID });
  });
});
