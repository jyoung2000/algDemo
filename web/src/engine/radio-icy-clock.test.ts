/**
 * RADIO-ICY-CLOCK-001 (owner, 2026-11-20: Android Auto should show the song's elapsed time and length). Measured on
 * Power 92: the feed published "Young Thug - Best Friend" as starting 37.5 s before that title changed inside the
 * audio stream, so a clock from the feed ran 37 s ahead and songs "ended" early. The native ring now reports where
 * each in-band title change lands on the ring clock; a song that changes while listening starts there.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { icySongStart, parseBroadcast, type Broadcast } from './radio';

const b = (s: string): Broadcast => ({ ...parseBroadcast(s, 'Futuri official feed'), state: 'current', kind: 'song' });

describe('icySongStart', () => {
  const marks = [{ at: 120.5, title: 'Mario - Let Me Love You' }, { at: 387.07, title: 'Young Thug - Best Friend' }];
  it('the in-band change for the same song, after the feed named it, is where the song starts', () => {
    expect(icySongStart(marks, b('Young Thug - Best Friend'), 350)).toBe(387.07);
  });
  it('matches without case or punctuation differences', () => {
    expect(icySongStart([{ at: 50, title: 'YOUNG THUG - BEST FRIEND (CLEAN)' }], b('Young Thug - Best Friend'), 20)).toBe(50);
  });
  it('ignores a change long before the feed named the song (an earlier play) and a different song', () => {
    expect(icySongStart(marks, b('Mario - Let Me Love You'), 300)).toBeNull();
    expect(icySongStart(marks, b('SZA - Snooze'), 350)).toBeNull();
    expect(icySongStart(undefined, b('Young Thug - Best Friend'), 350)).toBeNull();
  });
  it('a programme never takes a song clock', () => {
    expect(icySongStart(marks, { ...b('Young Thug - Best Friend'), kind: 'programme' }, 350)).toBeNull();
  });
});

describe('the radio session uses it', () => {
  it('a native snapshot carries the marks, and an unmeasured song takes its start from them', () => {
    const src = readFileSync(resolve(process.cwd(), 'src', 'engine', 'radio-client.ts'), 'utf8');
    expect(src).toMatch(/icy\?: \{ at: number; title: string \}\[\]/);
    expect(src).toMatch(/if \(m\.startAt == null\) \{ const at = icySongStart\(snap\.icy, m\.broadcast, m\.at\); if \(at !== null\) m\.startAt = at; \}/);
  });
});
