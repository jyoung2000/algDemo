import { describe, expect, it } from 'vitest';

import {
  MAX_TRACK_FRACTION,
  MAX_TEMPO_NUDGE,
  MIX_LABELS,
  barSeconds,
  clampSlider,
  equalPower,
  mixLabel,
  mixPlan,
  quantizeToBars,
  requestedSeconds,
  tempoNudge,
  tempoRelation,
  transitionStyle,
} from './crossfade';

/** MIXER-001. One slider decides the blend; the material decides whether it is allowed. */
describe('the mixing slider', () => {
  it('names the five bands the owner asked for', () => {
    expect(MIX_LABELS).toEqual(['Off', 'Subtle', 'Smooth', 'Creative', 'Long & Creative']);
    expect(mixLabel(0)).toBe('Off');
    expect(mixLabel(1)).toBe('Subtle');
    expect(mixLabel(25)).toBe('Subtle');
    expect(mixLabel(26)).toBe('Smooth');
    expect(mixLabel(50)).toBe('Smooth');
    expect(mixLabel(51)).toBe('Creative');
    expect(mixLabel(75)).toBe('Creative');
    expect(mixLabel(76)).toBe('Long & Creative');
    expect(mixLabel(100)).toBe('Long & Creative');
  });

  it('asks for longer overlaps as it rises, and never less', () => {
    let last = -1;
    for (let s = 0; s <= 100; s += 1) {
      const r = requestedSeconds(s);
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
    expect(requestedSeconds(0)).toBe(0);
    // The brief's envelopes.
    expect(requestedSeconds(25)).toBeCloseTo(6, 1);
    expect(requestedSeconds(50)).toBeCloseTo(16, 1);
    expect(requestedSeconds(75)).toBeCloseTo(32, 1);
    expect(requestedSeconds(100)).toBeCloseTo(64, 1);
  });

  it('clamps and rounds a nonsense slider value instead of trusting it', () => {
    expect(clampSlider(-40)).toBe(0);
    expect(clampSlider(1e9)).toBe(100);
    expect(clampSlider(Number.NaN)).toBe(0);
    expect(clampSlider(37.6)).toBe(38);
  });

  it('at Off plays songs one after another with no overlap', () => {
    const p = mixPlan(0, 30, 30);
    expect(p.seconds).toBe(0);
    expect(p.reason).toBe('off');
    expect(p.description).toContain('one after another');
    // The handoff is at the very end of the outgoing song, not early.
    expect(p.startAt).toBe(30);
  });

  it('never spends more than 40% of the shorter song on the blend', () => {
    // A 30s preview at the top of the slider wants 64s; it may only have 12s.
    const p = mixPlan(100, 30, 30);
    expect(p.requested).toBeCloseTo(64, 1);
    expect(p.seconds).toBeCloseTo(30 * MAX_TRACK_FRACTION, 5);
    expect(p.seconds).toBe(12);
    expect(p.reason).toBe('shortened-for-pair');
    expect(p.description).toBe('Long & Creative • about 12 seconds, shortened for this pair');
  });

  it('is limited by the SHORTER of the two songs', () => {
    // A long outgoing song cannot be blended into a 4-second incoming one.
    const p = mixPlan(100, 240, 4);
    expect(p.seconds).toBeCloseTo(1.6, 5);
    expect(p.startAt).toBeCloseTo(238.4, 5);
  });

  it('says so plainly when a pair is too short to blend at all', () => {
    const p = mixPlan(60, 0.4, 0.4);
    expect(p.seconds).toBe(0);
    expect(p.reason).toBe('too-short-to-blend');
    expect(p.description).toContain('clean handoff');
  });

  it('refuses to blend when a length is unknown rather than guessing', () => {
    for (const [out, inc] of [
      [0, 30],
      [30, 0],
      [Number.NaN, 30],
      [30, Number.POSITIVE_INFINITY],
    ] as const) {
      const p = mixPlan(50, out as number, inc as number);
      expect(p.seconds, `out=${out} in=${inc}`).toBe(0);
      expect(p.reason).toBe('too-short-to-blend');
    }
  });

  it('starts the blend so it finishes exactly as the outgoing song ends', () => {
    const p = mixPlan(40, 30, 30);
    expect(p.seconds).toBeGreaterThan(0);
    expect(p.startAt + p.seconds).toBeCloseTo(30, 5);
  });

  it('reports the plain length when nothing had to be shortened', () => {
    const p = mixPlan(10, 200, 200);
    expect(p.reason).toBe('as-requested');
    expect(p.description).toMatch(/^Subtle • about [\d.]+ seconds$/);
  });

  it('raising the slider only lengthens the blend, never changes level', () => {
    // The whole point of one slider: it buys time, not loudness.
    const lengths = [10, 30, 60, 90].map((s) => mixPlan(s, 300, 300).seconds);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
    expect(new Set(lengths).size).toBe(lengths.length);
  });
});

/**
 * Beat-matching (MIXER-002). Grounded in what the reference auto-DJs actually do:
 * BKmasterplayer times transitions "on the bar" and names its styles "bass swap, filter, echo,
 * blend or cut"; songs-automixer_python snaps the mix point "to the nearest bar" and flags a 64 BPM
 * track as mixable against a 128 BPM one; BitChord falls back to a plain equal-power crossfade when
 * a pair will not mix. No code from any of them is copied here — the GPL/AGPL ones could not be.
 */
describe('beat matching', () => {
  it('measures a bar as four beats', () => {
    expect(barSeconds(120)).toBeCloseTo(2, 6); // 120 BPM = 0.5s a beat = 2s a bar
    expect(barSeconds(90)).toBeCloseTo(8 / 3, 6);
    expect(barSeconds(60)).toBeCloseTo(4, 6);
  });

  it('has no bar length for an unknown tempo', () => {
    for (const bad of [null, undefined, 0, -120, Number.NaN]) expect(barSeconds(bad as number)).toBeNull();
  });

  it('treats near-identical tempos as the same grid', () => {
    expect(tempoRelation(120, 120)).toBe('same');
    expect(tempoRelation(120, 126)).toBe('same'); // 5% apart
  });

  it('folds half and double time together, as the reference auto-mixer does', () => {
    // Its README: "a 64 BPM track is flagged against a 128 BPM track".
    expect(tempoRelation(64, 128)).toBe('half-or-double');
    expect(tempoRelation(128, 64)).toBe('half-or-double');
    expect(tempoRelation(75, 150)).toBe('half-or-double');
  });

  it('calls genuinely distant tempos unrelated rather than forcing a match', () => {
    expect(tempoRelation(90, 140)).toBe('unrelated');
    expect(tempoRelation(100, 175)).toBe('unrelated');
  });

  it('knows when it does not know the tempo', () => {
    expect(tempoRelation(null, 120)).toBe('unknown');
    expect(tempoRelation(120, undefined)).toBe('unknown');
    expect(tempoRelation(0, 120)).toBe('unknown');
    expect(tempoRelation(Number.NaN, 120)).toBe('unknown');
  });

  it('nudges the incoming deck onto the outgoing tempo', () => {
    // 124 into 120: the incoming song must play slightly slower, 120/124.
    expect(tempoNudge(120, 124)).toBeCloseTo(120 / 124, 6);
    expect(tempoNudge(124, 120)).toBeCloseTo(124 / 120, 6);
    expect(tempoNudge(120, 120)).toBeCloseTo(1, 6);
  });

  it('never stretches far enough to warble', () => {
    // A rate beyond a few percent is audible in a plain media element.
    for (const [a, b] of [[120, 126], [126, 120], [100, 112]] as const) {
      const r = tempoNudge(a, b);
      expect(r).toBeGreaterThanOrEqual(1 - MAX_TEMPO_NUDGE);
      expect(r).toBeLessThanOrEqual(1 + MAX_TEMPO_NUDGE);
    }
  });

  it('clamps the sliver where a matched pair still wants too much stretch', () => {
    // The tolerance measures the gap against the LARGER tempo, so a pair can qualify as the same
    // grid and still ask for a ratio above the nudge limit: (128 - 120.5) / 128 = 5.9% passes, but
    // 128 / 120.5 = 1.062 exceeds it. Without the clamp this would warble.
    expect(tempoRelation(128, 120.5)).toBe('same');
    expect(128 / 120.5).toBeGreaterThan(1 + MAX_TEMPO_NUDGE);
    expect(tempoNudge(128, 120.5)).toBeCloseTo(1 + MAX_TEMPO_NUDGE, 10);
  });

  it('leaves the rate alone when stretching would not help', () => {
    expect(tempoNudge(90, 140), 'unrelated tempos').toBe(1);
    expect(tempoNudge(64, 128), 'half time already shares the grid').toBe(1);
    expect(tempoNudge(null, 120), 'unknown').toBe(1);
  });

  it('snaps a blend down to whole bars, never up past the song end', () => {
    // 120 BPM, 2s a bar: 9s of room is 4 bars (8s), not 5.
    expect(quantizeToBars(9, 120)).toEqual({ seconds: 8, bars: 4 });
    expect(quantizeToBars(12, 120)).toEqual({ seconds: 12, bars: 6 });
    const q = quantizeToBars(9, 90); // 2.667s a bar → 3 bars = 8s
    expect(q.bars).toBe(3);
    expect(q.seconds).toBeCloseTo(8, 6);
    expect(q.seconds).toBeLessThanOrEqual(9);
  });

  it('leaves a blend alone when not even one bar fits', () => {
    // 60 BPM is a 4s bar; 3s of room cannot hold one.
    expect(quantizeToBars(3, 60)).toEqual({ seconds: 3, bars: 0 });
  });

  it('leaves a blend alone when the tempo is unknown', () => {
    expect(quantizeToBars(9, null)).toEqual({ seconds: 9, bars: 0 });
  });

  it('unlocks more ambitious transitions as the slider rises', () => {
    expect(transitionStyle(0)).toBe('cut');
    expect(transitionStyle(20)).toBe('blend');
    expect(transitionStyle(40)).toBe('bass-swap');
    expect(transitionStyle(80)).toBe('filter');
    expect(transitionStyle(100)).toBe('filter');
  });
});

describe('the plan with tempos', () => {
  it('lands on whole bars and says so', () => {
    // 30s previews at slider 100 → 12s ceiling; 120 BPM → 6 bars exactly.
    const p = mixPlan(100, 30, 30, { outBpm: 120, inBpm: 120 });
    expect(p.bars).toBe(6);
    expect(p.seconds).toBe(12);
    expect(p.tempo).toBe('same');
    expect(p.description).toContain('6 bars on the beat');
  });

  it('quantises to the outgoing song’s groove, not the incoming one', () => {
    // 90 BPM out (2.667s bars) with 12s of room → 4 bars = 10.667s.
    const p = mixPlan(100, 30, 30, { outBpm: 90, inBpm: 92 });
    expect(p.bars).toBe(4);
    expect(p.seconds).toBeCloseTo(32 / 3, 5);
    expect(p.startAt + p.seconds).toBeCloseTo(30, 5);
  });

  it('beat-matches a half-time pair without stretching it', () => {
    const p = mixPlan(100, 30, 30, { outBpm: 70, inBpm: 140 });
    expect(p.tempo).toBe('half-or-double');
    expect(p.rate).toBe(1);
    expect(p.bars).toBeGreaterThan(0);
  });

  it('falls back to a plain crossfade when the tempos are too far apart', () => {
    // BitChord's documented fallback: an equal-power crossfade, honestly described.
    const p = mixPlan(100, 30, 30, { outBpm: 85, inBpm: 150 });
    expect(p.tempo).toBe('unrelated');
    expect(p.bars).toBe(0);
    expect(p.rate).toBe(1);
    expect(p.seconds).toBe(12);
    expect(p.description).toContain('too far apart to beat-match');
  });

  it('behaves exactly as before when no tempo is given', () => {
    const without = mixPlan(60, 30, 30);
    const unknown = mixPlan(60, 30, 30, { outBpm: null, inBpm: null });
    expect(without.seconds).toBe(unknown.seconds);
    expect(without.bars).toBe(0);
    expect(without.rate).toBe(1);
    expect(without.tempo).toBe('unknown');
  });

  it('does not blame the pair for musical rounding', () => {
    // The 40% ceiling IS the pair's fault; snapping to a bar is a choice.
    const long = mixPlan(10, 300, 300, { outBpm: 120, inBpm: 120 });
    expect(long.reason).toBe('as-requested');
    expect(long.bars).toBeGreaterThan(0);
    expect(long.seconds).toBeLessThanOrEqual(long.requested);
  });

  it('is off at zero whatever the tempos say', () => {
    const p = mixPlan(0, 30, 30, { outBpm: 120, inBpm: 120 });
    expect(p.seconds).toBe(0);
    expect(p.style).toBe('cut');
    expect(p.bars).toBe(0);
  });
});

describe('the crossfade curve', () => {
  it('hands over completely from one song to the other', () => {
    expect(equalPower(0).out).toBeCloseTo(1, 6);
    expect(equalPower(0).in).toBeCloseTo(0, 6);
    expect(equalPower(1).out).toBeCloseTo(0, 6);
    expect(equalPower(1).in).toBeCloseTo(1, 6);
  });

  it('holds constant power all the way across, so the mix does not sag', () => {
    // A linear pair would drop to 0.5 power (about -3 dB) at the midpoint; this must not.
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const g = equalPower(t);
      expect(g.out ** 2 + g.in ** 2).toBeCloseTo(1, 6);
    }
    const mid = equalPower(0.5);
    expect(mid.out).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.in).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('moves one way only', () => {
    let lastIn = -1;
    let lastOut = 2;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const g = equalPower(t);
      expect(g.in).toBeGreaterThanOrEqual(lastIn);
      expect(g.out).toBeLessThanOrEqual(lastOut);
      lastIn = g.in;
      lastOut = g.out;
    }
  });

  it('survives a bad progress value instead of producing NaN gain', () => {
    for (const bad of [-1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const g = equalPower(bad);
      expect(Number.isFinite(g.out)).toBe(true);
      expect(Number.isFinite(g.in)).toBe(true);
      expect(g.out).toBeGreaterThanOrEqual(0);
      expect(g.in).toBeGreaterThanOrEqual(0);
    }
  });
});
