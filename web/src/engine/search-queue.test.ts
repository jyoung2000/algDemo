import { describe, expect, it } from 'vitest';
import type { PlaylistSummary, SavedItem, Track } from '../api';
import { addTargetOf, addedRow, contextRows, insertAfter, SEARCH_CONTEXT } from './queue-context';
import { mergeRerank, stepQueue } from '../util';

/**
 * SEARCH-QUEUE-001: songs played from the search list step like their own playlist, and the search
 * row's add button puts a song into whatever the listener is listening to (QUEUE-ADD-001).
 */
const t = (k: string): Track => ({ key: k, title: k.toUpperCase(), artist: 'X', artists: ['X'], provider: 'ytmusic', platform_id: k } as Track);
const opts = { shuffle: false, repeat: 'off' as const, heard: new Set<string>() };

describe('contextRows', () => {
  const queue = [addedRow(t('q1')), addedRow(t('q2'))];
  const saved = [{ track: t('s1') }, { track: t('s2') }] as SavedItem[];
  const lists = [{ id: 'L1', name: 'Late night', items: [{ key: 's2' }, { key: 's1' }] }] as unknown as PlaylistSummary[];

  it('is the now playing queue with no context, a saved list in its own order, and the search results in theirs', () => {
    const search = [t('a'), t('b'), t('c')];
    expect(contextRows(null, { queueRows: queue, search, saved, lists }).map((x) => x.track.key)).toEqual(['q1', 'q2']);
    expect(contextRows('L1', { queueRows: queue, search, saved, lists }).map((x) => x.track.key)).toEqual(['s2', 's1']);
    expect(contextRows(SEARCH_CONTEXT, { queueRows: queue, search, saved, lists }).map((x) => x.track.key)).toEqual(['a', 'b', 'c']);
  });

  it('lets the skip buttons walk the search results forward and back like a playlist', () => {
    const rows = contextRows(SEARCH_CONTEXT, { queueRows: queue, search: [t('a'), t('b'), t('c')], saved, lists });
    expect(stepQueue(rows, 'a', 1, new Set(), opts)?.item.track.key).toBe('b');
    expect(stepQueue(rows, 'b', 1, new Set(), opts)?.item.track.key).toBe('c');
    expect(stepQueue(rows, 'c', -1, new Set(), opts)?.item.track.key).toBe('b');
    expect(stepQueue(rows, 'c', 1, new Set(), opts)).toBeNull();
  });
});

describe('the add button', () => {
  const lists = [{ id: 'L1', name: 'Late night', items: [] }] as unknown as PlaylistSummary[];

  it('adds to the saved list being played from, to the list in the queue, or else to the now playing queue', () => {
    expect(addTargetOf('L1', null, lists)).toEqual({ kind: 'list', id: 'L1', name: 'Late night', seed: false });
    expect(addTargetOf(null, { id: 'L1', name: 'Late night' }, lists)).toEqual({ kind: 'list', id: 'L1', name: 'Late night', seed: true });
    expect(addTargetOf(null, null, lists)).toEqual({ kind: 'queue' });
    expect(addTargetOf(SEARCH_CONTEXT, null, lists)).toEqual({ kind: 'queue' });
    // "All saved" is not one list; a song added while playing it goes to the queue.
    expect(addTargetOf('all', null, lists)).toEqual({ kind: 'queue' });
    // A list deleted while it played falls back to the queue.
    expect(addTargetOf('gone', null, lists)).toEqual({ kind: 'queue' });
  });

  it('puts the added song next, after the song playing, and moves it there when it is already queued', () => {
    const items = ['a', 'b', 'c'].map((k) => addedRow(t(k)));
    expect(insertAfter(items, addedRow(t('n')), 'a').map((x) => x.track.key)).toEqual(['a', 'n', 'b', 'c']);
    expect(insertAfter(items, addedRow(t('c')), 'a').map((x) => x.track.key)).toEqual(['a', 'c', 'b']);
    // Nothing playing from the queue: it goes to the top.
    expect(insertAfter(items, addedRow(t('n')), null).map((x) => x.track.key)).toEqual(['n', 'a', 'b', 'c']);
    expect(insertAfter(items, addedRow(t('n')), 'zzz').map((x) => x.track.key)).toEqual(['n', 'a', 'b', 'c']);
    // Ranks read 1..n again.
    expect(insertAfter(items, addedRow(t('n')), 'a').map((x) => x.rank)).toEqual([1, 2, 3, 4]);
  });

  it('marks the row as added by the listener', () => {
    const r = addedRow(t('n'));
    expect(r.added).toBe(true);
    expect(r.reasons[0]!.text).toMatch(/added/i);
  });

  it('keeps an added song where it was put when the queue is re-ranked, even though the ranking never saw it', () => {
    const prev = [addedRow(t('a')), addedRow(t('n')), { ...addedRow(t('b')), added: false }];
    const next = [{ ...addedRow(t('z')), added: false }, { ...addedRow(t('b')), added: false }];
    const merged = mergeRerank(prev, next, new Set(['a']));
    expect(merged.map((x) => x.track.key)).toEqual(['a', 'n', 'z', 'b']);
  });
});
