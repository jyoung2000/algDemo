// MOOD-SHUFFLE-001 (owner, 2026-11-19: "even shuffle should take into account my current listen mood and re
// organize the shuffle based on my listening mood, shuffle shouldn't ignore my listening mood").
import { beforeEach, describe, expect, it } from 'vitest';
import { DIM } from './audio';
import { buildMood, moodFit, moodShufflePick, moodTags, type MoodCandidate, type MoodSignal } from './mood-queue';
import { resetShuffleNextForTests, stepQueue } from '../util';
import type { RecItem } from '../api';

const NOW = 1_800_000_000;
const vec = (axis: number, noise = 0) => { const v = new Float32Array(DIM); v[axis] = 1; if (noise) v[(axis + 7) % DIM] = noise; return v; };
const RAP = moodTags({ genres: ['Rap'], subgenre: 'Rage' });
const ELEC = moodTags({ genres: ['Electronic'] });
const JAZZ = moodTags({ genres: ['Smooth jazz'] });
const COUNTRY = moodTags({ genres: ['Country'] });
const sig = (key: string, kind: MoodSignal['kind'], tags = RAP, agoS = 60, vector: Float32Array | null = null): MoodSignal => ({ key, kind, ts: NOW - agoS, tags, vector });
const cand = (key: string, tags: MoodCandidate['tags'], vector: Float32Array | null = null): MoodCandidate => ({ key, tags, vector });
/** A seeded generator, so the counts below are the same on every run. */
function seeded(seed = 7) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const rapMood = buildMood([sig('r1', 'complete', RAP, 600, vec(1)), sig('r2', 'like', RAP, 300, vec(1, 0.1)), sig('r3', 'complete', RAP, 100, vec(1, 0.2))], NOW);
const list = [cand('jazz1', JAZZ, vec(9)), cand('country1', COUNTRY, vec(11)), cand('jazz2', JAZZ, vec(9, 0.2)), cand('rap4', RAP, vec(1, 0.3)), cand('elec1', ELEC, vec(2)), cand('rap5', RAP, null), cand('country2', COUNTRY, null)];

describe('mood fit', () => {
  it('scores how well each song fits the current mood', () => {
    const { fit, confidence } = moodFit(list, rapMood);
    expect(confidence).toBeGreaterThan(0.9);
    expect(fit['rap4']!).toBeGreaterThan(fit['jazz1']!);
    expect(fit['rap5']!).toBeGreaterThan(fit['country1']!);
    expect(fit['rap4']!).toBeGreaterThan(0.6);
    expect(fit['jazz1']!).toBeLessThan(0.3);
  });
  it('with no listening yet there is nothing to go by', () => {
    const { fit, confidence } = moodFit(list, buildMood([], NOW));
    expect(Object.keys(fit)).toEqual([]);
    expect(confidence).toBe(0);
  });
});

describe('shuffle picks by the mood', () => {
  const keys = list.map((c) => c.key);
  const { fit, confidence } = moodFit(list, rapMood);
  const fitMap = new Map(Object.entries(fit));
  const draw = (adventurous: number, n = 2000) => {
    const rand = seeded(11);
    const count: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const k = moodShufflePick(keys, (k) => k, fitMap, { adventurous, confidence, rand }); count[k] = (count[k] ?? 0) + 1; }
    return count;
  };
  const share = (c: Record<string, number>, ks: string[]) => ks.reduce((t, k) => t + (c[k] ?? 0), 0) / 2000;
  // WP5 (D3): the pull is capped at a best-to-worst ratio of 4 on the middle slider (it was e^6.5 ~ 665, measured
  // 0.80+ / under 0.05 shares here); a song that fits now comes up about 4x as often as one that does not.
  it('songs that fit the mood come up far more often than ones that do not', () => {
    const c = draw(0.5);
    const per = (ks: string[]) => share(c, ks) / ks.length;
    const ratio = per(['rap4', 'rap5']) / per(['jazz1', 'jazz2', 'country1']);
    expect(ratio).toBeGreaterThan(3);
    expect(ratio).toBeLessThan(5.5);
    expect(share(c, ['rap4', 'rap5'])).toBeGreaterThan(0.55);
  });
  it('it is still a shuffle: every fitting song gets picked, not always the same one', () => {
    const c = draw(0.5);
    expect(c['rap4']).toBeGreaterThan(200);
    expect(c['rap5']).toBeGreaterThan(200);
  });
  it('Adventurous lets more variety through than Familiar', () => {
    const familiar = share(draw(0), ['jazz1', 'jazz2', 'country1', 'country2', 'elec1']);
    const adventurous = share(draw(1), ['jazz1', 'jazz2', 'country1', 'country2', 'elec1']);
    expect(adventurous).toBeGreaterThan(familiar);
    // WP5 (D3): Adventurous is a ratio of 2, so fitting songs still beat an even shuffle (2 of 7 = 0.29).
    expect(share(draw(1), ['rap4', 'rap5'])).toBeGreaterThan(0.4);
  });
  it('with no mood it is an even shuffle', () => {
    const rand = seeded(3);
    const count: Record<string, number> = {};
    for (let i = 0; i < 7000; i++) { const k = moodShufflePick(keys, (k) => k, new Map(), { adventurous: 0.5, confidence: 0, rand }); count[k] = (count[k] ?? 0) + 1; }
    for (const k of keys) expect(count[k]).toBeGreaterThan(800);
  });
});

describe('the shuffled queue', () => {
  beforeEach(() => resetShuffleNextForTests());
  const items = list.map((c) => ({ track: { key: c.key, title: c.key, artists: ['x'], provider: 'deezer' }, playback: { preview: 'https://x/p.mp3', embed: null } } as unknown as RecItem));
  const { fit, confidence } = moodFit(list, rapMood);
  const moodFitMap = new Map(Object.entries(fit));
  it('plays the songs that fit the mood first, and still plays every song once before any repeats', () => {
    const rand = seeded(5);
    const heard = new Set<string>();
    const order: string[] = [];
    let from: string | null = null;
    for (let i = 0; i < items.length; i++) {
      const step = stepQueue(items, from, 1, new Set(), { shuffle: true, repeat: 'off', heard: new Set(heard), rand, mood: { fit: moodFitMap, confidence, adventurous: 0.5 } });
      expect(step).not.toBeNull();
      const k = step!.item.track.key;
      order.push(k); heard.add(k); from = k;
    }
    expect(new Set(order).size).toBe(items.length);
    expect(order.slice(0, 2).sort()).toEqual(['rap4', 'rap5']);
  });
});
