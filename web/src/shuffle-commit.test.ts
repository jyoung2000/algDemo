import { beforeEach, expect, it } from 'vitest';
import { resetShuffleNextForTests, stepQueue } from './util';
import type { RecItem } from './api';
const rows = ['a', 'b', 'c'].map(key => ({ track: { key }, playback: { preview: '/fixture', embed: null } } as unknown as RecItem));
beforeEach(resetShuffleNextForTests);
it('commits the next-round pick just like an ordinary up-next pick', () => {
  const heard = new Set(['a', 'b', 'c']);
  const opts = { shuffle: true, repeat: 'all' as const, heard };
  const announced = stepQueue(rows, 'c', 1, new Set(), { ...opts, rand: () => 0 });
  expect(announced?.wrapped).toBe(true);
  expect(stepQueue(rows, 'c', 1, new Set(), { ...opts, rand: () => 0.99 })).toEqual(announced);
});
it('a newly ready unheard song takes precedence over a proposed new round', () => {
  const heard = new Set(['a', 'b']); const ready = new Set(['a', 'b']);
  const opts = { shuffle: true, repeat: 'all' as const, heard, ready: (t: { key: string }) => ready.has(t.key), rand: () => 0 };
  expect(stepQueue(rows, 'b', 1, new Set(), opts)?.wrapped).toBe(true);
  ready.add('c');
  expect(stepQueue(rows, 'b', 1, new Set(), opts)).toMatchObject({ item: { track: { key: 'c' } }, wrapped: false });
});
