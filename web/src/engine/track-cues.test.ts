import { describe, expect, it, vi } from 'vitest';

import { CUE_RATE, analyseCues, analyseEnds, beatError, createCueLibrary, gridUsable, type CuePcm } from './track-cues';

/**
 * DJ-XFADE-001. Songs are synthesised so the right answer is known exactly: a kick on every beat
 * over a steady pad, with optional silence in front, a fade-out behind and a seeded hiss.
 */
interface Song {
  seconds: number;
  bpm?: number;
  /** Time of the first beat. */
  first?: number;
  /** Silence before the music. */
  lead?: number;
  /** The music fades out over this long … */
  fade?: number;
  /** … and is followed by this much silence. */
  trail?: number;
  /** From this time on the beat is displaced by half a beat (a rhythm that does not hold). */
  slipAt?: number;
  seed?: number;
}

function song(spec: Song): Float32Array {
  const rate = CUE_RATE;
  const n = Math.floor(spec.seconds * rate);
  const x = new Float32Array(n);
  const lead = spec.lead ?? 0;
  const musicEnd = spec.seconds - (spec.trail ?? 0);
  const fadeFrom = musicEnd - (spec.fade ?? 0);
  let seed = (spec.seed ?? 1) >>> 0;
  const beat = spec.bpm ? 60 / spec.bpm : 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / rate;
    seed = (seed ^ (seed << 13)) >>> 0;
    seed = (seed ^ (seed >>> 17)) >>> 0;
    seed = (seed ^ (seed << 5)) >>> 0;
    if (t < lead || t >= musicEnd) continue;
    const level = t > fadeFrom ? Math.max(0, (musicEnd - t) / (spec.fade ?? 1)) : 1;
    let v = 0.08 * Math.sin(2 * Math.PI * 220 * t) + 0.02 * ((seed / 4294967296) * 2 - 1);
    if (beat) {
      const origin = (spec.first ?? lead) + (spec.slipAt !== undefined && t >= spec.slipAt ? beat / 2 : 0);
      const since = (((t - origin) % beat) + beat) % beat;
      if (t >= origin) v += 0.7 * Math.exp(-since * 28) * Math.sin(2 * Math.PI * 60 * since);
    }
    x[i] = v * level;
  }
  return x;
}

describe('where the music is', () => {
  it('finds the first sound, the last sound, and where the song leaves its level', () => {
    const cues = analyseCues(song({ seconds: 120, bpm: 120, lead: 0.5, fade: 6, trail: 2 }), CUE_RATE);
    expect(cues.duration).toBeCloseTo(120, 3);
    expect(cues.start).toBeCloseTo(0.5, 1);
    // Music stops at 118 s after a fade that began at 112 s: the song leaves its level inside
    // the fade, well before the last audible sound, which is well before the end of the file.
    expect(cues.end).toBeGreaterThan(117);
    expect(cues.end).toBeLessThanOrEqual(118.05);
    expect(cues.fullEnd).toBeGreaterThan(113);
    expect(cues.fullEnd).toBeLessThan(cues.end - 0.3);
  });

  it('a song that stops dead at full level ends where it stops', () => {
    const cues = analyseCues(song({ seconds: 90, bpm: 100 }), CUE_RATE);
    expect(cues.start).toBeLessThan(0.06);
    expect(cues.end).toBeCloseTo(90, 1);
    expect(cues.fullEnd).toBeCloseTo(90, 1);
  });

  it('silence throughout is not turned into cues that would cut a song short', () => {
    const cues = analyseCues(new Float32Array(CUE_RATE * 60), CUE_RATE);
    expect(cues.start).toBe(0);
    expect(cues.end).toBe(60);
    expect(cues.fullEnd).toBe(60);
    expect(cues.head).toBeNull();
    expect(cues.tail).toBeNull();
  });
});

describe('where the beats are', () => {
  it.each([90, 120, 128, 140])('measures a steady %d BPM grid at both ends, on the beat', (bpm) => {
    const first = 0.5;
    const cues = analyseCues(song({ seconds: 150, bpm, lead: 0.5, first, fade: 4, trail: 1 }), CUE_RATE);
    const beat = 60 / bpm;
    for (const grid of [cues.head, cues.tail]) {
      expect(gridUsable(grid)).toBe(true);
      expect(grid!.bpm).toBeCloseTo(bpm, 0);
      // Onsets are detected a hop or two after the transient; a beat is hundreds of ms.
      expect(Math.abs(beatError(grid!.beatAt, first, beat))).toBeLessThan(0.03);
    }
    // The tail's anchor is the last beat before the song leaves its level, so plans count from it.
    expect(cues.tail!.beatAt).toBeLessThanOrEqual(cues.fullEnd);
    expect(cues.fullEnd - cues.tail!.beatAt).toBeLessThan(beat + 0.03);
  });

  it('does not claim a grid for music with no beat', () => {
    const cues = analyseCues(song({ seconds: 120, seed: 9 }), CUE_RATE);
    expect(gridUsable(cues.head)).toBe(false);
    expect(gridUsable(cues.tail)).toBe(false);
  });

  it('does not trust a beat that moves: the two halves of the measured stretch must agree', () => {
    // Steady tempo, but the last 20 s sit half a beat away from the 20 s before them.
    const steady = analyseCues(song({ seconds: 150, bpm: 120 }), CUE_RATE);
    const slipped = analyseCues(song({ seconds: 150, bpm: 120, slipAt: 130 }), CUE_RATE);
    expect(gridUsable(steady.tail)).toBe(true);
    expect(gridUsable(slipped.tail)).toBe(false);
  });

  it('folds a timing error to the nearest beat', () => {
    expect(beatError(10.02, 10, 0.5)).toBeCloseTo(0.02, 9);
    expect(beatError(10.48, 10, 0.5)).toBeCloseTo(-0.02, 9);
    expect(beatError(3, 10.01, 0.5)).toBeCloseTo(-0.01, 9);
  });
});

describe('measuring from the two ends alone', () => {
  it('gives the same cues as measuring the whole song', () => {
    const whole = song({ seconds: 200, bpm: 124, lead: 0.3, first: 0.3, fade: 5, trail: 1.5 });
    const all = analyseCues(whole, CUE_RATE);
    const head = whole.subarray(0, CUE_RATE * 50);
    const tail = whole.subarray(whole.length - CUE_RATE * 80);
    const ends = analyseEnds(head, tail, CUE_RATE, 200);
    expect(ends.start).toBeCloseTo(all.start, 6);
    expect(ends.end).toBeCloseTo(all.end, 6);
    expect(ends.fullEnd).toBeCloseTo(all.fullEnd, 6);
    expect(ends.tail!.bpm).toBeCloseTo(all.tail!.bpm, 6);
    expect(ends.tail!.beatAt).toBeCloseTo(all.tail!.beatAt, 6);
    expect(ends.head!.beatAt).toBeCloseTo(all.head!.beatAt, 6);
  });
});

describe('the cue library', () => {
  const pcm = (): CuePcm => {
    const mono = song({ seconds: 70, bpm: 120 });
    return { head: mono, tail: mono, rate: CUE_RATE, duration: 70 };
  };

  it('measures each URL once and answers peek only after it has', async () => {
    const load = vi.fn(async () => pcm());
    const library = createCueLibrary(load);
    expect(library.peek('/local-audio?u=a')).toBeNull();
    const [one, two] = await Promise.all([library.get('/local-audio?u=a'), library.get('/local-audio?u=a')]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(one).toBe(two);
    expect(library.peek('/local-audio?u=a')?.duration).toBe(70);
  });

  it('a song that cannot be decoded has no cues rather than an error', async () => {
    const library = createCueLibrary(async () => { throw new Error('decode failed'); });
    await expect(library.get('/local-audio?u=bad')).resolves.toBeNull();
    expect(library.peek('/local-audio?u=bad')).toBeNull();
    const empty = createCueLibrary(async () => null);
    await expect(empty.get('/local-audio?u=none')).resolves.toBeNull();
  });

  it('forgets the oldest songs beyond its capacity', async () => {
    const load = vi.fn(async () => pcm());
    const library = createCueLibrary(load, 2);
    await library.get('a'); await library.get('b'); await library.get('c');
    expect(library.peek('a')).toBeNull();
    expect(library.peek('c')).not.toBeNull();
    await library.get('a');
    expect(load).toHaveBeenCalledTimes(4);
  });
});
