/**
 * WP0 step 4: section 4 targets for the listening mood (M1, M2) and the section 3.4 owner example, on the real
 * buildMood / moodOrder / moodFit with fixed timestamps and fake tags/vectors. WP6 (M1, M2) targets are plain assertions on mood_plan 'v2'.
 */
import { describe, expect, it } from 'vitest';
import { DIM } from '../audio';
import { buildMood, moodFit, moodOrder, moodTags, type MoodCandidate, type MoodPlanVersion, type MoodSignal, type MoodTags } from '../mood-queue';
import { longestRun } from './fixtures';

const NOW = 1_800_000_000;
const GENRES = ['hiphop', 'electronic', 'jazz', 'rock'] as const;
type Genre = (typeof GENRES)[number];
const TAGS: Record<Genre, MoodTags> = {
  hiphop: moodTags({ genres: ['Rap'] }),
  electronic: moodTags({ genres: ['Electronic'] }),
  jazz: moodTags({ genres: ['Smooth jazz'] }),
  rock: moodTags({ genres: ['Rock'] }),
};
const AXIS: Record<Genre, number> = { hiphop: 1, electronic: 2, jazz: 9, rock: 13 };
const vec = (axis: number, noise = 0) => { const v = new Float32Array(DIM); v[axis] = 1; if (noise) v[(axis + 7) % DIM] = noise; return v; };
const genreOf = (key: string) => GENRES.find((g) => key.startsWith(g))!;
const cand = (key: string): MoodCandidate => ({ key, tags: TAGS[genreOf(key)], vector: vec(AXIS[genreOf(key)], ((key.length * 7) % 10) / 50) });
const sig = (key: string, kind: MoodSignal['kind'], ts: number, extra: Partial<MoodSignal> = {}): MoodSignal => ({ ...cand(key), kind, ts, ...extra });

/**
 * A passive session (plan M1, rebuilt in WP6 to the plan's own diag scenario): a 40-song queue alternating hip-hop,
 * electronic, jazz and rock, tags only (no measured sound, as for most upcoming songs, M4), engine scores falling with
 * the engine's order; the listener only lets songs play. At each song start the mood is rebuilt (finished songs + the
 * song playing at second 0) and the rest is re-planned; the page re-nudges at 45 s (WP6) with the song heard 45 s.
 * The mood's moved keys (last 64) are kept as LocalApi keeps them.
 * BEFORE, on the unchanged code (v1, 1f063ff): longest run 10, 2 genres in the first 12, 166 rows moved in 8
 * re-arrangements (the plan's section 3 figures exactly).
 */
export function passiveSession(plan: MoodPlanVersion, songs = 24) {
  const engine = Array.from({ length: 40 }, (_, i) => `${GENRES[i % 4]}${i}`);
  const score = new Map(engine.map((k, i) => [k, 1 - i / 40] as const));
  const c = (key: string): MoodCandidate => ({ key, tags: TAGS[genreOf(key)], vector: null, score: score.get(key) });
  let upcoming = [...engine];
  const finished: MoodSignal[] = [];
  const played: string[] = [];
  let movedKeys: string[] = [];
  let moved = 0;
  let changes = 0;
  let now = NOW;
  const replan = (signals: MoodSignal[]) => {
    const mood = buildMood(signals, now, { plan, moved: new Set(movedKeys) });
    const p = moodOrder(upcoming.map(c), mood, 0.5, { shown: upcoming, version: plan });
    if (p.changed) { moved += p.moved.length; changes++; upcoming = p.order; movedKeys = [...movedKeys, ...p.moved].slice(-64); }
  };
  for (let t = 0; t < songs; t++) {
    const playing = upcoming.shift()!;
    played.push(playing);
    const cur = { ...c(playing), kind: 'current' as const };
    replan([...finished, { ...cur, ts: now, listened: 0, duration: 200 }]);
    replan([...finished, { ...cur, ts: now + 45, listened: 45, duration: 200 }]);
    now += 200;
    finished.push({ ...c(playing), kind: 'complete', ts: now, listened: 200, duration: 200 });
  }
  const genres = played.map(genreOf);
  return { longest: longestRun(genres), first12: new Set(genres.slice(0, 12)).size, moved, changes, played: genres.map((g) => g[0]).join('') };
}

describe('M1 (WP6): the mood follows without locking in', () => {
  // WP6 red values (v1 on this fixture): longest run 10, 2 genres in the first 12, 166 rows moved.
  it('passive 24-song session: longest same-genre run is at most 5', () => {
    expect(passiveSession('v2').longest).toBeLessThanOrEqual(5);
  });
  it('same: at least 3 genres are heard in the first 12 songs', () => {
    expect(passiveSession('v2').first12).toBeGreaterThanOrEqual(3);
  });
  it('same: at most 80 rows are moved in total', () => {
    expect(passiveSession('v2').moved).toBeLessThanOrEqual(80);
  });
});

describe('M2 (WP6): the song playing is not full evidence from second 0', () => {
  // WP6 (D2: ramp 1 -> 3 over 45 s). Red value (v1): 0.726 in this fixture (plan: 0.656).
  it('after three finished rap songs, a new genre\u2019s fit at second 0 of its first song is under 0.5', () => {
    const signals = [
      sig('hiphop1', 'complete', NOW - 600, { listened: 200, duration: 200 }),
      sig('hiphop5', 'complete', NOW - 400, { listened: 200, duration: 200 }),
      sig('hiphop9', 'complete', NOW - 200, { listened: 200, duration: 200 }),
      sig('jazz2', 'current', NOW, { listened: 0, duration: 200 }),
    ];
    const { fit } = moodFit([cand('jazz6')], buildMood(signals, NOW, { plan: 'v2' }));
    expect(fit['jazz6'] ?? 0).toBeLessThan(0.5);
  });
});

describe('3.4 must not regress: the owner\u2019s mood example', () => {
  it('starred rap + starred electronic with rap playing: 0 off-mood songs in the next 6', () => {
    const signals = [sig('hiphop90', 'like', NOW - 600), sig('electronic91', 'like', NOW - 300), sig('hiphop92', 'current', NOW, { listened: 0, duration: 200 })];
    const mood = buildMood(signals, NOW);
    // The engine's order puts jazz and rock first.
    const order = ['jazz', 'rock', 'hiphop', 'electronic'] as const;
    const upcoming = Array.from({ length: 16 }, (_, i) => cand(`${order[i % 4]}${i}`));
    const plan = moodOrder(upcoming, mood, 0.5);
    const off = plan.order.slice(0, 6).filter((k) => genreOf(k) === 'jazz' || genreOf(k) === 'rock');
    expect(off).toEqual([]);
  });
  it('WP6: same on mood_plan v2 (the default setting): 0 off-mood songs in the next 6', () => {
    const signals = [sig('hiphop90', 'like', NOW - 600), sig('electronic91', 'like', NOW - 300), sig('hiphop92', 'current', NOW, { listened: 0, duration: 200 })];
    const mood = buildMood(signals, NOW, { plan: 'v2' });
    const order = ['jazz', 'rock', 'hiphop', 'electronic'] as const;
    const upcoming = Array.from({ length: 16 }, (_, i) => cand(`${order[i % 4]}${i}`));
    const plan = moodOrder(upcoming, mood, 0.5, { version: 'v2' });
    const off = plan.order.slice(0, 6).filter((k) => genreOf(k) === 'jazz' || genreOf(k) === 'rock');
    expect(off).toEqual([]);
  });
});
