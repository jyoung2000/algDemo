import { describe, expect, it } from 'vitest';

import { MAX_TEMPO_NUDGE, MAX_TRACK_FRACTION, MIN_USEFUL_SECONDS, TAIL_GRACE_SECONDS, foldedRatio, mixPlan } from './crossfade';
import type { BeatGrid, TrackCues } from './track-cues';

/**
 * DJ-XFADE-001. With cues measured from the audio, the blend sits on the music: it ends as the
 * outgoing song leaves its level, starts on a beat, and trades the low end once.
 */
const grid = (bpm: number, beatAt: number, confidence = 3): BeatGrid => ({ bpm, beatAt, confidence });
const cues = (over: Partial<TrackCues> = {}): TrackCues => ({ duration: 200, start: 0, end: 200, fullEnd: 200, head: null, tail: null, ...over });

/** A 200 s song: 95% played is 190 s. Fades from 194 s, silent from 197 s. */
const OUT = cues({ end: 197, fullEnd: 194 });
const IN = cues({ duration: 180, start: 0.4, end: 180, fullEnd: 180 });

describe('without measured cues nothing changes', () => {
  it('plans exactly the blend it always did, over the tail of the file', () => {
    const plan = mixPlan(40, 200, 180);
    expect(plan.startAt).toBeCloseTo(190, 6);
    expect(plan.seconds).toBeCloseTo(10, 6);
    expect(plan.endAt).toBe(200);
    expect(plan.inStart).toBe(0);
    expect(plan.swapAt).toBeNull();
    expect(plan.beat).toBe('none');
    expect(mixPlan(40, 200, 180, { outCues: null, inCues: IN })).toEqual(plan);
  });

  it('Off stays off, and an unknown length is still not guessed at', () => {
    expect(mixPlan(0, 200, 180, { outCues: OUT, inCues: IN }).seconds).toBe(0);
    expect(mixPlan(0, 200, 180, { outCues: OUT, inCues: IN }).style).toBe('cut');
    expect(mixPlan(60, Number.NaN, 180, { outCues: OUT }).seconds).toBe(0);
  });
});

describe('placing the blend on the music', () => {
  it('ends as the song leaves its level, not at the end of the file', () => {
    const plan = mixPlan(40, 200, 180, { outCues: OUT, inCues: IN });
    expect(plan.endAt).toBeCloseTo(194 + TAIL_GRACE_SECONDS, 6);
    expect(plan.startAt).toBeCloseTo(190, 6);
    expect(plan.seconds).toBeCloseTo(5, 6);
    expect(plan.reason).toBe('kept-for-song');
  });

  it('starts the next song at its first sound, not at the silence before it', () => {
    expect(mixPlan(40, 200, 180, { outCues: OUT, inCues: IN }).inStart).toBeCloseTo(0.4, 6);
    expect(mixPlan(40, 200, 180, { outCues: OUT }).inStart).toBe(0);
  });

  it('never lets the next song in over the outgoing one before its play-through share has played', () => {
    for (const slider of [5, 25, 40, 60, 100]) {
      for (const share of [0.5, 0.8, 0.95, 0.99, 1]) {
        for (const fullEnd of [120, 170, 189, 191, 199, 200]) {
          for (const tail of [null, grid(120, 100.13), grid(87.3, 99.9)]) {
            for (const head of [null, grid(120, 0.4), grid(124, 0.62), grid(93, 0.5)]) {
              const out = cues({ end: Math.min(200, fullEnd + 3), fullEnd, tail });
              const plan = mixPlan(slider, 200, 180, { minPlayedFraction: share, outCues: out, inCues: cues({ duration: 180, start: 0.4, end: 180, fullEnd: 180, head }) });
              // The one earlier start there is: the outgoing song has already fallen silent for
              // good, so nothing of it is left to play and the next song starts there, unblended.
              if (plan.startAt < 200 * share - 1e-9) {
                expect(plan.seconds).toBe(0);
                expect(plan.startAt).toBe(out.end);
              }
              if (plan.seconds > 0) expect(plan.startAt).toBeGreaterThanOrEqual(200 * share - 1e-9);
              expect(plan.endAt).toBeLessThanOrEqual(200 + 1e-9);
              expect(plan.endAt).toBeCloseTo(plan.startAt + plan.seconds, 9);
              expect(plan.seconds === 0 || plan.seconds >= MIN_USEFUL_SECONDS).toBe(true);
              expect(plan.rate).toBeGreaterThanOrEqual(1 - MAX_TEMPO_NUDGE - 1e-9);
              expect(plan.rate).toBeLessThanOrEqual(1 + MAX_TEMPO_NUDGE + 1e-9);
            }
          }
        }
      }
    }
  });

  it('a song already fading when the blend may begin still gets a short blend, not a jump', () => {
    // Leaves its level at 170 s, audible to 198 s; the play-through rule holds the blend to 190 s.
    const plan = mixPlan(40, 200, 180, { outCues: cues({ end: 198, fullEnd: 170 }), inCues: IN });
    expect(plan.startAt).toBeCloseTo(190, 6);
    expect(plan.seconds).toBeCloseTo(2, 6);
  });

  it('hands over where the music stops when there is nothing left to blend over', () => {
    // Silent from 189 s: by 190 s there is no music to blend, so the next song starts right there.
    const gone = mixPlan(40, 200, 180, { outCues: cues({ end: 189, fullEnd: 186 }), inCues: IN });
    expect(gone.seconds).toBe(0);
    expect(gone.startAt).toBe(189);
    expect(gone.endAt).toBe(189);
    expect(gone.inStart).toBeCloseTo(0.4, 6);
    // "Play 100%" is still honoured: no overlap, but no dead air after the last sound either.
    const whole = mixPlan(40, 200, 180, { minPlayedFraction: 1, outCues: OUT, inCues: IN });
    expect(whole.seconds).toBe(0);
    expect(whole.startAt).toBe(197);
  });

  it('a short next song still caps the blend', () => {
    const plan = mixPlan(100, 200, 8, { minPlayedFraction: 0.5, outCues: cues({ end: 200, fullEnd: 199 }), inCues: cues({ duration: 8, start: 0, end: 8, fullEnd: 8 }) });
    expect(plan.seconds).toBeCloseTo(8 * MAX_TRACK_FRACTION, 6);
    expect(plan.reason).toBe('shortened-for-pair');
    expect(plan.endAt).toBeCloseTo(200, 6);
  });

  it('ignores cues that are not numbers rather than planning from them', () => {
    const broken = cues({ end: Number.NaN, fullEnd: Number.NaN });
    const plan = mixPlan(40, 200, 180, { outCues: broken });
    expect(Number.isFinite(plan.startAt)).toBe(true);
    expect(plan.startAt).toBeGreaterThanOrEqual(190 - 1e-9);
    expect(plan.endAt).toBeLessThanOrEqual(200);
  });
});

describe('placing the blend on the beat', () => {
  // 120 BPM: a beat every 0.5 s, one of them at 193.25 s.
  const out = cues({ end: 200, fullEnd: 198, tail: grid(120, 193.25) });
  const onOutBeat = (t: number) => Math.abs(((t - 193.25) / 0.5) - Math.round((t - 193.25) / 0.5)) < 1e-6;

  it('brings the next song in so that its first beat lands on a beat of the song playing', () => {
    // First sound at 0.4 s, first beat at 0.62 s: 0.22 s of pickup are heard before the beat.
    const plan = mixPlan(40, 200, 180, { outCues: out, inCues: cues({ duration: 180, start: 0.4, end: 180, fullEnd: 180, head: grid(120, 0.62) }) });
    expect(plan.beat).toBe('locked');
    expect(plan.rate).toBe(1);
    expect(onOutBeat(plan.startAt + 0.22)).toBe(true);
    expect(plan.startAt).toBeGreaterThanOrEqual(190);
    // A whole number of beats after that first one, in fours.
    const beats = (plan.seconds - 0.22) / 0.5;
    expect(beats).toBeCloseTo(Math.round(beats), 6);
    expect(Math.round(beats) % 4).toBe(0);
    expect(plan.endAt).toBeLessThanOrEqual(199 + 1e-9);
    expect(plan.description).toContain('beat-matched at 120 BPM');
  });

  it('nudges a close tempo onto the outgoing one, and compares half and double time as equal', () => {
    const at = (bpm: number) => mixPlan(40, 200, 180, { outCues: out, inCues: cues({ duration: 180, head: grid(bpm, 0.5) }) });
    expect(at(124).beat).toBe('locked');
    expect(at(124).rate).toBeCloseTo(120 / 124, 9);
    expect(at(116).rate).toBeCloseTo(120 / 116, 9);
    expect(at(62).beat).toBe('locked');
    expect(at(62).rate).toBeCloseTo(120 / 124, 9);
    expect(at(62).tempo).toBe('half-or-double');
    expect(foldedRatio(120, 62)).toBeCloseTo(120 / 124, 9);
    expect(foldedRatio(60, 124)).toBeCloseTo(120 / 124, 9);
    expect(Number.isNaN(foldedRatio(0, 120))).toBe(true);
  });

  it('does not bend a tempo that is too far away: the song comes in on the beat at its own speed', () => {
    const plan = mixPlan(40, 200, 180, { outCues: out, inCues: cues({ duration: 180, start: 0.3, head: grid(96, 0.3) }) });
    expect(plan.beat).toBe('entry');
    expect(plan.rate).toBe(1);
    expect(plan.tempo).toBe('unrelated');
    expect(onOutBeat(plan.startAt)).toBe(true);
    expect(plan.description).toContain('in on the beat');
    expect(plan.description).not.toContain('beat-matched');
  });

  it('a player that cannot change tempo is never asked to (maxNudge 0 locks only equal tempos)', () => {
    const near = mixPlan(40, 200, 180, { maxNudge: 0, outCues: out, inCues: cues({ duration: 180, head: grid(124, 0.5) }) });
    expect(near.beat).toBe('entry');
    expect(near.rate).toBe(1);
    const same = mixPlan(40, 200, 180, { maxNudge: 0, outCues: out, inCues: cues({ duration: 180, head: grid(120, 0.5) }) });
    expect(same.beat).toBe('locked');
  });

  it('claims no beat when either grid is missing or not trusted', () => {
    const untrusted = mixPlan(40, 200, 180, { outCues: cues({ end: 200, fullEnd: 198, tail: grid(120, 193.25, 0.6) }), inCues: cues({ duration: 180, head: grid(120, 0.5) }) });
    expect(untrusted.beat).toBe('none');
    expect(untrusted.rate).toBe(1);
    expect(untrusted.description).not.toMatch(/beat/);
    // The outgoing grid alone is enough to start on its beat; the incoming song is not nudged.
    const alone = mixPlan(40, 200, 180, { outCues: out, inCues: cues({ duration: 180, head: grid(120, 0.5, 0.2) }) });
    expect(alone.beat).toBe('entry');
    expect(alone.rate).toBe(1);
    expect(onOutBeat(alone.startAt)).toBe(true);
  });

  it('falls back to a plain blend when fewer than two beats fit', () => {
    // 60 BPM and only 2.0 s available: at most one whole beat after snapping.
    const plan = mixPlan(40, 200, 180, { outCues: cues({ end: 198, fullEnd: 170, tail: grid(60, 169.7) }), inCues: IN });
    expect(plan.beat).toBe('none');
    expect(plan.seconds).toBeCloseTo(2, 6);
  });
});

describe('trading the low end', () => {
  const out = cues({ end: 200, fullEnd: 198, tail: grid(120, 193.25) });
  const locked = cues({ duration: 180, start: 0, head: grid(120, 0) });
  const apart = cues({ duration: 180, start: 0, head: grid(96, 0) });

  it('swaps on a beat, halfway through when the songs are in step', () => {
    const plan = mixPlan(40, 200, 180, { outCues: out, inCues: locked });
    expect(plan.style).toBe('bass-swap');
    expect(plan.swapAt).not.toBeNull();
    const centre = plan.swapAt! + plan.swapSeconds / 2;
    expect(centre / 0.5).toBeCloseTo(Math.round(centre / 0.5), 6);
    expect(centre).toBeCloseTo(plan.seconds / 2, 6);
    expect(plan.swapSeconds).toBeCloseTo(0.5, 6);
  });

  it('swaps early when the tempos differ, so two kick patterns are not layered for long', () => {
    const plan = mixPlan(40, 200, 180, { outCues: out, inCues: apart });
    const centre = plan.swapAt! + plan.swapSeconds / 2;
    expect(centre).toBeLessThanOrEqual(plan.seconds * 0.4);
    expect(centre).toBeGreaterThan(0);
    expect(plan.swapAt! + plan.swapSeconds).toBeLessThan(plan.seconds);
  });

  it('swaps a third of the way in when there is no grid at all', () => {
    const plan = mixPlan(40, 200, 180, { outCues: OUT, inCues: IN });
    expect(plan.swapAt! + plan.swapSeconds / 2).toBeCloseTo(plan.seconds / 3, 6);
    expect(plan.swapAt!).toBeGreaterThanOrEqual(0);
  });

  it('a plain Subtle blend has no bass handoff to place', () => {
    const plan = mixPlan(20, 200, 180, { outCues: out, inCues: locked });
    expect(plan.style).toBe('blend');
    expect(plan.swapAt).toBeNull();
    expect(plan.swapSeconds).toBe(0);
    expect(plan.beat).toBe('locked');
  });
});
