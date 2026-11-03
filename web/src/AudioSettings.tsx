import { useId, type CSSProperties } from 'react';
import type { Settings } from './api';
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

/** MIXER-001 / EQ-001: settings only; App owns applying them to the audio engine. */
export function AudioSettings({ settings, onSettings }: Props) {
  const id = useId();
  const mix = clampSlider(settings?.mix ?? 0);
  const eq = parseEq(settings?.eq);
  const updateEq = (patch: Partial<EqConfig>) => onSettings({ eq: { ...eq, ...patch } });
  const preset = matchesPreset(eq) ? eq.presetId : 'custom';

  return (
    <section className="audio-settings" aria-labelledby={`${id}-audio`}>
      <h3 id={`${id}-audio`}>Audio</h3>
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
        <fieldset className="audio-settings__bands">
          <legend>Frequency bands</legend>
          <div className="audio-settings__band-grid">
            {EQ_BANDS_HZ.map((hz, index) => {
              const gain = eq.gains[index] ?? 0;
              const bandId = `${id}-band-${hz}`;
              return (
                <div className="audio-settings__band" key={hz}>
                  <div className="audio-settings__heading">
                    <label htmlFor={bandId}>{hz} Hz</label>
                    <output id={`${bandId}-output`} htmlFor={bandId}>{db(gain)}</output>
                  </div>
                  <div className="dial audio-settings__range">
                    <input id={bandId} type="range" min={EQ_GAIN_MIN_DB} max={EQ_GAIN_MAX_DB}
                      step={0.5} value={gain} aria-valuetext={db(gain)}
                      aria-describedby={`${bandId}-output`} style={fill(gain, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB)}
                      onChange={(event) => {
                        const gains = [...eq.gains];
                        gains[index] = clampGain(Number(event.target.value));
                        updateEq({ gains, presetId: 'custom' });
                      }} />
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
        <div className="audio-settings__heading">
          <label htmlFor={`${id}-preamp`}>Preamp</label>
          <output id={`${id}-preamp-output`} htmlFor={`${id}-preamp`}>{db(eq.preampDb)}</output>
        </div>
        <div className="dial audio-settings__range">
          <input id={`${id}-preamp`} type="range" min={EQ_PREAMP_MIN_DB} max={EQ_PREAMP_MAX_DB}
            step={0.5} value={eq.preampDb} aria-valuetext={db(eq.preampDb)}
            aria-describedby={`${id}-preamp-output`} style={fill(eq.preampDb, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB)}
            onChange={(event) => updateEq({ preampDb: clampPreamp(Number(event.target.value)), presetId: 'custom' })} />
        </div>
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
