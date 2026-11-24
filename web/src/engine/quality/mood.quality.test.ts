/**
 * WP0 step 4: section 4 targets for the listening mood (M1, M2) and the section 3.4 owner example, on the real
 * buildMood / moodOrder / moodFit with fixed timestamps and fake tags/vectors. WP6 targets are `it.fails` until it lands.
 */
import { describe, expect, it } from 'vitest';
import { DIM } from '../audio';
import { buildMood, moodFit, moodOrder, moodTags, type MoodCandidate, type MoodSignal, type MoodTags } from '../mood-queue';
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
 * A passive session (plan M1): the queue alternates hip-hop, electronic, jazz and rock; the listener only lets songs
 * play. After each song starts the mood is rebuilt (finished songs + the song playing) and the rest is re-ordered.
 */
function passiveSession(songs = 24) {
  let upcoming = Array.from({ length: 48 }, (_, i) => `${GENRES[i % 4]}${i}`);
  const finished: MoodSignal[] = [];
  const played: string[] = [];
  let moved = 0;
  let now = NOW;
  for (let t = 0; t < songs; t++) {
    const playing = upcoming.shift()!;
    played.push(playing);
    const mood = buildMood([...finished, sig(playing, 'current', now, { listened: 0, duration: 200 })], now);
    const plan = moodOrder(upcoming.map(cand), mood, 0.5, { shown: upcoming });
    if (plan.changed) { moved += plan.moved.length; upcoming = plan.order; }
    now += 200;
    finished.push(sig(playing, 'complete', now, { listened: 200, duration: 200 }));
  }
  const genres = played.map(genreOf);
  return { longest: longestRun(genres), first12: new Set(genres.slice(0, 12)).size, moved };
}

describe('M1 (WP6): the mood follows without locking in', () => {
  // NOT LANDED (WP6): every finished song (including ones the mood moved up) reinforces it (plan: run of 10).
  it.fails('passive 24-song session: longest same-genre run is at most 5', () => {
    expect(passiveSession().longest).toBeLessThanOrEqual(5);
  });
  // NOT LANDED (WP6): plan: 2 genres heard in the first 12.
  it.fails('same: at least 3 genres are heard in the first 12 songs', () => {
    expect(passiveSession().first12).toBeGreaterThanOrEqual(3);
  });
  // NOT LANDED (WP6): plan: 166 rows moved. This harness re-orders once per song start, so its count differs from the
  // app's, but the bound is the plan's.
  it.fails('same: at most 80 rows are moved in total', () => {
    expect(passiveSession().moved).toBeLessThanOrEqual(80);
  });
});

describe('M2 (WP6): the song playing is not full evidence from second 0', () => {
  // NOT LANDED (WP6): plan: jazz fit goes from 0 to 0.656 the moment a jazz song starts (bar 0.5).
  it.fails('after three finished rap songs, a new genre\u2019s fit at second 0 of its first song is under 0.5', () => {
    const signals = [
      sig('hiphop1', 'complete', NOW - 600, { listened: 200, duration: 200 }),
      sig('hiphop5', 'complete', NOW - 400, { listened: 200, duration: 200 }),
      sig('hiphop9', 'complete', NOW - 200, { listened: 200, duration: 200 }),
      sig('jazz2', 'current', NOW, { listened: 0, duration: 200 }),
    ];
    const { fit } = moodFit([cand('jazz6')], buildMood(signals, NOW));
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
});
