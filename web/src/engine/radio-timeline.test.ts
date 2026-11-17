import { describe, expect, it } from 'vitest';
import { broadcastTimeline, liveEdgeTracker, parseBroadcast, radioClock } from './radio';
const NOW = 1794873600000;
const b = () => ({ ...parseBroadcast('Programme', 'Schedule', NOW), startedAt: NOW - 130000, duration: 3600 });
const snap = { received: 190, position: 180, oldest: 0 };
describe('published radio item clocks, independent of buffer clocks', () => {
  it('subtracts live delay and updates backwards on rewind', () => {
    expect(broadcastTimeline(b(), null, snap, NOW).elapsed).toBe(120);
    expect(broadcastTimeline(b(), null, { ...snap, position: 165 }, NOW).elapsed).toBe(105);
  });
  it('does not advance the item playhead while paused as the live edge keeps arriving', () => {
    const before = broadcastTimeline(b(), null, snap, NOW);
    const paused = broadcastTimeline(b(), null, { ...snap, received: 220 }, NOW + 30000);
    expect(paused.elapsed).toBe(before.elapsed); expect(paused.rewindable).toBe(before.rewindable);
  });
  it('does not fabricate an elapsed clock from tune-in, recognition sample or catalogue length', () => {
    const t = broadcastTimeline({ ...parseBroadcast('Artist - Song', 'ICY', NOW) }, { duration: 220 }, snap, NOW);
    expect(t.elapsed).toBeNull(); expect(t.duration).toBe(220); expect(t.durationSource).toBe('catalogue');
  });
  it('keeps catalogue length distinct from a longer broadcast edit', () => {
    const t = broadcastTimeline({ ...b(), kind: 'song', duration: null }, { duration: 100 }, snap, NOW);
    expect(t.elapsed).toBe(120); expect(t.duration).toBe(100); expect(t.max).toBeGreaterThanOrEqual(120);
  });
  it('uses published duration in preference to catalogue duration', () => {
    const t = broadcastTimeline({ ...b(), kind: 'song' }, { duration: 100 }, snap, NOW);
    expect(t.duration).toBe(3600); expect(t.durationSource).toBe('broadcaster');
  });
  it('never allows a retained-buffer UI to imply more retained audio than the ring reports', () => {
    const t = broadcastTimeline(null, null, { received: 600, position: 450, oldest: 300 }, NOW);
    expect(t.rewindable).toBe(150); expect(t.max).toBe(300); expect(t.value).toBe(150);
  });
  it('formats hour-long programmes and unknown durations explicitly', () => {
    expect(radioClock(3600)).toBe('1:00:00'); expect(radioClock(63)).toBe('1:03'); expect(radioClock(null)).toBe('--:--');
  });
});

describe('steady behind-live display (RADIO-UI-003)', () => {
  it('does not flicker across a whole second while chunked audio arrives in bursts', () => {
    const edge = liveEdgeTracker();
    const shown: string[] = [];
    // Audio arrives once a second in bursts while playback consumes smoothly: the raw difference
    // sawtooths across the 9/10s boundary four times a second.
    for (let t = 0; t <= 12; t += 0.25) {
      const received = 10 + Math.ceil(t), position = 0.5 + t;
      shown.push(radioClock(Math.max(0, edge('session', received, t) - position)));
    }
    expect(new Set(shown.slice(4)).size).toBe(1);
  });
  it('resets for a new session and still reflects a real rewind immediately', () => {
    const edge = liveEdgeTracker();
    expect(edge('one', 100, 0)).toBe(100);
    expect(edge('one', 100, 2)).toBe(102);
    expect(Math.max(0, edge('one', 102.4, 3) - 60)).toBeCloseTo(43, 0); // position dropped by rewind
    expect(edge('two', 5, 4)).toBe(5);
  });
});
