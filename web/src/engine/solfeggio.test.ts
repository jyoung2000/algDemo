// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  EQ_BANDS_HZ,
  EQ_PRESETS,
  SOLFEGGIO,
  SOLFEGGIO_DB,
  SOLFEGGIO_Q,
  applyPreset,
  createEqGraph,
  eqCurve,
  matchesPreset,
  parseEq,
  presetById,
  requiredHeadroomDb,
  responseDbAt,
  type EqConfig,
} from './eq';

/**
 * SOLFEGGIO-001 — one preset per solfeggio tone, each lifting the frequency it is named after.
 *
 * The ten fixed bands cannot do this: the nearest centre to 528Hz is 500Hz, so a "528 Hz" preset
 * built from the bands alone would lift 500Hz and be a lie. Each preset therefore carries a narrow
 * peaking filter at exactly its own frequency, and these rules check the response, not the label.
 */
const on = (over: Partial<EqConfig> = {}): EqConfig => ({ ...parseEq({}), on: true, ...over });

describe('the solfeggio presets (SOLFEGGIO-001)', () => {
  it('offers all nine tones, named with their frequency', () => {
    expect(SOLFEGGIO.map((s) => s.hz)).toEqual([174, 285, 396, 417, 528, 639, 741, 852, 963]);
    for (const t of SOLFEGGIO) {
      const preset = presetById(`solfeggio-${t.hz}`);
      expect(preset, `${t.hz} Hz preset`).toBeTruthy();
      expect(preset!.name).toContain(`${t.hz} Hz`);
      expect(preset!.toneHz).toBe(t.hz);
    }
    // 432Hz is a tuning, not a tone: it would need a pitch shift, so it is deliberately absent.
    expect(EQ_PRESETS.some((p) => p.name.includes('432'))).toBe(false);
  });

  it('lifts the named frequency, and the named frequency most of all', () => {
    for (const t of SOLFEGGIO) {
      const cfg = applyPreset(on(), `solfeggio-${t.hz}`);
      const atTone = responseDbAt(cfg, t.hz);
      expect(atTone, `${t.hz} Hz lifted`).toBeGreaterThan(SOLFEGGIO_DB);
      // Nothing else in the audible range is lifted more than the tone itself.
      for (let i = 0; i < 200; i += 1) {
        const hz = 20 * (20000 / 20) ** (i / 199);
        if (Math.abs(Math.log2(hz / t.hz)) < 0.05) continue;
        expect(responseDbAt(cfg, hz), `${Math.round(hz)} Hz vs ${t.hz} Hz`).toBeLessThan(atTone);
      }
    }
  });

  it('keeps the resonance narrow: an octave away, almost none of it is left', () => {
    const cfg = applyPreset(on(), 'solfeggio-528');
    const peak = responseDbAt(cfg, 528);
    const nearest = EQ_BANDS_HZ.reduce((a, b) => (Math.abs(b - 528) < Math.abs(a - 528) ? b : a));
    expect(nearest).toBe(500); // the point of the extra filter
    // A sixth of an octave either side keeps most of it; a full octave away keeps very little.
    expect(responseDbAt(cfg, 528 * 2) - 2).toBeLessThan(peak - SOLFEGGIO_DB + 1);
    expect(responseDbAt(cfg, 528 / 2) - 2).toBeLessThan(peak - SOLFEGGIO_DB + 1);
  });

  it('shows the tone as a spike on the drawn curve', () => {
    const cfg = applyPreset(on(), 'solfeggio-741');
    const [below, at, above] = eqCurve(cfg, [741 / 1.5, 741, 741 * 1.5]);
    expect(at).toBeGreaterThan(below! + 3);
    expect(at).toBeGreaterThan(above! + 3);
  });

  it('trims enough headroom for the boost, so the resonance cannot clip', () => {
    const cfg = applyPreset(on(), 'solfeggio-528');
    expect(requiredHeadroomDb(cfg)).toBeGreaterThanOrEqual(responseDbAt(cfg, 528) - 0.01);
  });

  it('belongs to the preset, and leaving the preset takes it away', () => {
    const chosen = applyPreset(on(), 'solfeggio-396');
    expect(chosen.toneHz).toBe(396);
    expect(matchesPreset(chosen)).toBe(true);
    const rock = applyPreset(chosen, 'rock');
    expect(rock.toneHz).toBeNull();
    expect(responseDbAt(rock, 396)).toBeLessThan(responseDbAt(chosen, 396));
    // A hand-moved slider is 'custom', and a stored tone from nowhere is refused.
    expect(parseEq({ ...chosen, toneHz: 777 }).toneHz).toBeNull();
    expect(parseEq({ ...chosen, toneHz: 528 }).toneHz).toBe(528);
  });

  it('puts a real filter at that frequency in the live graph, at the right Q, and takes it to zero when the EQ is off', () => {
    const made: Array<{ type: string; frequency: { value: number; setValueAtTime: (v: number, t: number) => void }; Q: { value: number }; gain: { value: number; cancelScheduledValues: () => void; setValueAtTime: () => void; linearRampToValueAtTime: (v: number) => void } }> = [];
    const param = () => {
      const p = {
        value: 0,
        cancelScheduledValues: () => {},
        setValueAtTime: (v: number) => void (p.value = v),
        linearRampToValueAtTime: (v: number) => void (p.value = v),
      };
      return p;
    };
    const node = () => ({ connect: () => {}, disconnect: () => {}, gain: param() });
    const ctx = {
      currentTime: 0,
      sampleRate: 48000,
      destination: node(),
      createGain: () => node(),
      createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
      createBiquadFilter: () => {
        const f = { type: 'peaking', frequency: param(), Q: param(), gain: param(), connect: () => {}, disconnect: () => {} };
        made.push(f as never);
        return f;
      },
    } as never;
    const graph = createEqGraph(ctx, node() as never, applyPreset(on(), 'solfeggio-852'));
    // Eleven filters: the ten fixed bands and the resonance.
    expect(made).toHaveLength(EQ_BANDS_HZ.length + 1);
    const tone = made.find((f) => f.frequency.value === 852);
    expect(tone, 'a filter at 852 Hz').toBeTruthy();
    expect(tone!.Q.value).toBe(SOLFEGGIO_Q);
    expect(tone!.gain.value).toBe(SOLFEGGIO_DB);
    expect(graph.peek().toneHz).toBe(852);
    graph.apply(applyPreset({ ...on(), on: false }, 'solfeggio-852'));
    expect(tone!.gain.value).toBe(0);
    expect(graph.peek().toneHz).toBeNull();
  });
});
