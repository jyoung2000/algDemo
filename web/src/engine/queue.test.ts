import { describe, expect, it } from 'vitest';
import type { Playback, RecItem, Track } from '../api';
import { ListeningQueue, QueueError } from './queue';

const tr = (key: string) => ({ key, provider: 'deezer', platform_id: key, title: key, artists: ['A'] }) as unknown as Track;
const pb = () => ({ open: [], preview: null, embed: null }) as Playback;
const rec = (rank: number) => ({ rank }) as unknown as RecItem;
const keys = (q: ListeningQueue) => q.entries.map((e) => e.track.key);
const thrown = (fn: () => void): QueueError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof QueueError) return e;
    throw e;
  }
  throw new Error('expected QueueError');
};

describe('ListeningQueue', () => {
  it('puts searched after searched and keeps discovered below', () => {
    const q = new ListeningQueue();
    q.addSearched(tr('s1'), pb());
    q.appendDiscovered(tr('d1'), pb(), rec(1));
    q.addSearched(tr('s2'), pb());
    expect(keys(q)).toEqual(['s1', 's2', 'd1']);
    expect(q.entries.map((e) => e.source)).toEqual(['searched', 'searched', 'discovered']);
  });

  it('dedupes by recording key', () => {
    const q = new ListeningQueue();
    q.addSearched(tr('x'), pb());
    expect(thrown(() => q.addSearched(tr('x'), pb())).status).toBe(409);
    expect(q.appendDiscovered(tr('x'), pb(), rec(1))).toBeNull();
    expect(keys(q)).toEqual(['x']);
  });

  it('walks the played order with next/previous, not the list position', () => {
    const q = new ListeningQueue();
    for (const k of ['a', 'b', 'c']) q.addSearched(tr(k), pb());
    q.next();
    expect(q.find(q.current!)!.track.key).toBe('a');
    q.next();
    q.next();
    expect(q.find(q.current!)!.track.key).toBe('c');
    q.previous();
    expect(q.find(q.current!)!.track.key).toBe('b');
    q.previous();
    expect(q.find(q.current!)!.track.key).toBe('a');
    expect(thrown(() => q.previous()).status).toBe(409);
  });

  it('play jumps and previous returns to where you were', () => {
    const q = new ListeningQueue();
    const ids = ['a', 'b', 'c'].map((k) => q.addSearched(tr(k), pb()).id);
    q.play(ids[0]!);
    q.play(ids[2]!);
    q.previous();
    expect(q.current).toBe(ids[0]);
  });

  it('next at the end clears current and keeps history', () => {
    const q = new ListeningQueue();
    const ids = ['a', 'b'].map((k) => q.addSearched(tr(k), pb()).id);
    q.play(ids[1]!);
    q.next();
    expect(q.current).toBeNull();
    expect(q.history).toEqual([ids[1]]);
  });

  it('appends discovered songs while playing without moving current', () => {
    const q = new ListeningQueue();
    const a = q.addSearched(tr('a'), pb());
    q.play(a.id);
    q.appendDiscovered(tr('d1'), pb(), rec(1));
    q.appendDiscovered(tr('d2'), pb(), rec(2));
    expect(q.current).toBe(a.id);
    expect(keys(q)).toEqual(['a', 'd1', 'd2']);
  });

  it('removing the playing song moves to the next and drops it from history', () => {
    const q = new ListeningQueue();
    const ids = ['a', 'b', 'c'].map((k) => q.addSearched(tr(k), pb()).id);
    q.play(ids[0]!);
    q.play(ids[1]!);
    q.remove(ids[1]!);
    expect(q.current).toBe(ids[2]);
    expect(q.history).toEqual([ids[0]]);
  });

  it('previous skips songs removed since they played', () => {
    const q = new ListeningQueue();
    const ids = ['a', 'b', 'c'].map((k) => q.addSearched(tr(k), pb()).id);
    q.play(ids[0]!);
    q.play(ids[1]!);
    q.play(ids[2]!);
    q.remove(ids[1]!);
    q.previous();
    expect(q.current).toBe(ids[0]);
  });

  it('bumps version and notifies subscribers', () => {
    const q = new ListeningQueue();
    const seen: number[] = [];
    const off = q.subscribe((s) => seen.push(s.version));
    const v0 = q.version;
    q.addSearched(tr('a'), pb());
    expect(q.version).toBeGreaterThan(v0);
    off();
    q.addSearched(tr('b'), pb());
    expect(seen).toEqual([0, 1]);
  });

  it('restores order and drops dangling references', () => {
    const q = new ListeningQueue();
    const a = q.addSearched(tr('a'), pb());
    q.appendDiscovered(tr('b'), pb(), rec(1));
    const snap = q.snapshotForStore();
    snap.current = 'gone';
    snap.history = [a.id, 'gone'];
    const r = new ListeningQueue(snap);
    expect(keys(r)).toEqual(['a', 'b']);
    expect(r.current).toBeNull();
    expect(r.history).toEqual([a.id]);
    expect(r.entries[1]!.source).toBe('discovered');
    expect(r.savedAt).not.toBeNull();
  });

  it('ignores malformed saved entries', () => {
    const bad = [{ id: 'x', source: 'weird', track: {} }, { id: 'y', source: 'searched' }, 'junk'] as never;
    expect(new ListeningQueue({ entries: bad }).entries).toEqual([]);
  });
});
