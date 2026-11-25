/** WP6 (M1, M2, M5, D2, D4): unit tests for the v2 mood plan; v1 stays reachable through mood_plan. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIM } from './audio';
import { LocalApi } from './local-api';
import { buildMood, currentWeight, moodMatch, moodOrder, moodTags, scorePercentile, varietyShare, varietySlots, type MoodCandidate, type MoodSignal } from './mood-queue';
import { MemoryBackend, Store } from './store';
import type { HttpPort } from './net';
import { passiveSession } from './quality/mood.quality.test';

const NOW = 1_800_000_000;
const RAP = moodTags({ genres: ['Rap'] });
const ROCK = moodTags({ genres: ['Rock'] });
const JAZZ = moodTags({ genres: ['Smooth jazz'] });
const vec = (axis: number) => { const v = new Float32Array(DIM); v[axis] = 1; return v; };
const c = (key: string, tags = RAP, extra: Partial<MoodCandidate> = {}): MoodCandidate => ({ key, tags, vector: null, ...extra });
const s = (key: string, kind: MoodSignal['kind'], extra: Partial<MoodSignal> = {}): MoodSignal => ({ ...c(key), kind, ts: NOW, ...extra });

describe('WP6 step 1 (M2, D2): the song playing ramps 1 -> 3 over 45 s', () => {
  it('weighs 1 at second 0, 2 at 22.5 s and 3 from 45 s', () => {
    expect(currentWeight(0)).toBe(1);
    expect(currentWeight(22.5)).toBe(2);
    expect(currentWeight(45)).toBe(3);
    expect(currentWeight(300)).toBe(3);
    expect(currentWeight(undefined)).toBe(1);
  });
  it('v2 counts the ramped weight; v1 keeps 3 from second 0', () => {
    expect(buildMood([s('a', 'current', { listened: 0 })], NOW, { plan: 'v2' }).pos.weight).toBeCloseTo(1, 6);
    expect(buildMood([s('a', 'current', { listened: 45 })], NOW, { plan: 'v2' }).pos.weight).toBeCloseTo(3, 6);
    expect(buildMood([s('a', 'current', { listened: 0 })], NOW).pos.weight).toBeCloseTo(3, 6);
  });
});

describe('WP6 step 2 (M1): confidence = min(1, (active + 0.5 x passive) / 6)', () => {
  it('a star is active, a finished song and the song playing are passive', () => {
    const m = buildMood([s('a', 'replay'), s('b', 'complete', { listened: 200, duration: 200 }), s('c', 'current', { listened: 0 })], NOW, { plan: 'v2' });
    expect(m.active).toBeCloseTo(3, 6);
    expect(m.passive).toBeCloseTo(3, 6);
    expect(m.confidence).toBeCloseTo((3 + 0.5 * 3) / 6, 6);
    expect(m.activeShare).toBeCloseTo(0.5, 6);
    expect(buildMood([s('a', 'like')], NOW, { plan: 'v2' }).confidence).toBeCloseTo(5 / 6, 6);
  });
  it('caps at 1', () => {
    expect(buildMood([s('a', 'like'), s('b', 'similar')], NOW, { plan: 'v2' }).confidence).toBe(1);
  });
  it('a finished song the mood moved counts 1 instead of 2', () => {
    const done = s('b', 'complete', { listened: 200, duration: 200 });
    expect(buildMood([done], NOW, { plan: 'v2' }).pos.weight).toBeCloseTo(2, 6);
    expect(buildMood([done], NOW, { plan: 'v2', moved: new Set(['b']) }).pos.weight).toBeCloseTo(1, 6);
    expect(buildMood([done], NOW, { moved: new Set(['b']) }).pos.weight).toBeCloseTo(2, 6); // v1 unchanged
  });
});

describe('WP6 step 2: LocalApi keeps the last 64 moved keys', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T18:00:00Z')); });
  afterEach(() => vi.useRealTimers());
  const tag = (name: string) => ({ name, label: name, source: 'test', scope: 'track', confidence: 1, inferred: false });
  const song = (key: string, genre: string) => ({ key, title: key, artists: [`${key} artist`], provider: 'local', platform_id: key, tags: [tag(genre)], bpm: 120, release: null, duration: 200 });
  it('remembers what a changed plan moved, never more than 64 keys', async () => {
    const store = await Store.open(new MemoryBackend());
    await store.put('settings', { adventurous: 0.3 });
    const api = new LocalApi({ store, port: { request: async () => { throw new Error('offline'); } } as HttpPort, encoder: null });
    await api.handle('POST', '/api/feedback', { kind: 'like', event_id: 'l1', track: song('rap-one', 'rap') });
    await api.handle('POST', '/api/feedback', { kind: 'like', event_id: 'l2', track: song('rap-two', 'rap') });
    let movedTotal = 0;
    for (let r = 0; r < 6; r++) {
      const upcoming = Array.from({ length: 40 }, (_, i) => song(`r${r}-${i}`, i % 2 ? 'rap' : 'smooth jazz'));
      const res = await api.handle('POST', '/api/mood', { upcoming: upcoming.map((track, i) => ({ track, score: 1 - i / 40 })), current: { track: song('rap-now', 'rap'), heard: 60 } });
      const plan = res.body as { changed: boolean; moved: string[] };
      if (plan.changed) movedTotal += plan.moved.length;
    }
    const kept = api.moodMovedForTest();
    expect(movedTotal).toBeGreaterThan(64);
    expect(kept.length).toBe(64);
  });
});

describe('WP6 step 3 (M1): the base term is the engine score percentile', () => {
  it('ranks by score, not by list place, ties sharing a rank', () => {
    const b = scorePercentile([{ score: 0.1 }, { score: 0.9 }, { score: 0.5 }, { score: 0.5 }], 3);
    expect(b[1]).toBe(1);
    expect(b[0]).toBe(0);
    expect(b[2]).toBeCloseTo(0.5, 6);
    expect(b[3]).toBeCloseTo(0.5, 6);
  });
  it('falls back to list place when no row has a score', () => {
    expect(scorePercentile([{}, {}, {}], 2)).toEqual([1, 0.5, 0]);
  });
  it('a high-scored row low in the shown list is planned first when fits are equal', () => {
    const mood = buildMood([s('x', 'like', { listened: 0 })], NOW, { plan: 'v2' });
    const ups = Array.from({ length: 30 }, (_, i) => c(`r${i}`, RAP, { score: i === 20 ? 1 : 0.5 - i / 100 }));
    const plan = moodOrder(ups, mood, 0, { force: true });
    expect(plan.order[0]).toBe('r20');
  });
});

describe('WP6 step 4 (D4): the variety share', () => {
  it('ε = base(a) x (1 - 0.75 x activeShare) with 0.10 / 0.20 / 0.35', () => {
    expect(varietyShare(0, 0)).toBeCloseTo(0.1, 6);
    expect(varietyShare(0.5, 0)).toBeCloseTo(0.2, 6);
    expect(varietyShare(1, 0)).toBeCloseTo(0.35, 6);
    expect(varietyShare(1, 1)).toBeCloseTo(0.35 * 0.25, 6);
  });
  it('spreads slots from place 4 onward', () => {
    expect(varietySlots(1, 3, 12)).toEqual([7]);
    expect(varietySlots(2, 3, 12)).toEqual([6, 9]);
    expect(Math.min(...varietySlots(4, 3, 12))).toBeGreaterThanOrEqual(3);
  });
  it('passive rap listening keeps round(12 x ε) engine-best rock rows in the plan, never a disliked-sound one', () => {
    // Adventurous, passive only: ε = 0.35 -> round(4.2) = 4 places. The engine's best rows are a jazz song that
    // sounds like the disliked one (dislike match >= 0.5) and four rock songs; rap fills the rest of the list.
    const signals = [
      s('d1', 'dislike', { tags: JAZZ, vector: vec(9) }),
      ...[1, 2, 3, 4].map((n) => s(`done${n}`, 'complete', { listened: 200, duration: 200 })),
      s('now', 'current', { listened: 45 }),
    ];
    const mood = buildMood(signals, NOW, { plan: 'v2' });
    const jazz = c('jazzbad', JAZZ, { vector: vec(9), score: 1 });
    expect(moodMatch(jazz, mood).d).toBeGreaterThanOrEqual(0.5);
    const ups = [jazz, ...[0, 1, 2, 3].map((i) => c(`rock${i}`, ROCK, { score: 0.99 - i / 100 })), ...Array.from({ length: 20 }, (_, i) => c(`rap${i}`, RAP, { score: 0.5 - i / 100 }))];
    const plan = moodOrder(ups, mood, 1, { force: true });
    const top = plan.order.slice(0, 12);
    expect(top.filter((k) => k.startsWith('rock')).length).toBe(4);
    expect(top).not.toContain('jazzbad');
    expect(top.slice(0, 3).every((k) => !k.startsWith('rock'))).toBe(true);
  });
});

describe('WP6 step 5 (M3 via WP4 tooClose): artist gap 3 inside the plan', () => {
  it('no artist repeats within 3 places of the plan when others are available', () => {
    const mood = buildMood([s('x', 'like')], NOW, { plan: 'v2' });
    const artists = ['A', 'A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'E', 'F', 'G', 'H', 'I'];
    const ups = artists.map((a, i) => c(`k${i}`, RAP, { artist: a, score: 1 - i / 20 }));
    const plan = moodOrder(ups, mood, 0, { force: true });
    const byKey = new Map(ups.map((u) => [u.key, u.artist!] as const));
    const seq = plan.order.slice(0, 12).map((k) => byKey.get(k)!);
    for (let i = 1; i < seq.length; i++) expect(seq.slice(Math.max(0, i - 3), i)).not.toContain(seq[i]);
  });
});

describe('WP6 step 6 (M5): a dislike without sound is the tag match x 0.5', () => {
  it('v2 halves the tag-only dislike; v1 stretches it to the full penalty', () => {
    const sig = [s('d', 'dislike', { tags: JAZZ })];
    const cand = c('j', JAZZ);
    const v2 = moodMatch(cand, buildMood(sig, NOW, { plan: 'v2' })).d;
    const v1 = moodMatch(cand, buildMood(sig, NOW)).d;
    expect(v1).toBeCloseTo(1, 6);
    expect(v2).toBeCloseTo(0.5, 6);
  });
});

describe('WP6 step 7: mood_plan v1 is the old order', () => {
  it('the rebuilt passive session on v1 still gives the measured BEFORE values', () => {
    const r = passiveSession('v1');
    expect([r.longest, r.first12, r.moved]).toEqual([10, 2, 166]);
  });
  it('moodOrder with version v1 equals the pre-WP6 call', () => {
    const signals = [s('a', 'like'), s('b', 'complete', { listened: 200, duration: 200 }), s('c', 'current', { listened: 0 })];
    const ups = [...Array.from({ length: 8 }, (_, i) => c(`rock${i}`, ROCK)), ...Array.from({ length: 8 }, (_, i) => c(`rap${i}`, RAP))];
    const old = moodOrder(ups, buildMood(signals, NOW), 0.5);
    const v1 = moodOrder(ups, buildMood(signals, NOW, { plan: 'v1' }), 0.5, { version: 'v1' });
    expect(v1).toEqual(old);
    expect(old.changed).toBe(true);
  });
  it('the setting picks the plan through the engine route', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-19T18:00:00Z'));
    try {
      const store = await Store.open(new MemoryBackend());
      const api = new LocalApi({ store, port: { request: async () => { throw new Error('offline'); } } as HttpPort, encoder: null });
      expect((await api.handle('PUT', '/api/settings', { mood_plan: 'v1' })).status).toBe(200);
      expect(api.settings()['mood_plan']).toBe('v1');
      await api.handle('PUT', '/api/settings', { mood_plan: 'nonsense' });
      expect(api.settings()['mood_plan']).toBe('v2');
    } finally { vi.useRealTimers(); }
  });
});
