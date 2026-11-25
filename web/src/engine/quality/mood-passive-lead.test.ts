/**
 * Option 1 (branch claude/jplay-0.20.18-mood-follow): a confident PASSIVE session (finished songs and the song
 * playing, no like / similar / replay) may lead the queue with songs that fit its mood. A queue whose head already
 * fits is not reordered, so a blocked-shape queue that has nothing left to gain stays as it is.
 */
import { describe, expect, it } from 'vitest';
import { DIM } from '../audio';
import { buildMood, moodMatch, moodOrder, moodTags, type MoodCandidate, type MoodSignal, type MoodTags } from '../mood-queue';

const NOW = 1_800_000_000;
const TAGS: Record<'rap' | 'electronic', MoodTags> = {
  rap: moodTags({ genres: ['Rap'] }),
  electronic: moodTags({ genres: ['Electronic'] }),
};
const AXIS = { rap: 1, electronic: 2 } as const;
const vec = (axis: number) => { const v = new Float32Array(DIM); v[axis] = 1; return v; };
const genreOf = (key: string): 'rap' | 'electronic' => (key.startsWith('rap') ? 'rap' : 'electronic');
const cand = (key: string): MoodCandidate => ({ key, tags: TAGS[genreOf(key)], vector: vec(AXIS[genreOf(key)]) });
const played = (key: string, ts: number, kind: MoodSignal['kind'] = 'complete'): MoodSignal =>
  ({ ...cand(key), kind, ts, listened: 200, duration: 200 });

/** Off-mood head (three electronic), then rap songs that fit a listener who has been playing rap. */
const upcoming = [
  ...['electronic0', 'electronic1', 'electronic2'].map(cand),
  ...Array.from({ length: 9 }, (_, i) => cand(`rap${i + 10}`)),
];

/** `n` finished rap songs in the last few minutes, then the rap song currently playing (second 0). */
function passiveSignals(n: number): MoodSignal[] {
  const done = Array.from({ length: n }, (_, i) => played(`rap${i}`, NOW - (n - i) * 200));
  return [...done, { ...cand('rap99'), kind: 'current', ts: NOW, listened: 0, duration: 200 }];
}

const threshold = 0.5; // 0.65 - 0.3 * adventurous(0.5)

describe('option 1: a confident passive session may lead the queue', () => {
  it('leads with the songs that fit the mood when the head does not fit (red before the gate fix)', () => {
    const mood = buildMood(passiveSignals(8), NOW, { plan: 'v2' });
    expect(mood.confidence).toBeGreaterThanOrEqual(0.5);
    expect(mood.active ?? 0).toBe(0);
    expect(mood.leading).toContain('Rap');

    const plan = moodOrder(upcoming, mood, 0.5, { shown: upcoming.map((c) => c.key) });
    const fitsAt = (keys: string[]) => keys.filter((k) => (moodMatch(cand(k), mood).m ?? 0) >= threshold).length;
    expect(plan.changed).toBe(true);
    expect(fitsAt(plan.order.slice(0, 3))).toBeGreaterThan(fitsAt(upcoming.slice(0, 3).map((c) => c.key)));
  });

  it('a passive session below the confidence bar keeps its order (control)', () => {
    const mood = buildMood(passiveSignals(1), NOW, { plan: 'v2' });
    expect(mood.confidence).toBeLessThan(0.5);
    const plan = moodOrder(upcoming, mood, 0.5, { shown: upcoming.map((c) => c.key) });
    expect(plan.changed).toBe(false);
    expect(plan.order).toEqual(upcoming.map((c) => c.key));
  });

  it('a queue whose head already fits is not reordered by a passive session', () => {
    const fitting = Array.from({ length: 12 }, (_, i) => cand(`rap${i + 10}`));
    const mood = buildMood(passiveSignals(8), NOW, { plan: 'v2' });
    const plan = moodOrder(fitting, mood, 0.5, { shown: fitting.map((c) => c.key) });
    expect(plan.changed).toBe(false);
    expect(plan.order).toEqual(fitting.map((c) => c.key));
  });
});
