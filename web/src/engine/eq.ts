/**
 * EQ-001 — a ten-band equalizer for the preview player.
 *
 * Ported in spirit from the Airwave player's `packages/audio-core` (graph.ts, presets.ts), reduced
 * to what this demo can actually use and with no monorepo dependencies, so the browser half keeps
 * building on its own. The chain, and the reasons for it:
 *
 *   source → preamp → band 0..9 (peaking) → headroom trim → limiter → output → destination
 *          ↘──────────────── bypass (level-matched) ────────────────↗
 *
 * - **Peaking biquads at fixed centres.** The same ten centres the player uses, so a preset means
 *   the same thing in both apps.
 * - **Headroom trim, shown not hidden.** Boosting several bands by 8 dB will clip; the trim that
 *   prevents it is computed from the bands and reported, never applied silently.
 * - **Level-matched bypass.** Comparing "EQ on" with a quieter "EQ off" is a loudness test, and
 *   louder always wins. The dry path is matched to the processed path's average level so the switch
 *   compares tone.
 * - **Every change is ramped**, never jumped, or the slider clicks.
 *
 * What it cannot do is stated by the caller, not hidden here: audio inside YouTube's or
 * SoundCloud's iframe belongs to that frame and no page script can filter it.
 */

/** The centre frequencies, matching the Airwave player's graphic bands. */
export const EQ_BANDS_HZ = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Q for every graphic band, as the player uses. */
export const EQ_Q = 1.1;

/**
 * The solfeggio tones, in Hz, with their traditional names (SOLFEGGIO-001).
 *
 * The names are the ones these tones are known by; Airwave makes no claim about what they do. 432Hz
 * is deliberately absent: it is a *tuning* reference (A=432), which means pitch-shifting the whole
 * song, not lifting one frequency — see design/decisions in the repo notes.
 */
export const SOLFEGGIO = [
  { hz: 174, name: 'Foundation' },
  { hz: 285, name: 'Repair' },
  { hz: 396, name: 'Release' },
  { hz: 417, name: 'Change' },
  { hz: 528, name: 'Transformation' },
  { hz: 639, name: 'Connection' },
  { hz: 741, name: 'Expression' },
  { hz: 852, name: 'Intuition' },
  { hz: 963, name: 'Clarity' },
] as const;

/**
 * How narrow the resonance is. Q 8 is about a sixth of an octave wide — tight enough that the named
 * frequency is the one lifted (and not its neighbours), wide enough to catch a note that is a few
 * hertz off, since no recording sits exactly on 528.000Hz.
 */
export const SOLFEGGIO_Q = 8;
/** How much the resonance lifts, in dB. The headroom trim keeps the result below full scale. */
export const SOLFEGGIO_DB = 6;
/** Whether this frequency is one of the solfeggio tones. */
export const isSolfeggio = (hz: number): boolean => SOLFEGGIO.some((s) => s.hz === hz);

export const EQ_GAIN_MIN_DB = -12;
export const EQ_GAIN_MAX_DB = 12;
export const EQ_PREAMP_MIN_DB = -12;
export const EQ_PREAMP_MAX_DB = 12;

/** Safety limiter: a −1 dBFS ceiling, as the player's. */
export const LIMITER = { thresholdDb: -1, knee: 0, ratio: 20, attackSeconds: 0.001, releaseSeconds: 0.05 } as const;

/** Ramp for a gain change, in seconds. Long enough not to click, short enough to feel immediate. */
const RAMP_S = 0.04;
/** The bypass crossfade, in seconds. */
const BYPASS_S = 0.03;

export type EqGains = number[];

export interface EqPreset {
  readonly id: string;
  readonly name: string;
  /** One gain per entry in EQ_BANDS_HZ. */
  readonly gains: readonly number[];
  readonly preampDb?: number;
  /** A solfeggio resonance at exactly this frequency, on top of the bands (SOLFEGGIO-001). */
  readonly toneHz?: number;
}

/**
 * The ten fixed bands around a solfeggio tone: a gentle lift on the two centres either side of it,
 * so the preset has a shape of its own and the resonance is not the only thing doing the work.
 */
function solfeggioGains(hz: number): number[] {
  return EQ_BANDS_HZ.map((centre) => {
    const octaves = Math.abs(Math.log2(hz / centre));
    if (octaves <= 0.5) return 2;
    if (octaves <= 1.2) return 1;
    return 0;
  });
}

/**
 * The built-in presets. "Flat" first so it is the default, then the iTunes-style set the player
 * ships, so a listener moving between the two apps finds the same names.
 */
export const EQ_PRESETS: readonly EqPreset[] = [
  { id: 'flat', name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'acoustic', name: 'Acoustic', gains: [4, 3.5, 2.5, 0.5, 1, 1, 2.5, 3, 2.5, 1.5] },
  { id: 'bass-booster', name: 'Bass booster', gains: [7, 5.5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'bass-reducer', name: 'Bass reducer', gains: [-7, -5.5, -4, -2, 0, 0, 0, 0, 0, 0] },
  { id: 'classical', name: 'Classical', gains: [5, 4, 3, 2.5, -1.5, -1.5, 0, 2, 3, 4] },
  { id: 'dance', name: 'Dance', gains: [6, 5, 2, 0, 1.5, 3, 4, 3.5, 2, 0] },
  { id: 'deep', name: 'Deep', gains: [6, 4.5, 2, 1, 3, 2, 1, -2, -3.5, -4] },
  { id: 'electronic', name: 'Electronic', gains: [5, 4, 1, 0, -1.5, 1.5, 0.5, 1.5, 4, 5] },
  { id: 'hip-hop', name: 'Hip-hop', gains: [6.5, 5.5, 2, 2.5, -1, -0.5, 1.5, -0.5, 2, 3] },
  { id: 'jazz', name: 'Jazz', gains: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 4] },
  { id: 'latin', name: 'Latin', gains: [5, 3.5, 0, 0, -1.5, -1.5, -1.5, 0, 3, 5] },
  { id: 'loudness', name: 'Loudness', gains: [7, 5.5, 0, 0, -2, 0, -1, -5, 5, 1] },
  { id: 'lounge', name: 'Lounge', gains: [-3, -1.5, -0.5, 1.5, 4, 2.5, 0, -1.5, 2, 1] },
  { id: 'piano', name: 'Piano', gains: [3, 2, 0, 2.5, 3, 1.5, 3.5, 4.5, 3, 2.5] },
  { id: 'pop', name: 'Pop', gains: [-1.5, -1, 0, 2.5, 4.5, 4.5, 2.5, 0, -1, -1.5] },
  { id: 'rb', name: 'R&B', gains: [3, 6.5, 5.5, 1.5, -2, -1.5, 2, 2.5, 3, 3.5] },
  { id: 'rock', name: 'Rock', gains: [5, 4, 3, 1.5, -0.5, -1, 0.5, 3, 4, 4.5] },
  { id: 'small-speakers', name: 'Small speakers', gains: [6, 5, 4, 2, 0, -1, -2, -3, -4, -5] },
  { id: 'spoken-word', name: 'Spoken word', gains: [-3.5, -0.5, 0, 1, 4, 4.5, 5, 4, 2, 0] },
  { id: 'treble-booster', name: 'Treble booster', gains: [0, 0, 0, 0, 0, 1.5, 3, 4.5, 6, 7] },
  { id: 'treble-reducer', name: 'Treble reducer', gains: [0, 0, 0, 0, 0, -1.5, -3, -4.5, -6, -7] },
  { id: 'vocal-booster', name: 'Vocal booster', gains: [-2, -3, -3, 1.5, 4, 4, 3, 1.5, 0, -1.5] },
  // One per solfeggio tone (SOLFEGGIO-001): a real resonance at the named frequency.
  ...SOLFEGGIO.map((t) => ({ id: `solfeggio-${t.hz}`, name: `${t.hz} Hz · ${t.name}`, gains: solfeggioGains(t.hz), toneHz: t.hz })),
];

export interface EqConfig {
  /** Whether the EQ processes the signal at all. */
  on: boolean;
  /** The preset the gains came from, or 'custom' once a slider is moved. */
  presetId: string;
  gains: EqGains;
  preampDb: number;
  /** The safety limiter. On by default: a loud boost clips without it. */
  limiter: boolean;
  /** The solfeggio resonance's frequency, or null for none (SOLFEGGIO-001). */
  toneHz?: number | null;
  /** How much that resonance lifts, in dB. */
  toneDb?: number;
}

export const EQ_DEFAULTS: EqConfig = {
  on: false,
  presetId: 'flat',
  gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  preampDb: 0,
  limiter: true,
  toneHz: null,
  toneDb: SOLFEGGIO_DB,
};

export const clampGain = (db: number): number => clamp(db, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB);
export const clampPreamp = (db: number): number => clamp(db, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB);

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

export const dbToGain = (db: number): number => 10 ** (db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(1e-6, g));

/** Normalise anything read back from storage into a usable config. */
export function parseEq(raw: unknown): EqConfig {
  const o = (raw ?? {}) as Partial<EqConfig>;
  const gains = Array.isArray(o.gains) ? o.gains : EQ_DEFAULTS.gains;
  return {
    on: o.on === true,
    presetId: typeof o.presetId === 'string' && o.presetId ? o.presetId : 'flat',
    // Always exactly one gain per band, whatever was stored.
    gains: EQ_BANDS_HZ.map((_, i) => clampGain(Number(gains[i] ?? 0))),
    preampDb: clampPreamp(Number(o.preampDb ?? 0)),
    limiter: o.limiter !== false,
    // Only a known tone is kept: a stored number from another build cannot put the filter anywhere.
    toneHz: typeof o.toneHz === 'number' && isSolfeggio(o.toneHz) ? o.toneHz : null,
    toneDb: clampGain(Number(o.toneDb ?? SOLFEGGIO_DB)),
  };
}

export function presetById(id: string): EqPreset | null {
  return EQ_PRESETS.find((p) => p.id === id) ?? null;
}

/** Apply a preset, returning the config it produces. */
export function applyPreset(config: EqConfig, id: string): EqConfig {
  const preset = presetById(id);
  if (!preset) return config;
  return {
    ...config,
    presetId: preset.id,
    gains: preset.gains.map(clampGain),
    preampDb: clampPreamp(preset.preampDb ?? 0),
    // A preset owns the resonance too: choosing Rock clears the tone, choosing 528 Hz sets it.
    toneHz: preset.toneHz ?? null,
  };
}

/** Whether these gains still match the named preset. Moving a slider makes the choice 'custom'. */
export function matchesPreset(config: EqConfig): boolean {
  const preset = presetById(config.presetId);
  if (!preset) return false;
  return (
    preset.gains.every((g, i) => Math.abs(g - (config.gains[i] ?? 0)) < 0.01) &&
    Math.abs((preset.preampDb ?? 0) - config.preampDb) < 0.01 &&
    (preset.toneHz ?? null) === (config.toneHz ?? null)
  );
}

/**
 * The combined response of the bands at one frequency, in dB, preamp included.
 *
 * A peaking biquad's gain at its own centre is its gain; away from the centre it falls off with Q.
 * This is the standard peaking magnitude, enough to size the headroom trim and to draw the curve.
 */
export function responseDbAt(config: EqConfig, hz: number): number {
  let db = config.preampDb;
  for (let i = 0; i < EQ_BANDS_HZ.length; i += 1) {
    const gain = config.gains[i] ?? 0;
    if (gain === 0) continue;
    const centre = EQ_BANDS_HZ[i]!;
    // Octave distance from the centre, shaped by Q: at the centre this is 1, falling to 0 away.
    const octaves = Math.log2(hz / centre);
    const bandwidth = 1 / EQ_Q;
    const weight = 1 / (1 + (octaves / bandwidth) ** 2 * 4);
    db += gain * weight;
  }
  if (config.toneHz) {
    // The same peaking shape, far narrower: this is what makes the named frequency the one lifted.
    const octaves = Math.log2(hz / config.toneHz);
    const bandwidth = 1 / SOLFEGGIO_Q;
    db += (config.toneDb ?? SOLFEGGIO_DB) * (1 / (1 + (octaves / bandwidth) ** 2 * 4));
  }
  return db;
}

/** The loudest point of the response, which is what could clip. Never negative. */
export function requiredHeadroomDb(config: EqConfig): number {
  let peak = 0;
  // Sample the audible range; the centres alone miss where two neighbouring boosts add up.
  for (let i = 0; i < 96; i += 1) {
    const hz = 20 * (20000 / 20) ** (i / 95);
    peak = Math.max(peak, responseDbAt(config, hz));
  }
  return Math.max(0, peak);
}

/** The trim that keeps the boosted signal below full scale. Always ≤ 0. */
export const headroomTrimDb = (config: EqConfig): number => -requiredHeadroomDb(config);

/**
 * The level the processed path averages to, so the dry path can be matched to it. The power mean
 * across the band centres, trim included — the same measure the player uses.
 */
export function matchedBypassDb(config: EqConfig): number {
  let sum = 0;
  for (const hz of EQ_BANDS_HZ) sum += dbToGain(responseDbAt(config, hz)) ** 2;
  return gainToDb(Math.sqrt(sum / EQ_BANDS_HZ.length)) + headroomTrimDb(config);
}

/** The curve for the UI: one dB value per frequency given. */
export const eqCurve = (config: EqConfig, frequencies: readonly number[]): number[] => frequencies.map((hz) => responseDbAt(config, hz));

/* ------------------------------------------------------------------ the graph */

/** What the EQ needs from an AudioContext, so a test can supply a double. */
export interface EqContext {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNode;
  createGain(): GainNode;
  createBiquadFilter(): BiquadFilterNode;
  createDynamicsCompressor(): DynamicsCompressorNode;
  createMediaElementSource(el: HTMLMediaElement): MediaElementAudioSourceNode;
}

export interface EqGraph {
  /** Push a whole config into the graph, ramping every value that changed. */
  apply(config: EqConfig): void;
  /** The trim currently applied, for the UI to report. */
  trimDb(): number;
  /**
   * The chain's last node. The mixer routes this into a per-deck gain instead of the speakers, so
   * two decks can be crossfaded after each has been equalised.
   */
  readonly output: AudioNode;
  /** What the graph is doing now: whether the wet path is live and each band's target gain in dB. */
  /** A read-only look at what the graph is doing, for the UI and for gates on the real build. */
  peek(): { on: boolean; bands: number[]; preampDb: number; trimDb: number; toneHz: number | null; toneDb: number };
  dispose(): void;
}

function ramp(param: AudioParam, value: number, at: number, seconds = RAMP_S): void {
  // Anchor at the present value first, or the ramp starts from whatever was last scheduled.
  try {
    param.cancelScheduledValues(at);
    param.setValueAtTime(param.value, at);
    param.linearRampToValueAtTime(value, at + seconds);
  } catch {
    param.value = value;
  }
}

/**
 * Build the chain around an already-created source node and run it to the destination.
 *
 * The source node is the caller's: a `MediaElementAudioSourceNode` can only be created once per
 * element for the lifetime of the page, so the player makes it once and hands it over.
 *
 * @param destination Where the chain ends. Defaults to the speakers; the mixer passes a deck gain
 *   so each deck is equalised before it is faded.
 */
export function createEqGraph(ctx: EqContext, source: AudioNode, initial: EqConfig = EQ_DEFAULTS, destination?: AudioNode): EqGraph {
  const now = () => ctx.currentTime;
  const preamp = ctx.createGain();
  const trim = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const limiterOut = ctx.createGain();
  const limiterBypass = ctx.createGain();
  const out = ctx.createGain();
  const wet = ctx.createGain();
  const dry = ctx.createGain();

  const bands = EQ_BANDS_HZ.map((hz) => {
    const f = ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = Math.min(hz, ctx.sampleRate / 2 - 1);
    f.Q.value = EQ_Q;
    f.gain.value = 0;
    return f;
  });

  // The solfeggio resonance (SOLFEGGIO-001), after the ten bands: silent (0 dB) unless a tone is set.
  const tone = ctx.createBiquadFilter();
  tone.type = 'peaking';
  tone.frequency.value = SOLFEGGIO[0].hz;
  tone.Q.value = SOLFEGGIO_Q;
  tone.gain.value = 0;

  // source → { wet → preamp → bands → trim → limiter|bypass → out, dry → out } → destination
  source.connect(wet);
  source.connect(dry);
  wet.connect(preamp);
  let node: AudioNode = preamp;
  for (const band of bands) {
    node.connect(band);
    node = band;
  }
  node.connect(tone);
  tone.connect(trim);
  trim.connect(limiter);
  trim.connect(limiterBypass);
  limiter.connect(limiterOut);
  limiterOut.connect(out);
  limiterBypass.connect(out);
  dry.connect(out);
  out.connect(destination ?? ctx.destination);

  limiter.threshold.value = LIMITER.thresholdDb;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attackSeconds;
  limiter.release.value = LIMITER.releaseSeconds;

  let trimNow = 0;
  let disposed = false;
  let current: EqConfig = initial;

  const apply = (config: EqConfig): void => {
    if (disposed) return;
    current = config;
    const t = now();
    const live = config.on;
    // Off hands the signal to the dry path at unity, so turning the EQ off gives back exactly what
    // the source sent and never a surprise change in volume.
    ramp(wet.gain, live ? 1 : 0, t, BYPASS_S);
    ramp(dry.gain, live ? 0 : 1, t, BYPASS_S);
    ramp(preamp.gain, dbToGain(live ? config.preampDb : 0), t);
    for (let i = 0; i < bands.length; i += 1) {
      const band = bands[i]!;
      ramp(band.gain, live ? clampGain(config.gains[i] ?? 0) : 0, t);
    }
    const toneHz = config.toneHz && isSolfeggio(config.toneHz) ? config.toneHz : null;
    if (toneHz) tone.frequency.setValueAtTime(Math.min(toneHz, ctx.sampleRate / 2 - 1), t);
    ramp(tone.gain, live && toneHz ? clampGain(config.toneDb ?? SOLFEGGIO_DB) : 0, t);
    trimNow = live ? headroomTrimDb(config) : 0;
    ramp(trim.gain, dbToGain(trimNow), t);
    // Exactly one of the two paths carries the signal. Leaving both open would pass the audio
    // twice — limited and unlimited summed — which is audibly wrong, not a subtle mistake.
    ramp(limiterOut.gain, config.limiter ? 1 : 0, t);
    ramp(limiterBypass.gain, config.limiter ? 0 : 1, t);
  };

  apply(initial);

  return {
    apply,
    trimDb: () => trimNow,
    output: out,
    peek: () => ({
      on: current.on,
      bands: bands.map((_, i) => (current.on ? clampGain(current.gains[i] ?? 0) : 0)),
      toneHz: current.on ? (current.toneHz ?? null) : null,
      toneDb: current.on && current.toneHz ? clampGain(current.toneDb ?? SOLFEGGIO_DB) : 0,
      preampDb: current.on ? current.preampDb : 0,
      trimDb: trimNow,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const n of [source, wet, dry, preamp, ...bands, tone, trim, limiter, limiterOut, limiterBypass, out]) {
        try {
          (n as AudioNode).disconnect();
        } catch {
          // Already gone; nothing to release.
        }
      }
    },
  };
}
