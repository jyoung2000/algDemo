import { describe, expect, it } from 'vitest';
import { addNewCandidates } from './local-api';

const c = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, ...extra });

describe('addNewCandidates: learning widens the pool without repeating it', () => {
  it('adds only the songs the pool does not hold, in their original order', () => {
    const pool = [c('a'), c('b')];
    const added = addNewCandidates(pool, [c('b'), c('c'), c('a'), c('d')]);
    expect(added.map((x) => x['key'])).toEqual(['c', 'd']);
  });

  it('adds nothing when every incoming song is already in the pool', () => {
    expect(addNewCandidates([c('a')], [c('a')])).toEqual([]);
  });

  it('keeps one copy of a song that the incoming list repeats', () => {
    expect(addNewCandidates([], [c('x'), c('x'), c('y')]).map((x) => x['key'])).toEqual(['x', 'y']);
  });

  it('does not change the pool it reads from', () => {
    const pool = [c('a')];
    addNewCandidates(pool, [c('b')]);
    expect(pool.map((x) => x['key'])).toEqual(['a']);
  });
});
