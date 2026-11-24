import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDiscovery, LISTENING_LOW_WATER, needsListeningDiscovery, newDiscoveryTracks } from './discovery';

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
  // QUEUE-KEEP-DISCOVER-001 (owner, 2026-11-20): "ensure the discover now playing queue keeps finding new songs".
  // A skip is listening too (skipping through a queue used to never top it up), and topping up starts at five songs
  // left so a discovery run (30-60 s) finishes before the queue runs dry.
  it('tops up after a finished or skipped song once five or fewer songs are left', () => {
    expect(LISTENING_LOW_WATER).toBe(5);
    for (const kind of ['complete', 'skip']) {
      expect(needsListeningDiscovery(true, kind, true, 5)).toBe(true);
      expect(needsListeningDiscovery(true, kind, true, 0)).toBe(true);
      expect(needsListeningDiscovery(true, kind, true, 6)).toBe(false);
      expect(needsListeningDiscovery(false, kind, true, 0)).toBe(false);
      expect(needsListeningDiscovery(true, kind, false, 0)).toBe(false);
    }
    for (const kind of ['replay', 'pause', 'seek', 'like'])
      expect(needsListeningDiscovery(true, kind, true, 0)).toBe(false);
  });
  it('the page asks after a skip as well as after a finished song', () => {
    const app = readFileSync(resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
    // WP3 (A3): a Next press mid-song (partial) asks as well.
    expect(app).toMatch(/if \(sample \|\| !result \|\| \(kind !== 'complete' && kind !== 'skip' && kind !== 'partial'\)\) return;/);
  });
});
