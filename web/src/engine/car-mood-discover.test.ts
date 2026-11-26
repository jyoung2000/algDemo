import { describe, expect, it } from 'vitest';
import type { Track } from '../api';
import { carMoodDiscoverText, runCarMoodDiscover } from './car-mood-discover';

const tr = (key: string): Track => ({ key, title: key, artists: ['A'] } as unknown as Track);

describe('MOOD-DEFAULT-CAR-001 car "Discover for my mood"', () => {
  it('runs one ordinary Discover run and returns only the songs the queue did not hold', async () => {
    let calls = 0;
    let last = { items: [tr('a'), tr('b')].map((track) => ({ track })) };
    const polls: string[] = [];
    const out = await runCarMoodDiscover({
      recommend: async () => { calls++; return { job: 'j1', mood: ['Chill', 'R&B', 'Late night', 'extra'] }; },
      job: async (id) => { polls.push(id); if (polls.length < 2) return { done: false }; last = { items: [tr('a'), tr('b'), tr('c'), tr('d')].map((track) => ({ track })) }; return { done: true }; },
      last: async () => last,
      song: (t) => t.key,
      wait: async () => undefined,
    });
    expect(calls).toBe(1);
    expect(out.songs).toEqual(['c', 'd']);
    expect(out.added).toBe(2);
    expect(out.leading).toEqual(['Chill', 'R&B', 'Late night']);
    expect(carMoodDiscoverText(out)).toBe('Added 2 new songs for your mood (Chill · R&B · Late night).');
  });

  it('says why when nothing new was found or the run could not start', async () => {
    const none = await runCarMoodDiscover({
      recommend: async () => ({ job: 'j' }), job: async () => ({ done: true }),
      last: async () => ({ items: [{ track: tr('a') }] }), song: (t) => t.key, wait: async () => undefined,
    });
    expect(none.added).toBe(0);
    expect(carMoodDiscoverText(none)).toMatch(/No new songs/);
    const refused = await runCarMoodDiscover({
      recommend: async () => ({ job: null, reason: 'Daily data allowance reached.' }), job: async () => ({ done: true }),
      last: async () => null, song: (t) => t.key, wait: async () => undefined,
    });
    expect(refused.reason).toBe('Daily data allowance reached.');
  });

  it('passes a failed run on as an error', async () => {
    await expect(runCarMoodDiscover({
      recommend: async () => ({ job: 'j' }), job: async () => ({ done: true, error: 'offline' }),
      last: async () => null, song: (t) => t.key, wait: async () => undefined,
    })).rejects.toThrow('offline');
  });
});
