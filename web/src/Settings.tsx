import { useEffect, useState } from 'react';
import { ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, type Health, type Settings as S, type Status } from './api';
import { parseHistoryFile, type ImportSummary } from './engine/import';
import { MicSettings } from './MicSettings';
import { QueueDownloadSettings } from './QueueDownloadSettings';
import { AudioSettings } from './AudioSettings';
import { PROVIDER_LABEL, QUEUE_SIZE_MAX, QUEUE_SIZE_MIN, classNames, fmtBytes, markKey } from './util';
import './discovery-settings.css';

const CAPS: [string, string][] = [
  ['search', 'Search'],
  ['resolve_link', 'Links'],
  ['related_candidates', 'Related'],
  ['artist_candidates', 'Artist'],
  ['recent_candidates', 'New'],
  ['playback_link', 'Play'],
];

const STATE_LABEL: Record<string, string> = {
  working: 'Working',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  unsupported: '—',
  not_tested: 'Not tested',
};

interface Props {
  settings: S | null;
  onSettings: (patch: Partial<S>) => void;
  onReset: () => void;
  onResetTaste: () => void;
}

/** Settings and a discreet status panel. Every badge here comes from a runtime check, never a constant. */
export function SettingsView({ settings, onSettings, onReset, onResetTaste }: Props) {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmTaste, setConfirmTaste] = useState(false);
  const [modelBusy, setModelBusy] = useState<'install' | 'test' | null>(null);
  const [history, setHistory] = useState<ImportSummary | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyMessage, setHistoryMessage] = useState('');
  const loadHistory = async (file: File | undefined) => {
    if (!file) return;
    setHistory(null);
    setHistoryMessage('');
    if (file.size > 25_000_000) {
      setHistoryMessage('This file is over 25 MB. Split or extract it into smaller JSON/JSONL files.');
      return;
    }
    try {
      const parsed = parseHistoryFile(await file.text());
      setHistory(parsed);
      if (!parsed.usable) setHistoryMessage('No qualified listens in that file. Nothing was imported.');
    } catch (e) {
      setHistoryMessage((e as Error).message);
    }
  };
  const saveHistory = async () => {
    if (!history?.usable) return;
    setHistoryBusy(true);
    setHistoryMessage('');
    try {
      const { recorded, duplicates, skipped } = await api.importHistory(history.events);
      setHistoryMessage(`Imported ${recorded}; ${duplicates} already present; ${skipped} rejected. Refresh to update your profile.`);
      setHistory(null);
    } catch (e) {
      setHistoryMessage((e as Error).message);
    } finally {
      setHistoryBusy(false);
    }
  };

  const modelAction = (kind: 'install' | 'test') => {
    setModelBusy(kind);
    setErr(null);
    (kind === 'install' ? api.modelInstall() : api.modelSelftest())
      .catch((e: Error) => setErr(e.message))
      .finally(() => {
        setModelBusy(null);
        load(false);
      });
  };

  const load = (refresh = false) => {
    setChecking(refresh);
    setErr(null);
    Promise.all([api.health(refresh), api.status()])
      .then(([h, s]) => {
        setHealth(h);
        setStatus(s);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setChecking(false));
  };
  useEffect(() => load(false), []);

  const tr = status?.transfer_today ?? {};
  const trTotal = Object.values(tr).reduce((a, b) => a + (b || 0), 0);
  // The stored full songs, which only the installed shells have. This is the figure the "Queue audio
  // storage limit" slider governs, so it is the one the meter shows.
  const qa = status?.storage.queue_audio ?? null;
  const discoverySize = settings?.queue_size ?? 30;
  const discoveryPct = ((discoverySize - QUEUE_SIZE_MIN) / (QUEUE_SIZE_MAX - QUEUE_SIZE_MIN)) * 100;

  return (
    <div className="settings">
      <section className="card" aria-labelledby="set-h">
        <h2 id="set-h">Settings</h2>
        <section className="discovery-settings" aria-labelledby="discovery-h">
          <h3 id="discovery-h">Discovery</h3>
          <div className="discovery-settings__heading">
            <label htmlFor="discovery-size">New songs per discovery</label>
            <output id="discovery-size-output" htmlFor="discovery-size">
              Up to {discoverySize} new songs per discovery
            </output>
          </div>
          <div className="dial discovery-settings__range">
            <input
              id="discovery-size"
              type="range"
              min={QUEUE_SIZE_MIN}
              max={QUEUE_SIZE_MAX}
              step={1}
              value={discoverySize}
              aria-describedby="discovery-size-output discovery-size-help"
              style={{ '--pct': `${discoveryPct}%` } as React.CSSProperties}
              onChange={(e) => onSettings({ queue_size: Number(e.target.value) })}
            />
          </div>
          <p className="note" id="discovery-size-help">
            The most new songs one discovery may add, whether you searched or the list ran low while
            you listened. Songs you already have are never removed, and a discovery may find fewer
            than this.
          </p>
          <div className="discovery-settings__heading">
            <label htmlFor="cache-gb">Queue audio storage limit</label>
            <output id="cache-gb-output" htmlFor="cache-gb">{settings?.cache_gb ?? 1} GB</output>
          </div>
          <div className="dial discovery-settings__range">
            <input id="cache-gb" type="range" min={0.25} max={20} step={0.25} value={settings?.cache_gb ?? 1}
              aria-describedby="cache-gb-output cache-gb-help"
              style={{ '--pct': `${(((settings?.cache_gb ?? 1) - 0.25) / 19.75) * 100}%` } as React.CSSProperties}
              onChange={(e) => onSettings({ cache_gb: Number(e.target.value) })} />
          </div>
          <p className="note" id="cache-gb-help">Full songs for the player are kept in a private, reusable queue cache up to this limit. The whole list loads ahead in the background; older unpinned songs leave first. Songs you explicitly download are kept separately and never deleted by this setting.</p>
          <QueueDownloadSettings settings={settings} onSettings={onSettings} />
          <label className="chk discovery-settings__toggle">
            <input
              type="checkbox"
              checked={settings?.discover_while_listening ?? true}
              aria-describedby="discovery-listening-help"
              onChange={(e) => onSettings({ discover_while_listening: e.target.checked })}
            />
            <span className="box" aria-hidden="true" />
            <span>Discover while listening</span>
          </label>
          <p className="note" id="discovery-listening-help">
            Look for more songs once you finish one from your list and 3 or fewer unplayed ones are
            left. Pausing, seeking, skipping or replaying never starts a search on its own.
          </p>
        </section>
        <AudioSettings settings={settings} onSettings={onSettings} />
        <div className="pref">
          <span className="k">Ranking engine</span>
          <label className="chk">
            <input
              type="checkbox"
              checked={settings?.rank_v2 ?? true}
              onChange={(e) => onSettings({ rank_v2: e.target.checked })}
            />
            <span className="box" aria-hidden="true" />
            Improved ranking (v2): corroboration across services, bounded repeat feedback and fairer
            evidence. In-app ranking also blends long, recent and session taste. Turn off to use the
            original engine.
          </label>
          <span className="k">Audio matching</span>
          <label className="chk">
            <input
              type="checkbox"
              checked={settings?.audio ?? true}
              onChange={(e) => onSettings({ audio: e.target.checked })}
            />
            <span className="box" aria-hidden="true" />
            Compare how songs sound, using 30-second Deezer previews
          </label>
          <span className="k">Daily download allowance</span>
          <label className="numrow">
            <input
              className="field field--num"
              type="number"
              min={5}
              max={2000}
              step={5}
              value={settings?.daily_mb ?? 100}
              onChange={(e) => onSettings({ daily_mb: Number(e.target.value) })}
            />{' '}
            MB per day, for metadata, artwork checks and previews the app downloads itself
          </label>
          <span className="k">Discovery allowance</span>
          <label className="numrow">
            <input
              className="field field--num"
              type="number"
              min={2}
              max={200}
              step={1}
              value={settings?.request_mb ?? 20}
              onChange={(e) => onSettings({ request_mb: Number(e.target.value) })}
            />{' '}
            MB for each discovery batch
          </label>
          <span className="k">Sample data</span>
          <label className="chk">
            <input
              type="checkbox"
              checked={settings?.sample_mode ?? false}
              onChange={(e) => onSettings({ sample_mode: e.target.checked })}
            />
            <span className="box" aria-hidden="true" />
            Offer a labelled, recorded sample queue for looking at the interface offline
          </label>
        </div>
        <p className="note">
          In the installed apps, added and discovered full songs load into the local queue cache for playback. These metadata and preview allowances do not cap that separate audio storage limit.
        </p>
        <div className="pref" aria-label="Listening history import">
          <span className="k">Import listening history (optional)</span>
          <p className="note">
            Select Spotify extended streaming history JSON or an extracted ListenBrainz .jsonl
            month. This file is read on your device; no account connection or cloud upload. A
            submitted ListenBrainz play is not treated as a finished track.
          </p>
          <input
            aria-label="Choose history file"
            type="file"
            accept=".json,.jsonl,application/json"
            onChange={(e) => {
              void loadHistory(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {history && (
            <p className="note" role="status">
              {history.source}: {history.usable} usable of {history.total} rows;{' '}
              {history.dropped.map((d) => `${d.count} ${d.reason}`).join(', ') || 'none dropped'}.
              Nothing is saved until you confirm.
            </p>
          )}
          {history && history.usable > 0 && (
            <button
              className="push"
              type="button"
              disabled={historyBusy}
              onClick={() => void saveHistory()}
            >
              {historyBusy ? 'Importing…' : `Import ${history.usable} plays`}
            </button>
          )}
          {historyMessage && (
            <p className="note" role="status">
              {historyMessage}
            </p>
          )}
        </div>
        <MicSettings />
        <div className="panefoot">
          <a className="push" href="/api/export" download>
            Export my data
          </a>
          {confirmTaste ? (
            <>
              <span className="note">
                Forget learned taste (plays, likes, skips)? Starting songs and settings stay.
              </span>
              <button
                className="push push--danger"
                type="button"
                onClick={() => (setConfirmTaste(false), onResetTaste())}
              >
                Reset taste
              </button>
              <button className="push" type="button" onClick={() => setConfirmTaste(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              className="push"
              type="button"
              onClick={() => (setConfirm(false), setConfirmTaste(true))}
            >
              Reset what the ranking learned…
            </button>
          )}
          {confirm ? (
            <>
              <span className="note">Remove starting songs, likes, dislikes and settings?</span>
              <button
                className="push push--danger"
                type="button"
                onClick={() => (setConfirm(false), onReset())}
              >
                Reset
              </button>
              <button className="push" type="button" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              className="push"
              type="button"
              onClick={() => (setConfirmTaste(false), setConfirm(true))}
            >
              Reset…
            </button>
          )}
        </div>
      </section>

      <section className="card" aria-labelledby="src-h">
        <div className="card__head">
          <h2 id="src-h">Sources</h2>
          <button className="push" type="button" onClick={() => load(true)} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
        {err && <p className="state state--bad">{err}</p>}
        {!health ? (
          <p className="state">
            <span className="sdot sdot--busy" aria-hidden="true" /> Checking sources…
          </p>
        ) : (
          <div className="captable" role="table" aria-label="What each source can do right now">
            <div className="captable__row captable__row--head" role="row">
              <span role="columnheader">Source</span>
              {CAPS.map(([, l]) => (
                <span key={l} role="columnheader">
                  {l}
                </span>
              ))}
            </div>
            {Object.entries(health.providers).map(([p, caps]) => (
              <div className="captable__row" role="row" key={p}>
                <span role="rowheader" className="captable__src">
                  <ProviderMark provider={markKey(p)} size={13} /> {PROVIDER_LABEL[p] ?? p}
                </span>
                {CAPS.map(([c]) => {
                  const s = caps[c];
                  const st = s?.state ?? 'unsupported';
                  return (
                    <span
                      role="cell"
                      key={c}
                      data-label={CAPS.find(([k]) => k === c)?.[1]}
                      className={classNames('cap', `cap--${st}`)}
                      title={s?.detail ?? ''}
                    >
                      {STATE_LABEL[st] ?? st}
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {health && (
          <p className="note">
            Audio model:{' '}
            {health.audio.installed
              ? `DCLAP (${health.audio.dim}-d), ${STATE_LABEL[health.audio.check.state] ?? health.audio.check.state}`
              : 'not installed'}
            {health.audio.check.detail ? ` — ${health.audio.check.detail}` : ''}.{' '}
            {health.audio.vectors} songs analysed and kept. License: {health.audio.license}.
          </p>
        )}
        {health && (
          <div className="panefoot">
            {health.audio.installed ? (
              <button
                className="push"
                type="button"
                disabled={modelBusy !== null}
                onClick={() => modelAction('test')}
              >
                {modelBusy === 'test' ? 'Testing…' : 'Test audio model'}
              </button>
            ) : (
              <button
                className="push"
                type="button"
                disabled={modelBusy !== null}
                onClick={() => modelAction('install')}
              >
                {modelBusy === 'install'
                  ? 'Downloading…'
                  : `Install audio model (${fmtBytes(health.audio.download_bytes)} download)`}
              </button>
            )}
          </div>
        )}
      </section>

      {status && (
        <section className="card" aria-labelledby="st-h">
          <h2 id="st-h">Storage and downloads</h2>
          {qa ? (
            <>
              <div
                className="meter"
                aria-label={`Queue audio ${fmtBytes(qa.bytes)} of ${fmtBytes(qa.limit)}`}
              >
                <span style={{ width: `${Math.min(100, (qa.bytes / qa.limit) * 100)}%` }} />
              </div>
              <p className="note">
                {fmtBytes(qa.bytes)} of {fmtBytes(qa.limit)} of queue audio stored, plus{' '}
                {fmtBytes(status.storage.app_data)} of app data. {status.storage.not_counted}
              </p>
            </>
          ) : (
            <p className="note">
              {fmtBytes(status.storage.app_data)} of app data. Full songs are stored only in the
              installed Windows and Android apps.
            </p>
          )}
          <dl className="kv">
            {qa && (
              <div>
                <dt>queue audio</dt>
                <dd>
                  {fmtBytes(qa.bytes)} of {fmtBytes(qa.limit)}
                </dd>
              </div>
            )}
            <div>
              <dt>app data</dt>
              <dd>{fmtBytes(status.storage.app_data)}</dd>
            </div>
            {Object.entries(status.storage.areas).map(([k, v]) => (
              <div key={k}>
                <dt>· {k.replace(/_/g, ' ')}</dt>
                <dd>{fmtBytes(v)}</dd>
              </div>
            ))}
            <div>
              <dt>downloaded today</dt>
              <dd>
                {fmtBytes(trTotal)} of {fmtBytes(status.transfer_daily_cap)}
              </dd>
            </div>
            {Object.entries(tr).map(([k, v]) => (
              <div key={`t-${k}`}>
                <dt>· {k}</dt>
                <dd>{fmtBytes(v)}</dd>
              </div>
            ))}
            <div>
              <dt>cache</dt>
              <dd>
                {fmtBytes(status.cache.bytes)} · {status.cache.hits} hits / {status.cache.misses}{' '}
                misses
              </dd>
            </div>
            <div>
              <dt>memory</dt>
              <dd>
                {fmtBytes(status.memory.rss)} now · {fmtBytes(status.memory.peak)} peak
              </dd>
            </div>
            <div>
              <dt>telemetry</dt>
              <dd>{status.telemetry}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  );
}
