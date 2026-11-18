import { describe, expect, it } from 'vitest';
import { broadcastTimeline, liveEdgeTracker, parseBroadcast, radioClock, songStartFromFingerprint } from './radio';
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
  it('does not fabricate an elapsed clock from tune-in or catalogue length', () => {
    const t = broadcastTimeline({ ...parseBroadcast('Artist - Song', 'ICY', NOW) }, { duration: 220 }, snap, NOW);
    expect(t.elapsed).toBeNull(); expect(t.duration).toBe(220); expect(t.durationSource).toBe('catalogue'); expect(t.clockSource).toBeNull();
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
    expect(t.rewindable).toBe(150);
    // RADIO-CLOCK-001: with no item clock the bar is empty. It used to show the playhead's place in the
    // retained buffer (150 of 300), which sat near the end and read as "this song is almost over".
    expect(t.value).toBe(0); expect(t.max).toBe(1);
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

// RADIO-CLOCK-001 (owner 2026-11-17): "the radio progress bar and the radio player is not accurate at all
// ... it should have elapsed time on the left and total track duration on the right". Most stations
// publish a title and no start time, so the left clock read --:-- and the bar showed the buffer. The
// audio fingerprint already answers how far into the song the sampled audio is (measured live on a
// known file: a clip cut at 1:00 answered 1:00, one cut at 1:35 answered 1:35), which places the
// song's first second on the ring's own sample clock.
describe('song clock measured from the audio (RADIO-CLOCK-001)', () => {
  const song = () => ({ ...parseBroadcast('Artist - Song', 'ICY', NOW) });
  it('places the song start on the ring clock from where the fingerprint heard the sample', () => {
    // 12 s of audio ending at ring second 190 was heard 60 s into the song: the song began at 118.
    expect(songStartFromFingerprint({ sampleEnd: 190, sampleSeconds: 12, offset: 60, duration: 220 })).toBe(118);
    // A song that began before tuning in has a start before the ring's zero.
    expect(songStartFromFingerprint({ sampleEnd: 20, sampleSeconds: 12, offset: 95.5, duration: 220 })).toBe(-87.5);
  });
  it('refuses a fingerprint answer that cannot be a position in this song', () => {
    const base = { sampleEnd: 190, sampleSeconds: 12, offset: 60, duration: 220 };
    expect(songStartFromFingerprint({ ...base, offset: Number.NaN })).toBeNull();
    expect(songStartFromFingerprint({ ...base, offset: -3 })).toBeNull();
    expect(songStartFromFingerprint({ ...base, offset: 400 })).toBeNull(); // past the end of a 220 s song
    expect(songStartFromFingerprint({ ...base, sampleSeconds: 40 })).toBeNull(); // not one fingerprint window
    expect(songStartFromFingerprint({ ...base, sampleEnd: Number.NaN })).toBeNull();
    expect(songStartFromFingerprint({ ...base, duration: null })).toBe(118); // length unknown: the offset still stands
  });
  it('shows elapsed on the left and the catalogue length on the right, following the playhead', () => {
    const t = broadcastTimeline(song(), { duration: 220 }, snap, NOW, undefined, 118);
    expect(t.elapsed).toBe(62); expect(t.duration).toBe(220); expect(t.clockSource).toBe('audio');
    expect(t.value).toBe(62); expect(t.max).toBe(220);
    expect(broadcastTimeline(song(), { duration: 220 }, { ...snap, position: 165 }, NOW, undefined, 118).elapsed).toBe(47); // rewound 15 s
  });
  it('stops at the song\'s own length once the measured song has run out (RADIO-CLOCK-002)', () => {
    // The fingerprint named this recording, so its length is the heard song's length. Seen live on a real station:
    // the title arrived late and the player read 2:10 / 2:04. It now rests at the end until the next song is measured.
    const t = broadcastTimeline(song(), { duration: 220 }, { ...snap, position: 345, received: 350 }, NOW, undefined, 118);
    expect(t.elapsed).toBe(220); expect(t.value).toBe(220); expect(t.max).toBe(220); expect(t.duration).toBe(220);
  });
  it('does not move while paused, however much new audio arrives', () => {
    const before = broadcastTimeline(song(), { duration: 220 }, snap, NOW, undefined, 118);
    const later = broadcastTimeline(song(), { duration: 220 }, { ...snap, received: 260 }, NOW + 70000, undefined, 118);
    expect(later.elapsed).toBe(before.elapsed);
  });
  it('trusts the measured audio over a published start time (streams run behind the schedule)', () => {
    const t = broadcastTimeline({ ...song(), startedAt: NOW - 100000 }, { duration: 220 }, snap, NOW, undefined, 118);
    expect(t.elapsed).toBe(62); expect(t.clockSource).toBe('audio');
    expect(broadcastTimeline({ ...song(), startedAt: NOW - 100000 }, { duration: 220 }, snap, NOW).clockSource).toBe('broadcaster');
  });
  it('never shows a negative time when the playhead is rewound to before the song began', () => {
    expect(broadcastTimeline(song(), { duration: 220 }, { ...snap, position: 100 }, NOW, undefined, 118).elapsed).toBe(0);
  });
});
