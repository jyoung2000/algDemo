import { useSyncExternalStore } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { volumeStore } from './volume-store';
import './volume-setting.css';

/**
 * VOLUME-SETTINGS-001 (owner, 2026-11-22): "move the volume control for the app to the top of settings instead of in the
 * player control". The app's volume: a slider always on show at the top of Settings, the level beside it and a mute
 * button. It runs to 200% where the player can boost (VOLUME-BOOST-001): a tick marks the normal maximum and the fill
 * turns amber past it.
 */
export function VolumeSetting() {
  const level = useSyncExternalStore(volumeStore.subscribe, volumeStore.level);
  const muted = useSyncExternalStore(volumeStore.subscribe, volumeStore.muted);
  const max = useSyncExternalStore(volumeStore.subscribe, volumeStore.max);
  const blocked = useSyncExternalStore(volumeStore.subscribe, volumeStore.blocked);
  const top = Math.round(max * 100);
  const pct = muted ? 0 : Math.min(top, Math.round(level * 100));
  const boosted = pct > 100;
  const silent = muted || pct === 0;
  const off = blocked !== '';
  return (
    <section className={`discovery-settings volset${boosted ? ' is-boosted' : ''}`} aria-labelledby="volume-h">
      <h3 id="volume-h">Volume</h3>
      <div className="discovery-settings__heading">
        <label htmlFor="app-volume">App volume</label>
        <output id="app-volume-output" htmlFor="app-volume" className="volset__n">{pct}%</output>
      </div>
      <div className="volset__row">
        <button className="iconbtn volset__mute" type="button" onClick={() => volumeStore.toggleMute()} disabled={off} aria-pressed={muted}
          aria-label={silent ? 'Unmute' : 'Mute'} title={silent ? 'Unmute' : 'Mute'}>
          <Glyph name={silent ? 'mute' : pct < 50 ? 'volume-low' : 'volume-high'} size={18} />
        </button>
        <div className="dial discovery-settings__range volset__dial" style={top > 100 ? { ['--at' as string]: `${(100 / top) * 100}%` } : undefined}>
          <input id="app-volume" type="range" min={0} max={top} step={1} value={pct} disabled={off}
            aria-label="Volume" aria-describedby="app-volume-help"
            aria-valuetext={boosted ? `${pct}%, boosted past normal volume` : `${pct}%`}
            style={{ ['--pct' as string]: `${Math.round((pct / top) * 1000) / 10}%` }}
            onChange={(e) => volumeStore.set(Number(e.target.value) / 100)} />
          {top > 100 && <span className="volset__mark" aria-hidden="true" title="Normal maximum" />}
        </div>
      </div>
      <p className="note" id="app-volume-help">
        {off ? blocked : top > 100
          ? 'How loud jPlay plays, for songs and radio. Past the mark at 100% the sound is boosted, up to 200%. Your phone or computer volume still applies on top.'
          : 'How loud jPlay plays, for songs and radio. Your phone or computer volume still applies on top.'}
      </p>
    </section>
  );
}
