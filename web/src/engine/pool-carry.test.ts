// WP2 (plan 2026-11-24, A2): a carried queue row keeps its raw evidence after a top-up.
import { describe, expect, it } from 'vitest';
import { carryPool, unionRelated, unionSeeds } from './pool-carry';

const raw = (key: string) => ({ key, title: key, provenance: [{ source: 'deezer_related' }], dz_id: 7, links: { deezer: 'x' } });
const clean = (key: string) => ({ key, title: key });

describe('carryPool (WP2, A2)', () => {
  it('a carried row keeps provenance, dz_id and links from the old pool', () => {
    const { cands } = carryPool([{ track: clean('a') }], [raw('a')], ['n'], [raw('n')], ['n']);
    expect(cands.map((c) => c['key'])).toEqual(['a', 'n']);
    expect(cands[0]).toMatchObject({ provenance: [{ source: 'deezer_related' }], dz_id: 7, links: { deezer: 'x' } });
  });
  it('falls back to the cleaned track when the old pool has no row', () => {
    expect(carryPool([{ track: clean('a') }], [], [], [], [])).toEqual({ cands: [clean('a')], bench: [] });
  });
  it('non-chosen candidates go to a bench (best first, capped), not into the pool', () => {
    const cands = ['n', 'b1', 'b2', 'b3'].map(raw);
    const out = carryPool([{ track: clean('a') }], [raw('a')], ['n'], cands, ['b2', 'n', 'b3', 'b1'], 2);
    expect(out.cands.map((c) => c['key'])).toEqual(['a', 'n']);
    expect(out.bench.map((c) => c['key'])).toEqual(['b2', 'b3']);
  });
  it('no duplicates when a chosen row is already queued', () => {
    expect(carryPool([{ track: clean('a') }], [raw('a')], ['a'], [raw('a')], ['a']).cands).toHaveLength(1);
  });
});

describe('union across runs (WP2)', () => {
  it('related artists per seed key are unioned', () => {
    const u = unionRelated(new Map([['s1', new Set(['x'])]]), new Map([['s1', new Set(['y'])], ['s0', new Set(['z'])]]));
    expect([...u.get('s1')!].sort()).toEqual(['x', 'y']);
    expect([...u.get('s0')!]).toEqual(['z']);
  });
  it('seeds are unioned newest first, at most 40', () => {
    const older = Array.from({ length: 50 }, (_, i) => ({ key: `o${i}` }));
    const out = unionSeeds([{ key: 'n' }, { key: 'o0' }], older);
    expect(out).toHaveLength(40);
    expect(out[0]!.key).toBe('n');
    expect(out.filter((s) => s.key === 'o0')).toHaveLength(1);
  });
});
