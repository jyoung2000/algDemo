/**
 * 0.20.19 queue controls: mood lead (option 1) and the genre run limit (option 2) together, as Settings sets them.
 * Same fixtures as genre-run-cap.test.ts. The planner order is: mood lead first, then the run cap from row 13 on.
 */
import { describe, expect, it } from 'vitest';
import { buildMood, moodOrder, moodTags, type MoodCandidate, type MoodSignal } from '../mood-queue';
import { longestRun } from './fixtures';

const NOW = 1_800_000_000;
const TAGS = {
  hiphop: moodTags({ genres: ['Rap'] }),
  electronic: moodTags({ genres: ['Electronic'] }),
  jazz: moodTags({ genres: ['Smooth jazz'] }),
  rock: moodTags({ genres: ['Rock'] }),
};
type G = keyof typeof TAGS;
const genreOf = (key: string) => (Object.keys(TAGS) as G[]).find((g) => key.startsWith(g))!;
const cand = (key: string): MoodCandidate => ({ key, tags: TAGS[genreOf(key)], vector: null });
const sig = (key: string, kind: MoodSignal['kind'], ts: number): MoodSignal => ({ ...cand(key), kind, ts, listened: 200, duration: 200 });
const genres = (keys: string[]) => keys.map(genreOf);

// A rap-leaning listener: two starred rap songs, a starred electronic one, rap now playing.
const railSignals = (): MoodSignal[] => [sig('hiphop90', 'like', NOW - 600), sig('electronic91', 'like', NOW - 300), { ...cand('hiphop92'), kind: 'current', ts: NOW, listened: 0, duration: 200 }];
// A passive rap listener: songs played through, nothing starred (option 1's case).
const passiveSignals = (): MoodSignal[] => Array.from({ length: 8 }, (_, i) => ({ ...cand(`hiphop${80 + i}`), kind: 'complete' as const, ts: NOW - 60 * (i + 1), listened: 200, duration: 200 }));

// The option 2 grouped queue: the planner's top 12 (protected), then a rap block, then the rest.
const grouped = (): MoodCandidate[] => [
  ...Array.from({ length: 12 }, (_, i) => cand(`${['jazz', 'rock', 'electronic'][i % 3]}${i}`)),
  ...Array.from({ length: 8 }, (_, i) => cand(`hiphop${i}`)),
  ...Array.from({ length: 4 }, (_, i) => cand(`electronic${i + 12}`)),
  ...Array.from({ length: 4 }, (_, i) => cand(`jazz${i + 12}`)),
  ...Array.from({ length: 4 }, (_, i) => cand(`rock${i + 12}`)),
];
// A queue whose head does not fit a rap listener, with rap two places down (option 1's lead case).
const leadQueue = (): MoodCandidate[] => [cand('jazz0'), cand('rock1'), cand('hiphop0'), cand('hiphop1'), cand('electronic2'), cand('jazz3'), cand('rock4'), cand('hiphop2'), cand('electronic5'), cand('jazz6'), cand('rock7'), cand('electronic8'), cand('jazz9'), cand('rock10')];

const run = (upcoming: MoodCandidate[], signals: MoodSignal[], lead: boolean, runLimit: number) =>
  moodOrder(upcoming, buildMood(signals, NOW, { plan: 'v2' }), 0.5, { version: 'v2', shown: upcoming.map((c) => c.key), lead, runLimit });
const movedCount = (upcoming: MoodCandidate[], order: string[]) => order.filter((k, j) => upcoming[j]!.key !== k).length;

describe('queue controls: the two settings together', () => {
  const fixtures: [string, () => MoodCandidate[], () => MoodSignal[]][] = [
    ['grouped queue, rap listener', grouped, railSignals],
    ['grouped queue, passive rap listener', grouped, passiveSignals],
    ['lead queue, passive rap listener', leadQueue, passiveSignals],
  ];
  for (const [name, make, signals] of fixtures) {
    for (const lead of [false, true]) {
      for (const runLimit of [0, 3, 5, 8]) {
        it(`${name}: lead ${lead ? 'on' : 'off'}, run limit ${runLimit || 'off'}: keys kept, at most 80 rows moved, top 12 as the lead leaves them`, () => {
          const upcoming = make();
          const order = run(upcoming, signals(), lead, runLimit).order;
          expect([...order].sort()).toEqual(upcoming.map((c) => c.key).sort());
          expect(movedCount(upcoming, order)).toBeLessThanOrEqual(80);
          const noCap = run(upcoming, signals(), lead, 0).order;
          expect(order.slice(0, 12)).toEqual(noCap.slice(0, 12));
          if (runLimit > 0) expect(longestRun(genres(order.slice(12)))).toBeLessThanOrEqual(runLimit);
        });
      }
    }
  }

  it('the lead runs first: with both on, a lead move inside the top 12 is kept when the cap does not need it', () => {
    const upcoming = leadQueue();
    const leadOnly = run(upcoming, passiveSignals(), true, 0).order;
    expect(leadOnly[0]).not.toBe('jazz0');
    expect(leadOnly.slice(0, 12)).toEqual(run(upcoming, passiveSignals(), true, 5).order.slice(0, 12));
  });

  it('a queue shorter than 13 rows is not capped (the cap starts at row 13)', () => {
    const short = Array.from({ length: 10 }, (_, i) => cand(`hiphop${i}`));
    expect(run(short, railSignals(), false, 3).order).toEqual(short.map((c) => c.key));
  });

  it('a cap-only move is not a mood move: no mood note for it', () => {
    const upcoming = grouped();
    const plan = run(upcoming, [], false, 5);
    expect(plan.changed).toBe(true);
    expect(plan.mood).toBeFalsy();
  });

  it('a lead move is a mood move', () => {
    const plan = run(leadQueue(), passiveSignals(), true, 0);
    expect(plan.changed).toBe(true);
    expect(plan.mood).toBe(true);
  });
});

describe('mood flag under the v1 plan', () => {
  it('a v1 re-plan that moves rows is a mood move', () => {
    const upcoming = leadQueue();
    const plan = moodOrder(upcoming, buildMood(passiveSignals(), NOW, { plan: 'v1' }), 0.5, { version: 'v1', shown: upcoming.map((c) => c.key), lead: false, runLimit: 0 });
    if (plan.changed) expect(plan.mood).toBe(true);
    expect(plan.mood ?? false).toBe(plan.changed);
  });
});
