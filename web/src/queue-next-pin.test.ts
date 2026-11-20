// QUEUE-NEXT-001 (owner, 2026-11-20): "Ensure the discover now playing queue is updated accurately even if dynamic mood
// is on. Right now the now playing queue says a different song is going to play next than the actual music player".
// Reproduced on Windows: with shuffle on, the player's Up next was "Codeine Crazy" (the mood-weighted pick) while the
// queue showed "Hell Yeah" right after the song playing. The song the player will play next now sits directly after
// the song playing in the queue itself, ranks renumbered, and a mood re-arrangement keeps it there.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinNext, placeMood } from './engine/mood-apply';
import type { RecItem } from './api';

const row = (key: string, rank: number, extra: Partial<RecItem> = {}): RecItem => ({ track: { key, title: key } as never, rank, reasons: [], playback: {} as never, ...extra }) as RecItem;
const keys = (xs: RecItem[]) => xs.map((x) => x.track.key);
const list = () => ['a', 'b', 'c', 'd', 'e'].map((k, i) => row(k, i + 1));

describe('pinNext', () => {
  it('moves the song that plays next to just after the song playing, ranks renumbered', () => {
    const out = pinNext(list(), 'b', 'e');
    expect(keys(out)).toEqual(['a', 'b', 'e', 'c', 'd']);
    expect(out.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5]);
  });
  it('leaves the list exactly as it is when it already agrees (same array, no re-render)', () => {
    const xs = list();
    expect(pinNext(xs, 'b', 'c')).toBe(xs);
  });
  it('does nothing without a song playing in the list, without a next song, or when next is not in it', () => {
    const xs = list();
    expect(pinNext(xs, null, 'e')).toBe(xs);
    expect(pinNext(xs, 'zz', 'e')).toBe(xs);
    expect(pinNext(xs, 'b', null)).toBe(xs);
    expect(pinNext(xs, 'b', 'zz')).toBe(xs);
    expect(pinNext(xs, 'b', 'b')).toBe(xs);
  });
  it('never moves a song that already played above the song playing (a repeat round keeps history in place)', () => {
    const xs = list();
    expect(pinNext(xs, 'c', 'a')).toBe(xs);
  });
  it('a mood re-arrangement followed by pinNext keeps the committed next song next', () => {
    const moved = placeMood(pinNext(list(), 'b', 'e'), ['d', 'c', 'e']);
    expect(keys(pinNext(moved, 'b', 'e'))[2]).toBe('e');
  });
});

describe('the Discover queue uses it', () => {
  const app = readFileSync(resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
  it('pins the player\'s next song whenever it or the list changes', () => {
    expect(app).toMatch(/QUEUE-NEXT-001[\s\S]{0,400}useEffect\(\(\) => \{[\s\S]{0,300}pinNext\(prev\.items, playingKey, nextKey\)[\s\S]{0,200}\}, \[nextKey, playingKey, result\?\.items, playingContext\]\);/);
  });
  it('a mood re-arrangement keeps it pinned', () => {
    expect(app).toMatch(/items: pinNext\(placeMood\(prev\.items, plan\.order\), playingKey, nextKeyRef\.current\)/);
  });
});
