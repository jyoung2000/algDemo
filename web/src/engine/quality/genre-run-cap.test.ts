/**
 * Option 2 (0.20.18): same-genre runs in the mood plan are capped at about five.
 * Real buildMood / moodOrder with fixed timestamps and tags-only candidates (vector: null), as mood.quality.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { buildMood, capRuns, moodOrder, moodTags, type MoodCandidate, type MoodSignal, type MoodTags } from '../mood-queue';
import { longestRun } from './fixtures';

const NOW = 1_800_000_000;
const TAGS: Record<string, MoodTags> = {
  hiphop: moodTags({ genres: ['Rap'] }),
  electronic: moodTags({ genres: ['Electronic'] }),
  jazz: moodTags({ genres: ['Smooth jazz'] }),
  rock: moodTags({ genres: ['Rock'] }),
};
const genreOf = (key: string) => Object.keys(TAGS).find((g) => key.startsWith(g))!;
const cand = (key: string): MoodCandidate => ({ key, tags: TAGS[genreOf(key)]!, vector: null });
const sig = (key: string, kind: MoodSignal['kind'], ts: number): MoodSignal => ({ ...cand(key), kind, ts, listened: 200, duration: 200 });
const genres = (keys: string[]) => keys.map(genreOf);

// A rap-leaning listener: two starred rap songs, a starred electronic one, rap now playing.
const railSignals = (): MoodSignal[] => [sig('hiphop90', 'like', NOW - 600), sig('electronic91', 'like', NOW - 300), { ...cand('hiphop92'), kind: 'current', ts: NOW, listened: 0, duration: 200 }];

describe('option 2: same-genre runs are capped at five', () => {
  // The planner's top 12 rows are protected (owner decision): the grouped block sits after them, at row 13 on.
  const grouped = (): MoodCandidate[] => [
    ...Array.from({ length: 12 }, (_, i) => cand(`${['jazz', 'rock', 'electronic'][i % 3]}${i}`)),
    ...Array.from({ length: 8 }, (_, i) => cand(`hiphop${i}`)),
    ...Array.from({ length: 4 }, (_, i) => cand(`electronic${i + 12}`)),
    ...Array.from({ length: 4 }, (_, i) => cand(`jazz${i + 12}`)),
    ...Array.from({ length: 4 }, (_, i) => cand(`rock${i + 12}`)),
  ];

  it('a grouped rap block after the protected top 12 never runs more than five from row 13 on', () => {
    const upcoming = grouped();
    const plan = moodOrder(upcoming, buildMood(railSignals(), NOW, { plan: 'v2' }), 0.5, { version: 'v2' });
    expect(longestRun(genres(plan.order.slice(12)))).toBeLessThanOrEqual(5);
  });


  it('the cap keeps every track exactly once', () => {
    const upcoming = grouped();
    const plan = moodOrder(upcoming, buildMood(railSignals(), NOW, { plan: 'v2' }), 0.5, { version: 'v2' });
    expect([...plan.order].sort()).toEqual(upcoming.map((c) => c.key).sort());
  });

  it('control: an alternating queue already within the cap is not reordered by the cap (no mood, no churn)', () => {
    const alt = Array.from({ length: 16 }, (_, i) => cand(`${['hiphop', 'electronic', 'jazz', 'rock'][i % 4]}${i}`));
    const plan = moodOrder(alt, buildMood([], NOW, { plan: 'v2' }), 0.5, { version: 'v2' });
    expect(plan.order).toEqual(alt.map((c) => c.key));
  });

  it('a grouped twelve-song rap block after the protected top 12 never runs more than five from row 13 on, and keeps every track', () => {
    const upcoming = [
      ...Array.from({ length: 12 }, (_, i) => cand(`${['jazz', 'rock', 'electronic'][i % 3]}${i}`)),
      ...Array.from({ length: 12 }, (_, i) => cand(`hiphop${i}`)),
      ...Array.from({ length: 12 }, (_, i) => cand(`electronic${i + 12}`)),
    ];
    const plan = moodOrder(upcoming, buildMood(railSignals(), NOW, { plan: 'v2' }), 0.5, { version: 'v2' });
    expect(longestRun(genres(plan.order.slice(12)))).toBeLessThanOrEqual(5);
    expect([...plan.order].sort()).toEqual(upcoming.map((c) => c.key).sort());
  });

  describe('capRuns (unit)', () => {
    const keysOf = (cs: MoodCandidate[]) => cs.map((c) => c.key);
    const byKey = (cs: MoodCandidate[]) => new Map(cs.map((c) => [c.key, c] as const));

    it('breaks a same-genre tail that has no other genre after it', () => {
      const cs = [...Array.from({ length: 4 }, (_, i) => cand(`hiphop${i}`)), ...Array.from({ length: 8 }, (_, i) => cand(`electronic${i}`))];
      const out = capRuns(keysOf(cs), byKey(cs));
      expect(longestRun(genres(out))).toBeLessThanOrEqual(5);
      expect([...out].sort()).toEqual(keysOf(cs).sort());
    });

    it('never moves the head song, and the protected top 12 stay put when the cap is told to fix them', () => {
      const cs = [...Array.from({ length: 12 }, (_, i) => cand(`hiphop${i}`)), ...Array.from({ length: 12 }, (_, i) => cand(`electronic${i}`))];
      expect(capRuns(keysOf(cs), byKey(cs))[0]).toBe('hiphop0');
      expect(capRuns(keysOf(cs), byKey(cs), 12).slice(0, 12)).toEqual(keysOf(cs).slice(0, 12));
    });

    it('leaves a single-genre queue unchanged when no other genre exists to move in', () => {
      const cs = Array.from({ length: 10 }, (_, i) => cand(`hiphop${i}`));
      expect(capRuns(keysOf(cs), byKey(cs))).toEqual(keysOf(cs));
    });
  });

  it('missing genre metadata is never a run: untagged songs stay in engine order', () => {
    const untagged = Array.from({ length: 10 }, (_, i) => ({ key: `plain${i}`, tags: moodTags({}), vector: null }) as MoodCandidate);
    const plan = moodOrder(untagged, buildMood(railSignals(), NOW, { plan: 'v2' }), 0.5, { version: 'v2' });
    expect(plan.order).toEqual(untagged.map((c) => c.key));
  });
});
