import { useEffect, useId, useState, type CSSProperties } from 'react';
import type { Settings } from './api';
import { REASON_TEXT, reason as engineReason, subscribeEngine } from './audio-engine';
import { MIX_LABELS, MIX_MAX, MIX_MIN, clampSlider, mixLabel } from './engine/crossfade';
import {
  EQ_BANDS_HZ, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB,
  EQ_PRESETS, applyPreset, clampGain, clampPreamp, headroomTrimDb, matchesPreset, parseEq,
  type EqConfig,
} from './engine/eq';
import './audio-settings.css';

interface Props {
  settings: Settings | null;
  onSettings: (patch: Partial<Settings>) => void;
}

const db = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
const fill = (value: number, min: number, max: number): CSSProperties =>
  ({ '--pct': `${((value - min) / (max - min)) * 100}%` } as CSSProperties);
/** The label every graphic equalizer prints under a band: "1K", not "1000 Hz". */
const shortHz = (hz: number) => (hz >= 1000 ? `${hz / 1000}K` : String(hz));

/**
 * One vertical fader. The input stays a native horizontal range — drag, arrow keys, Home/End,
 * the 44px target and the Aqua thumb all come for free — and is turned on its side by the
 * stylesheet, so left/right on the keyboard still mean down/up as they do on every rotated fader.
 */
function Fader({ id, label, name, value, min, max, step, onChange, strong }: {
  id: string; label: string; name: string; value: number; min: number; max: number; step: number;
  onChange: (value: number) => void; strong?: boolean;
}) {
  return (
    <div className={`eqr__band${strong ? ' eqr__band--preamp' : ''}`}>
      <output className="eqr__value" htmlFor={id} aria-hidden="true">{value > 0 ? '+' : ''}{value.toFixed(1)}</output>
      <div className="eqr__rail">
        <input
          id={id} type="range" min={min} max={max} step={step} value={value}
          aria-label={name} aria-orientation="vertical" aria-valuetext={db(value)}
          style={fill(value, min, max)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
      <span className="eqr__label" aria-hidden="true">{label}</span>
    </div>
  );
}

/** MIXER-001 / EQ-001: settings only; App owns applying them to the audio engine. */
export function AudioSettings({ settings, onSettings }: Props) {
  const id = useId();
  const mix = clampSlider(settings?.mix ?? 0);
  const eq = parseEq(settings?.eq);
  const updateEq = (patch: Partial<EqConfig>) => onSettings({ eq: { ...eq, ...patch } });
  const preset = matchesPreset(eq) ? eq.presetId : 'custom';
  /**
   * What the engine is actually doing right now.
   *
   * `REASON_TEXT` was written so unprocessable audio could be explained instead of leaving a
   * dead-looking control, but nothing displayed it — so a listener whose preview server refused
   * processing, or who is on a browser without Web Audio, saw a full panel of controls that
   * silently did nothing. It is also the only way to tell from outside that the graph really is
   * carrying the audio.
   */
  const [reason, setReason] = useState(engineReason);
  useEffect(() => subscribeEngine(() => setReason(engineReason())), []);

  return (
    <section className="audio-settings" aria-labelledby={`${id}-audio`}>
      <h3 id={`${id}-audio`}>Audio</h3>
      <p className="note audio-settings__state" data-engine-reason={reason} aria-live="polite">
        {REASON_TEXT[reason]}
      </p>
      <section className="audio-settings__section" aria-labelledby={`${id}-mix-heading`}>
        <h4 id={`${id}-mix-heading`}>Crossfader</h4>
        <div className="audio-settings__heading">
          <label htmlFor={`${id}-mix`}>Blend length</label>
          <output id={`${id}-mix-output`} htmlFor={`${id}-mix`}>
            {mix} — {mixLabel(mix)}
          </output>
        </div>
        <div className="dial audio-settings__range">
          <input
            id={`${id}-mix`} type="range" min={MIX_MIN} max={MIX_MAX} step={1} value={mix}
            aria-valuetext={`${mix} — ${mixLabel(mix)}`}
            aria-describedby={`${id}-mix-output ${id}-mix-help ${id}-mix-style`}
            style={fill(mix, MIX_MIN, MIX_MAX)}
            onChange={(event) => onSettings({ mix: clampSlider(Number(event.target.value)) })}
          />
        </div>
        <div className="audio-settings__scale" aria-hidden="true">
          {MIX_LABELS.map((label) => <span key={label}>{label}</span>)}
        </div>
        <p className="note" id={`${id}-mix-help`}>
          Turning the mixer on selects 30-second previews when available, not full YouTube or SoundCloud audio.
          Embedded players cannot be mixed or equalized here. Set to Off for normal playback.
        </p>
        <p className="note" id={`${id}-mix-style`}>
          Higher settings ask for longer blends, with bass handoff and filter transitions at the maximum.
          Short previews limit the overlap. Without reliable beat grids, this is a timed blend, not beatmatching.
        </p>
      </section>

      <section className="audio-settings__section" aria-labelledby={`${id}-eq-heading`}>
        <h4 id={`${id}-eq-heading`}>10-band equalizer</h4>
        <label className="chk audio-settings__toggle">
          <input type="checkbox" checked={eq.on} aria-describedby={`${id}-eq-help`}
            onChange={(event) => updateEq({ on: event.target.checked })} />
          <span className="box" aria-hidden="true" />
          <span>Equalizer on</span>
        </label>
        <p className="note" id={`${id}-eq-help`}>
          EQ applies to previews played by this app, not embedded YouTube or SoundCloud players.
          You can adjust it while off; your settings are kept.
        </p>
        <label className="audio-settings__preset-label" htmlFor={`${id}-preset`}>EQ preset</label>
        <select className="field audio-settings__preset" id={`${id}-preset`} value={preset}
          onChange={(event) => onSettings({ eq: applyPreset(eq, event.target.value) })}>
          <option value="custom" disabled>Custom</option>
          {EQ_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        {/*
          A graphic equalizer, in the shape people expect and the suite already draws
          (music-player's Equalizer, after the iTunes window): a dB scale on the left, the preamp
          as the first fader, then the ten bands as vertical faders in one row, low to high.
          Ten horizontal sliders in two columns read as a settings form, not an equalizer.
        */}
        <fieldset className="audio-settings__bands">
          <legend>Equalizer faders</legend>
          <div className="eqr" role="presentation">
            <div className="eqr__scale" aria-hidden="true">
              <span>+12</span><span>0</span><span>−12</span>
            </div>
            <Fader
              id={`${id}-preamp`} label="Pre" name="Preamp" strong
              value={eq.preampDb} min={EQ_PREAMP_MIN_DB} max={EQ_PREAMP_MAX_DB} step={0.5}
              onChange={(value) => updateEq({ preampDb: clampPreamp(value), presetId: 'custom' })}
            />
            <div className="eqr__bands" role="group" aria-label="Frequency bands">
              {EQ_BANDS_HZ.map((hz, index) => (
                <Fader
                  key={hz} id={`${id}-band-${hz}`} label={shortHz(hz)} name={`${hz} Hz`}
                  value={eq.gains[index] ?? 0} min={EQ_GAIN_MIN_DB} max={EQ_GAIN_MAX_DB} step={0.5}
                  onChange={(value) => {
                    const gains = [...eq.gains];
                    gains[index] = clampGain(value);
                    updateEq({ gains, presetId: 'custom' });
                  }}
                />
              ))}
            </div>
          </div>
        </fieldset>
        <label className="chk audio-settings__toggle">
          <input type="checkbox" checked={eq.limiter} aria-describedby={`${id}-limiter-help`}
            onChange={(event) => updateEq({ limiter: event.target.checked })} />
          <span className="box" aria-hidden="true" />
          <span>Safety limiter</span>
        </label>
        <p className="note" id={`${id}-limiter-help`}>
          Helps catch loud peaks while EQ is on. Automatic headroom trim reduces the level to leave room for boosted bands.
        </p>
        <p className="note">Headroom trim: {(eq.on ? headroomTrimDb(eq) : 0).toFixed(1)} dB</p>
      </section>
    </section>
  );
}
