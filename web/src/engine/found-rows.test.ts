// WP1 step 4 (plan 2026-11-24, A8): hand-added rows are pinned (QUEUE-ADD-001); found rows are movable.
import { describe, expect, it } from 'vitest';
import { isPinned, moodMovable } from './mood-apply';
import { mergeRerank } from '../util';
import type { RecItem } from '../api';

const row = (key: string, extra: Record<string, unknown> = {}): RecItem => ({ rank: 1, track: { key }, ...extra }) as unknown as RecItem;

describe('added vs found (WP1, A8)', () => {
  it('a hand-added row is pinned; Find-similar and custom rows are not', () => {
    expect(isPinned(row('h', { added: true }))).toBe(true);
    expect(isPinned(row('s', { found: 'similar' }))).toBe(false);
    expect(isPinned(row('c', { found: 'custom' }))).toBe(false);
  });
  it('old stored queues: added + custom or added + sound_match read as found rows', () => {
    expect(isPinned(row('c', { added: true, custom: true }))).toBe(false);
    expect(isPinned(row('s', { added: true, sound_match: 72 }))).toBe(false);
    expect(isPinned(row('u', { added: true, sound_match: null }))).toBe(false);
  });
  it('the mood may move a Find-similar row but not a hand-added one', () => {
    const items = [row('now'), row('h', { added: true }), row('s', { found: 'similar' }), row('x')];
    const keys = moodMovable(items, { currentKey: 'now', played: new Set() }).map((x) => x.track.key);
    expect(keys).toEqual(['s', 'x']);
  });
  it('a re-rank moves a found row and keeps a hand-added row at the end', () => {
    const prev = [row('a'), row('s', { found: 'similar' }), row('b'), row('h', { added: true })];
    const out = mergeRerank(prev, [row('s'), row('b'), row('a')], new Set());
    expect(out.map((x) => x.track.key)).toEqual(['s', 'b', 'a', 'h']);
    expect(out[0]!.found).toBe('similar');
  });
});
