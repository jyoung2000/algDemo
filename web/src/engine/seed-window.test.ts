import { describe, expect, it } from 'vitest';
import { SEED_GATHER_MAX, seedWindow } from './seed-window';

const s = (n: number) => ({ key: `k${n}` });

describe('seedWindow (PLAYLIST-QUEUE-001)', () => {
  it('asks the services about every starting song when there are few', () => {
    const all = [1, 2, 3].map(s);
    expect(seedWindow(all, 0)).toEqual({ window: all, next: 0 });
  });

  it('asks about a bounded window of a long list, and walks the whole list over successive runs', () => {
    const all = Array.from({ length: 20 }, (_, i) => s(i));
    const seen = new Set<string>();
    let cursor = 0;
    for (let run = 0; run < 3; run++) {
      const w = seedWindow(all, cursor);
      expect(w.window).toHaveLength(SEED_GATHER_MAX);
      w.window.forEach((x) => seen.add(x.key));
      cursor = w.next;
    }
    expect(seen.size).toBe(20);
  });

  it('keeps a pinned first song (the one just heard) in every window', () => {
    const all = Array.from({ length: 20 }, (_, i) => s(i));
    for (const c of [0, 5, 19]) {
      const w = seedWindow(all, c, 1);
      expect(w.window[0]).toBe(all[0]);
      expect(w.window).toHaveLength(SEED_GATHER_MAX);
      expect(new Set(w.window.map((x) => x.key)).size).toBe(SEED_GATHER_MAX);
    }
  });

  it('survives a cursor past the end (the list shrank since the last run)', () => {
    const all = Array.from({ length: 10 }, (_, i) => s(i));
    expect(seedWindow(all, 57).window).toHaveLength(SEED_GATHER_MAX);
  });
});
