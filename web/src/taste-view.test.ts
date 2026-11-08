import { describe, expect, it } from 'vitest';
import type { TasteSummary } from './api';
import { describeSound, generalLabel, gradientOf, gradientStops, pushSnapshot, soundChanges, soundView, SNAPSHOT_MAX } from './taste-view';

const g = (name: string, score: number, plays = 2, skips = 0) => ({ name, label: name, score, plays, skips });
const summary = (genres: ReturnType<typeof g>[], events = 6, bpm: number | null = null): TasteSummary => ({
  events,
  positives: events,
  negatives: 0,
  bpm,
  skip_bpm: null,
  likes: genres.filter((x) => x.score > 0),
  avoids: genres.filter((x) => x.score < 0),
  genres,
});

describe('soundView', () => {
  it('is null until the engine has learned from a song', () => {
    expect(soundView(null)).toBeNull();
    expect(soundView({ ...summary([]), events: 0 })).toBeNull();
  });

  it('groups liked genres into families whose shares sum to 1, strongest first', () => {
    const v = soundView(summary([g('trap', 3), g('house', 1), g('techno', 1)]))!;
    expect(v.families.length).toBeGreaterThanOrEqual(2);
    expect(v.families.reduce((a, f) => a + f.share, 0)).toBeCloseTo(1, 5);
    for (let i = 1; i < v.families.length; i++) expect(v.families[i - 1]!.share).toBeGreaterThanOrEqual(v.families[i]!.share);
    // Strongest first by share of kept listening: the family with the most plays leads, whatever its score.
    expect(v.families[0]!.share).toBeGreaterThanOrEqual(v.families[v.families.length - 1]!.share);
  });

  it('header names the top three genres with the same percents the rows show', () => {
    const v = soundView(summary([g('trap', 2, 6), g('rage', 2, 2), g('pop', 2, 2), g('house', 2, 2)]))!;
    const header = describeSound(v, 3);
    expect(header).toBe(v.leaves.slice(0, 3).map((l) => `${l.label} ${l.pct}%`).join(', '));
    expect(header.split(',').length).toBe(3);
    for (const l of v.leaves.slice(0, 3)) {
      const row = v.families.flatMap((f) => [...f.subs.map((s) => [s.label, s.pct] as const), ...(f.broadPct ? [[generalLabel(f.name), f.broadPct] as const] : [])]).find(([n]) => n === l.label);
      expect(row?.[1]).toBe(l.pct);
    }
  });

  it('rounds every row together so the percents add to exactly 100 and a family is the sum of its rows', () => {
    const v = soundView(summary([g('trap', 1, 1), g('rage', 1, 1), g('southern', 1, 1), g('hip-hop', 1, 1), g('pop', 1, 1), g('house', 1, 1), g('techno', 1, 1)]))!;
    const rows = v.families.flatMap((f) => [...f.subs.map((s) => s.pct), f.broadPct]);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(100);
    for (const f of v.families) expect(f.pct).toBe(f.subs.reduce((a, s) => a + s.pct, 0) + f.broadPct);
    expect(v.families.reduce((a, f) => a + f.pct, 0)).toBe(100);
  });

  it('never puts a slash in a genre label', () => {
    const v = soundView(summary([g('southern', 2, 2), g('trap-metal', 1, 1)]))!;
    expect(v.leaves.every((l) => !l.label.includes('/'))).toBe(true);
    expect(describeSound(v, 8)).not.toContain('/');
  });

  it('keeps the subgenre under its family and names it as the picker does', () => {
    const v = soundView(summary([g('trap', 2)]))!;
    const f = v.families[0]!;
    expect(f.subs.map((s) => s.label.toLowerCase())).toContain('trap');
    expect(f.subs[0]!.share + f.broad).toBeCloseTo(f.share, 5);
    expect(f.pct).toBe(f.subs.reduce((a, s) => a + s.pct, 0) + f.broadPct);
  });

  it('lists skipped genres separately and never as part of the gradient', () => {
    const v = soundView(summary([g('trap', 2), g('nu-metal', -2, 0, 3)]))!;
    expect(v.avoided.length).toBe(1);
    expect(v.families.every((f) => !/rock/i.test(f.name) || f.share === 0)).toBe(true);
  });

  it('shows a genre it cannot place as text, not silently dropped', () => {
    const v = soundView(summary([g('trap', 2), g('zzz-unknown-genre', 1)]))!;
    expect(v.unplaced).toContain('zzz-unknown-genre');
  });
});

describe('bar blends subgenres', () => {
  it('gives one hip-hop family several colours when it holds several subgenres', () => {
    const v = soundView(summary([g('trap', 2), g('boom-bap', 2), g('drill', 1)]))!;
    expect(v.families).toHaveLength(1);
    expect(v.bar.length).toBeGreaterThanOrEqual(3);
    expect(new Set(v.bar.map((b) => b.color)).size).toBe(v.bar.length);
    expect(v.bar.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 5);
  });

  it('never has more than the eight stops the stylesheet animates', () => {
    const names = ['trap', 'boom-bap', 'drill', 'house', 'techno', 'dubstep', 'trance', 'indie-rock', 'punk', 'jazz', 'blues'];
    const v = soundView(summary(names.map((n) => g(n, 1))))!;
    expect(v.bar.length).toBeLessThanOrEqual(8);
  });
});

describe('gradient and words', () => {
  it('blends smoothly: the ends hold only a sliver so no flat block reads as a box', () => {
    const css = gradientOf([
      { color: 'red', share: 0.6 },
      { color: 'blue', share: 0.4 },
    ]);
    expect(css).toBe('linear-gradient(90deg in oklch, red 0%, red 8.0%, blue 92.0%, blue 100%)');
  });
  it('holds one family as a plain colour', () => {
    expect(gradientOf([{ color: 'red', share: 1 }])).toBe('linear-gradient(90deg in oklch, red 0%, red 50.0%, red 100%)');
  });
  it('gives animatable stops for the single bar', () => {
    expect(gradientStops([{ color: 'red', share: 0.5 }, { color: 'blue', share: 0.5 }])).toEqual([
      { color: 'red', at: 8 },
      { color: 'blue', at: 92 },
    ]);
  });
  it('says when it is still learning', () => {
    expect(describeSound(null)).toBe('Still learning your sound');
  });
  it('names the top families with percents', () => {
    const v = soundView(summary([g('trap', 3), g('house', 1)]))!;
    expect(describeSound(v, 2)).toMatch(/\d+%, .+ \d+%/);
  });
});

describe('what changed', () => {
  it('reports a family that grew and one that is new after a listen', () => {
    const a = soundView(summary([g('trap', 3)], 3))!;
    const b = soundView(summary([g('trap', 3), g('house', 3)], 4))!;
    const ch = soundChanges(a, b);
    expect(ch.some((c) => c.dir === 'new')).toBe(true);
    expect(ch.some((c) => c.dir === 'down' || c.dir === 'up')).toBe(true);
  });
  it('reports nothing when the taste did not move', () => {
    const a = soundView(summary([g('trap', 3)], 3))!;
    expect(soundChanges(a, a)).toEqual([]);
  });
  it('reports nothing on first load (no earlier state to compare)', () => {
    expect(soundChanges(null, soundView(summary([g('trap', 3)]))).every((c) => c.dir !== 'up' && c.dir !== 'down')).toBe(true);
  });
});

describe('history ribbon', () => {
  it('adds a snapshot only when the sound changed, and keeps the newest SNAPSHOT_MAX', () => {
    let h = pushSnapshot([], soundView(summary([g('trap', 2)], 1)), 1);
    expect(h.length).toBe(1);
    expect(pushSnapshot(h, soundView(summary([g('trap', 2)], 1)), 2)).toBe(h);
    for (let i = 2; i < SNAPSHOT_MAX + 6; i++) h = pushSnapshot(h, soundView(summary([g('trap', 2 + i), g('house', i)], i)), i);
    expect(h.length).toBe(SNAPSHOT_MAX);
    expect(h[h.length - 1]!.events).toBe(SNAPSHOT_MAX + 5);
  });
});
