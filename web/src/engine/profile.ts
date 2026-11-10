/**
 * Everything the recommender currently knows and uses, in one read-only snapshot for the
 * "Your profile" screen: what was tracked (events, listening time), what was learned from it
 * (genre and tempo taste, artist and song scores), and how the algorithm is set to use it
 * (factor weights after the Familiar..Adventurous slider, tier shares, limits).
 *
 * Pure: every input is passed in, so it is tested without a store or the network.
 */
import { AFFINITY_FACTORS, DEFAULT_ENGINE, FACTORS, FEEDBACK_WEIGHTS, type EngineConfig } from './config';
import { buildFeedback, buildFeedback2, modeWeights, normaliseSettings, tierShares, type FeedbackEvent } from './engine';
import { albumKeyOf } from './album-key';
import type { Dict } from './shape';
import { TASTE_EVENT_WEIGHTS, TASTE_HALF_LIFE_DAYS, TASTE_WEIGHT, buildTaste, type TasteRow } from './taste';

export interface ProfileEventRow {
  event_id: string;
  key: string;
  kind: string;
  artist: string;
  track: Dict | null;
  listened: number | null;
  ts: number;
}

export interface ProfileInput {
  events: ProfileEventRow[];
  seeds: Dict[];
  settings: Dict;
  /** Song key -> times shown in a list within the exposure window. */
  impressions: Record<string, number>;
  /** The last finished run, as stored (`last_result`), or null before any run. */
  lastResult: Dict | null;
  /** Size of the candidate pool kept for live re-ranking, or null when there is none. */
  poolSize: number | null;
  vectors: number;
  cfg?: EngineConfig;
  nowTs: number;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

function titleOf(t: Dict | null | undefined, key: string): string {
  return String(t?.['title'] ?? key);
}
function artistOf(t: Dict | null | undefined, fallback = ''): string {
  const a = t?.['artists'];
  return Array.isArray(a) && a.length ? a.map(String).join(', ') : String(t?.['artist'] ?? fallback);
}

export function buildProfile(inp: ProfileInput): Dict {
  const cfg = inp.cfg ?? DEFAULT_ENGINE;
  const events = [...inp.events].sort((a, b) => a.ts - b.ts);
  const byKey = new Map<string, Dict>();
  for (const e of events) if (e.track) byKey.set(e.key, e.track);

  // ---- what was tracked -------------------------------------------------------------------
  const counts: Record<string, number> = {};
  let listenedSec = 0;
  const playedKeys = new Set<string>();
  const artists = new Set<string>();
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    if (e.listened !== null && Number.isFinite(e.listened)) listenedSec += e.listened;
    if (e.kind === 'complete' || e.kind === 'skip' || e.kind === 'replay') playedKeys.add(e.key);
    if (e.artist) artists.add(e.artist);
  }
  const plays = (counts['complete'] ?? 0) + (counts['replay'] ?? 0) + (counts['skip'] ?? 0);
  const impTotal = Object.values(inp.impressions).reduce((a, b) => a + b, 0);

  // ---- what was learned -------------------------------------------------------------------
  const taste = buildTaste(events.map((e): TasteRow => ({ key: e.key, kind: e.kind, ts: e.ts, track: e.track })), inp.nowTs);
  const genres = Object.values(taste.genres)
    .sort((a, b) => b.score - a.score)
    .map((g) => ({ name: g.name, label: g.label, score: r2(g.score), plays: g.plays, skips: g.skips }));
  const fb = buildFeedback(events as FeedbackEvent[], inp.nowTs, cfg);
  const artistScores = Object.entries(fb.artist)
    .map(([name, score]) => ({ name, score: r2(score), liked: fb.likedArtists.has(name) }))
    .sort((a, b) => b.score - a.score);
  const songScores = Object.entries(fb.track)
    .map(([key, score]) => ({ key, title: titleOf(byKey.get(key), key), artist: artistOf(byKey.get(key)), score: r2(score), excluded: fb.excluded.has(key), hidden: fb.hidden.has(key) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  // ALBUM-TASTE-001: the albums the listener keeps playing (or skips through), as the v2 ranker counts them.
  const fb2 = buildFeedback2(events as FeedbackEvent[], inp.nowTs, cfg);
  const albumArtist = new Map<string, string>();
  for (const e of events) {
    const k = e.track ? albumKeyOf(e.track as never) : null;
    // An album is credited to its primary artist, not every name on the first song heard from it.
    if (k && !albumArtist.has(k)) albumArtist.set(k, String((e.track as Dict | null)?.['artists']?.[0] ?? e.artist ?? ''));
  }
  const albumScores = Object.entries(fb2.album ?? {})
    .map(([key, score]) => ({ key, name: fb2.albumNames?.[key] ?? key, artist: albumArtist.get(key) ?? '', score: r2(score) }))
    .sort((a, b) => b.score - a.score);

  // ---- how the algorithm uses it ----------------------------------------------------------
  const es = normaliseSettings({ adventurous: inp.settings['adventurous'], fresh: Boolean(inp.settings['fresh']) });
  const eff = modeWeights(cfg.weights, es.adventurous, es.fresh);
  const effTotal = FACTORS.reduce((s, k) => s + eff[k], 0) || 1;
  const weights: { factor: string; base: number; effective: number; share: number }[] = FACTORS.map((k) => ({ factor: k, base: r3(cfg.weights[k]), effective: r3(eff[k]), share: r3(eff[k] / effTotal) }));
  weights.push({ factor: 'taste', base: TASTE_WEIGHT, effective: taste.events ? TASTE_WEIGHT : 0, share: taste.events ? TASTE_WEIGHT : 0 });
  const shares = tierShares(es.adventurous, cfg);

  // ---- the last run -----------------------------------------------------------------------
  let lastRun: Dict | null = null;
  const lr = inp.lastResult;
  if (lr && Array.isArray(lr['items'])) {
    const items = lr['items'] as Dict[];
    const tiers: Record<string, number> = {};
    const evidence: Record<string, number> = {};
    const sums: Record<string, [number, number]> = {};
    for (const it of items) {
      tiers[it['tier']] = (tiers[it['tier']] ?? 0) + 1;
      evidence[it['evidence']] = (evidence[it['evidence']] ?? 0) + 1;
      for (const [k, v] of Object.entries((it['factors'] as Dict) ?? {})) {
        if (typeof v !== 'number') continue;
        const s = (sums[k] ??= [0, 0]);
        s[0] += v;
        s[1] += 1;
      }
    }
    const factorAvg = Object.entries(sums)
      .map(([factor, [sum, n]]) => ({ factor, mean: r3(sum / n), known: n, of: items.length }))
      .sort((a, b) => FACTORS.indexOf(a.factor as never) - FACTORS.indexOf(b.factor as never));
    const scores = items.map((it) => Number(it['score'])).filter(Number.isFinite);
    const sources = Object.entries((lr['sources'] as Dict) ?? {}).map(([name, s]) => ({ name, state: (s as Dict)?.['state'] ?? 'unknown', count: (s as Dict)?.['count'] ?? null, detail: (s as Dict)?.['detail'] ?? null }));
    lastRun = {
      at: lr['saved_at'] ?? null,
      songs: items.length,
      asked: lr['asked'] ?? null,
      candidates: lr['candidates'] ?? lr['timings']?.['candidates'] ?? null,
      pool: inp.poolSize,
      tiers,
      evidence,
      factors: factorAvg,
      score: scores.length ? { top: r3(Math.max(...scores)), median: r3([...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)]!), low: r3(Math.min(...scores)) } : null,
      sources,
      audio: lr['audio'] ?? {},
      timings: lr['timings'] ?? {},
      transfer: lr['transfer'] ?? {},
    };
  }

  const recent = [...events]
    .reverse()
    .slice(0, 40)
    .map((e) => ({ ts: e.ts, kind: e.kind, key: e.key, title: titleOf(e.track, e.key), artist: artistOf(e.track, e.artist), listened: e.listened }));

  // ---- the last songs actually played, with the tempo and genres the taste model used -----
  // A play is a finished listen, a replay or a skip (the same kinds that count as plays above).
  const plays10 = [...events]
    .filter((e) => e.kind === 'complete' || e.kind === 'replay' || e.kind === 'skip')
    .reverse()
    .slice(0, 10)
    .map((e) => {
      const t = e.track;
      const b = Number(t?.['bpm']);
      const tags = Array.isArray(t?.['tags']) ? (t['tags'] as Dict[]) : [];
      return {
        ts: e.ts,
        kind: e.kind,
        key: e.key,
        title: titleOf(t, e.key),
        artist: artistOf(t, e.artist),
        artwork: typeof t?.['artwork'] === 'string' ? (t['artwork'] as string) : null,
        bpm: Number.isFinite(b) && b > 30 && b < 300 ? Math.round(b) : null,
        genres: tags.map((g) => String(g['label'] ?? g['name'])).slice(0, 4),
        genre_names: tags.map((g) => String(g['name'])).slice(0, 4),
        listened: e.listened,
      };
    });

  // ---- the scoring formula, as the numbers the engine uses (the Profile page renders these) --
  const formula = {
    affinity: {
      // affinity = mean of the best seed's factors (weighted), blended with the others by bestSeedShare
      best_seed_share: cfg.bestSeedShare,
      factors: AFFINITY_FACTORS.map((k) => ({ factor: k, weight: r3(eff[k]) })),
      // global factors (feedback, freshness, novelty) join the same weighted mean when they have evidence
      global: ['feedback', 'freshness', 'novelty'].map((k) => ({ factor: k, weight: r3(eff[k as keyof typeof eff]) })),
    },
    taste: { weight: TASTE_WEIGHT, half_life_days: TASTE_HALF_LIFE_DAYS, event_weights: TASTE_EVENT_WEIGHTS },
    coverage: {
      // final = affinity * (floor + (1 - floor) * coverage); coverage = share of affinity weight with evidence
      floor: cfg.coverageFloor,
    },
    genre_provider_overlap: cfg.genreProviderOverlap,
    exposure: { per_show: cfg.exposurePenalty, max: cfg.exposurePenaltyMax, window_days: cfg.exposureWindowDays },
    selection: { queue_size: cfg.queueSize, max_per_artist: cfg.maxPerArtist, tier_shares: tierShares(es.adventurous, cfg) },
    feedback_decay_days: cfg.feedbackHalfLifeDays,
  };

  return {
    tracked: {
      events: events.length,
      counts,
      plays,
      listened_sec: Math.round(listenedSec),
      songs_played: playedKeys.size,
      artists: artists.size,
      first: events[0]?.ts ?? null,
      last: events[events.length - 1]?.ts ?? null,
      impressions: { shown: impTotal, songs: Object.keys(inp.impressions).length, window_days: cfg.exposureWindowDays },
      vectors: inp.vectors,
    },
    seeds: inp.seeds.map((s) => ({
      key: s['key'],
      title: titleOf(s, s['key']),
      artist: artistOf(s),
      bpm: typeof s['bpm'] === 'number' ? Math.round(s['bpm']) : null,
      genres: ((s['tags'] as Dict[]) ?? []).map((g) => String(g['label'] ?? g['name'])).slice(0, 4),
      emphasis: s['emphasis'] ?? 1,
    })),
    taste: {
      events: taste.events,
      positives: taste.positives,
      negatives: taste.negatives,
      bpm: taste.bpm !== null ? Math.round(taste.bpm) : null,
      bpm_evidence: r2(taste.bpmEvidence),
      bpm_used: taste.bpm !== null && taste.bpmEvidence >= 1.5,
      skip_bpm: taste.skipBpm !== null ? Math.round(taste.skipBpm) : null,
      genres,
    },
    artists: artistScores,
    albums: albumScores,
    songs: songScores,
    excluded: fb.excluded.size,
    hidden: fb.hidden.size,
    algorithm: {
      settings: { adventurous: es.adventurous, fresh: es.fresh, queue_size: Number(inp.settings['queue_size'] ?? cfg.queueSize), audio: inp.settings['audio'] !== false },
      weights,
      tiers: Object.fromEntries(Object.entries(shares).map(([k, v]) => [k, r3(v)])),
      feedback_weights: FEEDBACK_WEIGHTS,
      taste_weights: TASTE_EVENT_WEIGHTS,
      limits: {
        feedback_half_life_days: cfg.feedbackHalfLifeDays,
        taste_half_life_days: TASTE_HALF_LIFE_DAYS,
        max_per_artist: cfg.maxPerArtist,
        artist_skip_threshold: cfg.artistSkipThreshold,
        exposure_penalty: cfg.exposurePenalty,
        exposure_penalty_max: cfg.exposurePenaltyMax,
        coverage_floor: cfg.coverageFloor,
        best_seed_share: cfg.bestSeedShare,
        new_release_days: cfg.newReleaseDays,
        audio_candidates_per_request: cfg.audioCandidatesPerRequest,
      },
    },
    last_run: lastRun,
    recent,
    played: plays10,
    formula,
    generated: inp.nowTs,
  };
}
