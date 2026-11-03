import { describe, expect, it } from 'vitest';
import { appendDiscovery, needsListeningDiscovery, newDiscoveryTracks } from './discovery';

const track = (key: string) => ({ key, title: key, artists: [key], duration: 180 });
const item = (key: string) => ({ track: track(key), rank: 1 });

describe('DISCOVERY-001: one maximum for each search or listening batch', () => {
  it('keeps every existing song when the limit is reduced; adds at most the new limit', () => {
    const old = Array.from({ length: 30 }, (_, i) => item(`old-${i}`));
    const incoming = Array.from({ length: 20 }, (_, i) => item(`new-${i}`));
    const next = appendDiscovery(old, incoming, 5);
    expect(next).toHaveLength(35);
    expect(next.slice(0, 30).map((x) => x.track.key)).toEqual(old.map((x) => x.track.key));
    expect(next.map((x) => x.rank)).toEqual(Array.from({ length: 35 }, (_, i) => i + 1));
    expect(old[0]?.rank).toBe(1);
  });
  it('does not spend a slot on a duplicate or the same recording from another provider', () => {
    const old = track('old');
    const alias = { ...old, key: 'alias', isrc: 'US1234567890' };
    const withIsrc = { ...old, isrc: 'US1234567890' };
    expect(
      newDiscoveryTracks([old, alias, track('new'), track('new')], [withIsrc]).map((t) => t.key),
    ).toEqual(['new']);
    expect(
      appendDiscovery([item('old')], [item('old'), item('a'), item('a'), item('b')], 2).map(
        (x) => x.track.key,
      ),
    ).toEqual(['old', 'a', 'b']);
  });
  it('returns fewer if there are fewer unique matches; empty answers preserve the list', () => {
    expect(appendDiscovery([item('old')], [item('a')], 60)).toHaveLength(2);
    expect(appendDiscovery([item('old')], [], 5)).toEqual([item('old')]);
  });
  it('only tops up after list completion and at the low-water mark', () => {
    expect(needsListeningDiscovery(true, 'complete', true, 3)).toBe(true);
    expect(needsListeningDiscovery(true, 'complete', true, 0)).toBe(true);
    expect(needsListeningDiscovery(true, 'complete', true, 4)).toBe(false);
    expect(needsListeningDiscovery(false, 'complete', true, 0)).toBe(false);
    expect(needsListeningDiscovery(true, 'complete', false, 0)).toBe(false);
    for (const kind of ['skip', 'replay', 'pause', 'seek', 'like'])
      expect(needsListeningDiscovery(true, kind, true, 0)).toBe(false);
  });
});
