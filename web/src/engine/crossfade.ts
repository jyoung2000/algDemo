/**
 * MIXER-001 — the single mixing slider and the crossfade maths behind it.
 *
 * One continuous value from 0 to 100 decides everything, per the owner's brief: no separate knobs
 * for duration, curve or effects. Higher asks for a longer, more gradual blend — never for more
 * volume.
 *
 * Everything here is pure arithmetic so it can be tested without an AudioContext. The scheduling
 * and the gain ramps live in `audio-bus.ts`.
 */

/** The five words under the slider. */
export const MIX_LABELS = ['Off', 'Subtle', 'Smooth', 'Creative', 'Long & Creative'] as const;
export type MixLabel = (typeof MIX_LABELS)[number];

export const MIX_MIN = 0;
export const MIX_MAX = 100;

/**
 * Requested overlap for each band of the slider, in seconds.
 *
 * The brief's envelopes run to 64s, which assumes whole songs. This app's mixable audio is the
 * 30-second Deezer preview, so a request is an upper bound that `mixPlan` then clamps against the
 * material — the brief is explicit that quality limits override the requested duration.
 */
const BANDS: readonly { upTo: number; label: MixLabel; lo: number; hi: number }[] = [
  { upTo: 0, label: 'Off', lo: 0, hi: 0 },
  { upTo: 25, label: 'Subtle', lo: 0.5, hi: 6 },
  { upTo: 50, label: 'Smooth', lo: 6, hi: 16 },
  { upTo: 75, label: 'Creative', lo: 16, hi: 32 },
  { upTo: 100, label: 'Long & Creative', lo: 32, hi: 64 },
];

/**
 * No blend may eat more than this share of the shorter track. A 30s preview therefore tops out at
 * 12s of overlap, which still leaves each song 18s of its own.
 */
export const MAX_TRACK_FRACTION = 0.4;
/** Below this there is nothing to fade; hand over cleanly instead. */
export const MIN_USEFUL_SECONDS = 0.25;

/** Beats per bar assumed for quantising. Four is right for the overwhelming majority of this music. */
export const BEATS_PER_BAR = 4;
/**
 * How far the incoming track's tempo may be nudged to meet the outgoing one, as a ratio.
 * Beyond a few percent, time-stretching in a plain media element is audible as warble, so the
 * planner would rather mix two slightly different tempos than smear one.
 */
export const MAX_TEMPO_NUDGE = 0.06;
/**
 * Two tempos this close (after half/double folding) count as the same grid.
 *
 * Tied deliberately to `MAX_TEMPO_NUDGE`: only the incoming deck moves, so a pair further apart
 * than the nudge can bridge is not a match — calling it one would schedule a beat-matched blend
 * that then drifts. 85 against 150 BPM is 12% apart doubled, and does not qualify.
 */
export const TEMPO_MATCH_TOLERANCE = MAX_TEMPO_NUDGE;

/**
 * What the transition is allowed to do, in rising order of ambition.
 *
 * The names follow the vocabulary the reference players use (BKmasterplayer: "bass swap, filter,
 * echo, blend or cut"), so behaviour is comparable to an established implementation.
 */
export type TransitionStyle = 'cut' | 'blend' | 'bass-swap' | 'filter';

/** Seconds in one bar at this tempo, or null when the tempo is unknown. */
export function barSeconds(bpm: number | null | undefined): number | null {
  if (!Number.isFinite(bpm as number) || (bpm as number) <= 0) return null;
  return (BEATS_PER_BAR * 60) / (bpm as number);
}

export type TempoRelation = 'same' | 'half-or-double' | 'unrelated' | 'unknown';

/**
 * How two tempos relate, folding half and double time together.
 *
 * A 64 BPM track and a 128 BPM one share a beat grid; the reference auto-mixer flags exactly that
 * pair as mixable, so treating them as unrelated would refuse a transition that works.
 */
export function tempoRelation(outBpm: number | null | undefined, inBpm: number | null | undefined): TempoRelation {
  const a = Number(outBpm);
  const b = Number(inBpm);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 'unknown';
  const near = (x: number, y: number) => Math.abs(x - y) / Math.max(x, y) <= TEMPO_MATCH_TOLERANCE;
  if (near(a, b)) return 'same';
  if (near(a * 2, b) || near(a, b * 2)) return 'half-or-double';
  return 'unrelated';
}

/**
 * The playback rate to put the incoming deck at so its beat grid lines up with the outgoing one.
 *
 * Returns 1 when the tempos are unknown, already matched, or too far apart to bridge without
 * audible stretching. Half and double time need no nudge at all: the grids already coincide.
 */
export function tempoNudge(outBpm: number | null | undefined, inBpm: number | null | undefined): number {
  const rel = tempoRelation(outBpm, inBpm);
  if (rel === 'unknown' || rel === 'unrelated' || rel === 'half-or-double') return 1;
  const a = Number(outBpm);
  const b = Number(inBpm);
  const ratio = a / b;
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return clamp(ratio, 1 - MAX_TEMPO_NUDGE, 1 + MAX_TEMPO_NUDGE);
}

/**
 * Shorten a blend to a whole number of bars so it begins and ends musically.
 *
 * Always rounds DOWN, never past one bar: lengthening would push the fade past the end of the
 * song. Returns the original length when the tempo is unknown or a single bar will not fit.
 */
export function quantizeToBars(seconds: number, bpm: number | null | undefined): { seconds: number; bars: number } {
  const bar = barSeconds(bpm);
  if (!bar || !Number.isFinite(seconds) || seconds <= 0) return { seconds: Math.max(0, seconds || 0), bars: 0 };
  const bars = Math.floor(seconds / bar);
  if (bars < 1) return { seconds, bars: 0 };
  return { seconds: bars * bar, bars };
}

/** Which techniques the slider has unlocked. Higher asks for more, never for more volume. */
export function transitionStyle(slider: number): TransitionStyle {
  const s = clampSlider(slider);
  if (s <= 0) return 'cut';
  if (s <= 25) return 'blend';
  if (s <= 50) return 'bass-swap';
  return 'filter';
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export const clampSlider = (v: number): number => (Number.isFinite(v) ? Math.round(clamp(v, MIX_MIN, MIX_MAX)) : MIX_MIN);

/** Which band a slider value sits in. */
export function mixBand(slider: number): { label: MixLabel; lo: number; hi: number } {
  const s = clampSlider(slider);
  const band = BANDS.find((b) => s <= b.upTo) ?? BANDS[BANDS.length - 1]!;
  return { label: band.label, lo: band.lo, hi: band.hi };
}

export const mixLabel = (slider: number): MixLabel => mixBand(slider).label;

/** The overlap the slider is asking for, before the material gets a say. */
export function requestedSeconds(slider: number): number {
  const s = clampSlider(slider);
  if (s <= 0) return 0;
  const band = BANDS.find((b) => s <= b.upTo)!;
  const prev = BANDS[BANDS.indexOf(band) - 1]?.upTo ?? 0;
  const span = band.upTo - prev;
  const t = span <= 0 ? 1 : (s - prev) / span;
  return band.lo + (band.hi - band.lo) * t;
}

export type MixReason = 'off' | 'as-requested' | 'shortened-for-pair' | 'too-short-to-blend';

/** What the planner knows about the two songs beyond their length. */
export interface MixInputs {
  outBpm?: number | null;
  inBpm?: number | null;
}

export interface MixPlan {
  /** Seconds of overlap actually scheduled. 0 means a clean handoff. */
  seconds: number;
  /** Where in the outgoing track the blend begins, in seconds from its start. */
  startAt: number;
  label: MixLabel;
  requested: number;
  reason: MixReason;
  /** Whole bars the blend spans, or 0 when it could not be quantised. */
  bars: number;
  /** How the two tempos relate, which is why the blend was or was not beat-matched. */
  tempo: TempoRelation;
  /** Playback rate for the incoming deck. 1 means leave it alone. */
  rate: number;
  /** What the transition is allowed to do. */
  style: TransitionStyle;
  /** One read-only line for the UI, e.g. "Smooth • about 9 seconds". */
  description: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function describe(label: MixLabel, seconds: number, reason: MixReason, bars = 0, tempo: TempoRelation = 'unknown'): string {
  if (reason === 'off') return 'Off • songs play one after another';
  if (reason === 'too-short-to-blend') return `${label} • too short to blend, clean handoff`;
  const about = seconds >= 10 ? `${Math.round(seconds)}` : `${round1(seconds)}`;
  const tail = reason === 'shortened-for-pair' ? ', shortened for this pair' : '';
  // A bar-quantised blend is worth saying so: it is the difference between a volume ramp and a mix.
  const beat = bars > 0 ? `, ${bars} ${bars === 1 ? 'bar' : 'bars'} on the beat` : tempo === 'unrelated' ? ', tempos too far apart to beat-match' : '';
  return `${label} • about ${about} seconds${tail}${beat}`;
}

/**
 * Work out the blend for one pair of songs.
 *
 * @param slider      0..100.
 * @param outSeconds  Playable length of the outgoing song.
 * @param inSeconds   Playable length of the incoming song.
 * @param inputs      Tempos, when known, so the blend can land on the beat.
 *
 * Both lengths matter: a long outgoing song cannot be blended into a 3-second incoming one. An
 * unknown length (0, NaN) is treated as unknown rather than infinite, and the blend is skipped,
 * because guessing here produces an audible mistake.
 *
 * With tempos, the blend is snapped DOWN to a whole number of bars and the incoming deck gets a
 * playback rate that lines its grid up with the outgoing one. That is what makes this a mix rather
 * than a volume ramp, and it is the one thing every reference auto-DJ insists on. Without tempos it
 * degrades to a plain equal-power crossfade, which is what BitChord's automix falls back to too.
 */
export function mixPlan(slider: number, outSeconds: number, inSeconds: number, inputs: MixInputs = {}): MixPlan {
  const s = clampSlider(slider);
  const label = mixLabel(s);
  const requested = requestedSeconds(s);
  const known = (n: number) => Number.isFinite(n) && n > 0;
  const style = transitionStyle(s);
  const tempo = tempoRelation(inputs.outBpm, inputs.inBpm);
  const flat = { label, requested, bars: 0, tempo, rate: 1, style } as const;

  if (s <= 0) {
    return { ...flat, seconds: 0, startAt: known(outSeconds) ? outSeconds : 0, style: 'cut', reason: 'off', description: describe(label, 0, 'off') };
  }
  if (!known(outSeconds) || !known(inSeconds)) {
    return { ...flat, seconds: 0, startAt: known(outSeconds) ? outSeconds : 0, reason: 'too-short-to-blend', description: describe(label, 0, 'too-short-to-blend') };
  }

  const ceiling = Math.min(outSeconds, inSeconds) * MAX_TRACK_FRACTION;
  const capped = Math.min(requested, ceiling);
  // Snap to whole bars of the OUTGOING song: that is the groove the listener is already in.
  const quantised = tempo === 'unrelated' || tempo === 'unknown' ? { seconds: capped, bars: 0 } : quantizeToBars(capped, inputs.outBpm);
  const seconds = quantised.seconds;
  if (seconds < MIN_USEFUL_SECONDS) {
    return { ...flat, seconds: 0, startAt: outSeconds, reason: 'too-short-to-blend', description: describe(label, 0, 'too-short-to-blend') };
  }
  // Bar rounding is a musical choice, not a limitation of the pair, so it does not count as
  // "shortened for this pair" — only the track-length ceiling does.
  const reason: MixReason = capped < requested - 0.05 ? 'shortened-for-pair' : 'as-requested';
  return {
    ...flat,
    seconds,
    startAt: Math.max(0, outSeconds - seconds),
    bars: quantised.bars,
    rate: tempoNudge(inputs.outBpm, inputs.inBpm),
    reason,
    description: describe(label, seconds, reason, quantised.bars, tempo),
  };
}

/**
 * Equal-power crossfade gains at `progress` through the blend (0 = all outgoing, 1 = all incoming).
 *
 * A straight linear pair dips about 3 dB in the middle, which is heard as a sag in the mix. The
 * sine/cosine pair keeps out^2 + in^2 at 1 all the way across, so the perceived loudness holds.
 */
export function equalPower(progress: number): { out: number; in: number } {
  const t = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
  const angle = (t * Math.PI) / 2;
  return { out: Math.cos(angle), in: Math.sin(angle) };
}

/** Where the incoming song should be cued so the two land together at the blend's end. */
export const incomingStartOffset = (): number => 0;
