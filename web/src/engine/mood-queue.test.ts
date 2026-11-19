import { describe, expect, it } from 'vitest';
import { DIM } from './audio';
import { buildMood, moodMatch, moodOrder, moodTags, signalWeight, type MoodCandidate, type MoodSignal } from './mood-queue';

const NOW = 1_800_000_000;
/** A unit vector pointing mostly along one axis: songs on one axis "sound alike". */
const vec = (axis: number, noise = 0) => { const v = new Float32Array(DIM); v[axis] = 1; if (noise) v[(axis + 7) % DIM] = noise; return v; };
const RAP = moodTags({ genres: ['Rap'], subgenre: null });
const ELEC = moodTags({ genres: ['Electronic'] });
const JAZZ = moodTags({ genres: ['Smooth jazz'] });
const sig = (key: string, kind: MoodSignal['kind'], tags = RAP, agoS = 60, vector: Float32Array | null = null, extra: Partial<MoodSignal> = {}): MoodSignal => ({ key, kind, ts: NOW - agoS, tags, vector, ...extra });
const cand = (key: string, tags: MoodCandidate['tags'], vector: Float32Array | null = null): MoodCandidate => ({ key, tags, vector });

describe('mood tags', () => {
  it('rap and hip hop share one broad genre; smooth jazz is jazz, not rap', () => {
    const hiphop = moodTags({ genres: ['Hip Hop'] });
    expect(RAP.mains.length).toBeGreaterThan(0);
    expect(hiphop.mains).toEqual(RAP.mains);
    expect(JAZZ.mains.some((m) => RAP.mains.includes(m))).toBe(false);
    expect(ELEC.mains.some((m) => RAP.mains.includes(m))).toBe(false);
  });
});

describe('signal weights', () => {
  it('star and find-similar count more than a finished song; an early skip counts against, a late one not at all', () => {
    expect(signalWeight({ kind: 'similar' })).toBeGreaterThan(signalWeight({ kind: 'like' }));
    expect(signalWeight({ kind: 'like' })).toBeGreaterThan(signalWeight({ kind: 'complete' }));
    expect(signalWeight({ kind: 'skip', listened: 8, duration: 200 })).toBeLessThan(0);
    expect(signalWeight({ kind: 'skip', listened: 120, duration: 200 })).toBe(0);
    expect(signalWeight({ kind: 'dislike' })).toBeLessThan(0);
  });
});

describe('the queue follows the listening mood', () => {
  // Listening to rap and electronic music.
  const listening = [sig('r1', 'complete', RAP, 600, vec(1)), sig('e1', 'complete', ELEC, 400, vec(2)), sig('r2', 'complete', RAP, 200, vec(1, 0.1))];
  // The engine's order puts smooth jazz next.
  const upcoming = [cand('jazz1', JAZZ, vec(9)), cand('jazz2', JAZZ, vec(9, 0.2)), cand('pop', moodTags({ genres: ['Pop'] }), vec(5)), cand('rap3', RAP, vec(1, 0.2)), cand('elec2', ELEC, vec(2, 0.1)), cand('rap4', RAP, null)];

  it('does not queue smooth jazz next after rap and electronic', () => {
    const mood = buildMood(listening, NOW);
    const plan = moodOrder(upcoming, mood, 0.2);
    expect(plan.changed).toBe(true);
    expect(mood.leading).toEqual(['Rap', 'Electronic']);
    expect(plan.order.slice(0, 3).sort()).toEqual(['elec2', 'rap3', 'rap4']);
    expect(plan.order.indexOf('jazz1')).toBeGreaterThan(2);
    // Nothing is lost or duplicated.
    expect([...plan.order].sort()).toEqual(upcoming.map((c) => c.key).sort());
  });

  it('a song with no measured sound is judged by its genres, not treated as a bad match', () => {
    const mood = buildMood(listening, NOW);
    const withSound = moodMatch(cand('x', RAP, vec(1)), mood).m!;
    const without = moodMatch(cand('y', RAP, null), mood).m!;
    expect(without).toBeGreaterThan(0.6);
    expect(Math.abs(withSound - without)).toBeLessThan(0.35);
    expect(moodMatch(cand('z', { mains: [], subs: [] }, null), mood).m).toBeNull();
  });

  it('Familiar holds the mood more tightly than Adventurous', () => {
    const mood = buildMood(listening.slice(0, 1), NOW); // a weak mood: one finished song
    const displaced = (a: number) => moodOrder(upcoming, mood, a, { minGain: -1 }).order.reduce((t, k, j) => t + Math.abs(j - upcoming.findIndex((c) => c.key === k)), 0);
    expect(displaced(0)).toBeGreaterThan(displaced(1));
  });

  it('starring a song pulls songs that sound like it forward more than finishing one does', () => {
    const base = [cand('a', JAZZ, vec(9)), cand('b', JAZZ, vec(9, 0.1)), cand('c', ELEC, vec(3)), cand('d', ELEC, vec(3, 0.1))];
    const finished = moodOrder(base, buildMood([sig('s', 'complete', ELEC, 60, vec(3))], NOW), 0.5, { minGain: -1 });
    const starred = moodOrder(base, buildMood([sig('s', 'like', ELEC, 60, vec(3))], NOW), 0.5, { minGain: -1 });
    const similar = moodOrder(base, buildMood([sig('s', 'similar', ELEC, 60, vec(3))], NOW), 0.5, { minGain: -1 });
    const rankOfC = (p: { order: string[] }) => p.order.indexOf('c');
    expect(rankOfC(starred)).toBeLessThanOrEqual(rankOfC(finished));
    expect(rankOfC(similar)).toBe(0);
    expect(buildMood([sig('s', 'similar', ELEC)], NOW).confidence).toBeGreaterThan(buildMood([sig('s', 'complete', ELEC)], NOW).confidence);
  });

  it('a dislike pushes that kind of song back even with no other listening', () => {
    const mood = buildMood([sig('j', 'dislike', JAZZ, 30, vec(9))], NOW);
    const plan = moodOrder(upcoming, mood, 0.5);
    expect(plan.changed).toBe(true);
    expect(plan.order.indexOf('jazz1')).toBeGreaterThan(1);
    expect(plan.order.indexOf('jazz2')).toBeGreaterThan(1);
  });

  it('old listening fades: a mood from two hours ago changes nothing', () => {
    const old = buildMood(listening.map((s) => ({ ...s, ts: NOW - 2 * 3600 })), NOW);
    expect(old.pos.weight).toBe(0);
    expect(moodOrder(upcoming, old, 0.2).changed).toBe(false);
  });

  it('no churn: an order already fitting the mood is left alone, and pressing star twice is one signal', () => {
    const mood = buildMood(listening, NOW);
    const first = moodOrder(upcoming, mood, 0.2);
    const again = moodOrder(first.order.map((k) => upcoming.find((c) => c.key === k)!), mood, 0.2);
    expect(again.changed).toBe(false);
    const twice = buildMood([sig('s', 'like', ELEC, 20), sig('s', 'like', ELEC, 10)], NOW);
    const once = buildMood([sig('s', 'like', ELEC, 10)], NOW);
    expect(twice.pos.weight).toBeCloseTo(once.pos.weight, 5);
  });

  it('a re-rank that only reshuffles the engine order keeps what the listener sees when the new plan is no better', () => {
    const mood = buildMood(listening, NOW);
    const first = moodOrder(upcoming, mood, 0.2);
    // The engine answers again with a slightly different order of the same songs.
    const engine = [upcoming[1]!, upcoming[0]!, ...upcoming.slice(2)];
    const next = moodOrder(engine, mood, 0.2, { shown: first.order });
    expect(next.changed).toBe(false);
    expect(next.order).toEqual(first.order);
  });

  it('only the next 12 songs are planned; songs past them keep the engine order', () => {
    const many = Array.from({ length: 30 }, (_, i) => cand(`j${i}`, JAZZ, vec(9)));
    many.push(cand('r', RAP, vec(1)));
    const plan = moodOrder(many, buildMood(listening, NOW), 0.2);
    expect(plan.order[0]).toBe('r');
    const tail = plan.order.slice(12);
    expect(tail).toEqual(many.map((c) => c.key).filter((k) => !plan.order.slice(0, 12).includes(k)));
  });
});
