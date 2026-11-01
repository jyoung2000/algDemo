import { useEffect, useState } from 'react';
import { ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, type Health, type Settings as S, type Status } from './api';
import { parseHistoryFile, type ImportSummary } from './engine/import';
import { PROVIDER_LABEL, classNames, fmtBytes, markKey } from './util';

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
}

/** Settings and a discreet status panel. Every badge here comes from a runtime check, never a constant. */
export function SettingsView({ settings, onSettings, onReset }: Props) {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
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

  return (
    <div className="settings">
      <section className="card" aria-labelledby="set-h">
        <h2 id="set-h">Settings</h2>
        <div className="pref">
          <span className="k">Ranking engine</span>
          <label className="chk">
            <input type="checkbox" checked={settings?.rank_v2 ?? true} onChange={(e) => onSettings({ rank_v2: e.target.checked })} />
            Improved ranking (v2): corroboration across services, bounded repeat feedback and fairer evidence. In-app ranking also blends long, recent and session taste. Turn off to use the original engine.
          </label>
          <span className="k">Audio matching</span>
          <label className="chk">
            <input type="checkbox" checked={settings?.audio ?? true} onChange={(e) => onSettings({ audio: e.target.checked })} />
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
          <span className="k">Per request</span>
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
            MB for each “Find my next favorite”
          </label>
          <span className="k">Sample data</span>
          <label className="chk">
            <input type="checkbox" checked={settings?.sample_mode ?? false} onChange={(e) => onSettings({ sample_mode: e.target.checked })} />
            Offer a labelled, recorded sample queue for looking at the interface offline
          </label>
        </div>
        <p className="note">Songs you play in the embedded players stream straight to your browser. That is your own listening and is not counted in these allowances.</p>
        <div className="pref" aria-label="Listening history import">
          <span className="k">Import listening history (optional)</span>
          <p className="note">Select Spotify extended streaming history JSON or an extracted ListenBrainz .jsonl month. This file is read on your device; no account connection or cloud upload. A submitted ListenBrainz play is not treated as a finished track.</p>
          <input aria-label="Choose history file" type="file" accept=".json,.jsonl,application/json" onChange={(e) => { void loadHistory(e.target.files?.[0]); e.target.value = ''; }} />
          {history && <p className="note" role="status">{history.source}: {history.usable} usable of {history.total} rows; {history.dropped.map((d) => `${d.count} ${d.reason}`).join(', ') || 'none dropped'}. Nothing is saved until you confirm.</p>}
          {history && history.usable > 0 && <button className="push" type="button" disabled={historyBusy} onClick={() => void saveHistory()}>{historyBusy ? 'Importing…' : `Import ${history.usable} plays`}</button>}
          {historyMessage && <p className="note" role="status">{historyMessage}</p>}
        </div>
        <div className="panefoot">
          <a className="push" href="/api/export" download>
            Export my data
          </a>
          {confirm ? (
            <>
              <span className="note">Remove starting songs, likes, dislikes and settings?</span>
              <button className="push push--danger" type="button" onClick={() => (setConfirm(false), onReset())}>
                Reset
              </button>
              <button className="push" type="button" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="push" type="button" onClick={() => setConfirm(true)}>
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
                    <span role="cell" key={c} className={classNames('cap', `cap--${st}`)} title={s?.detail ?? ''}>
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
            Audio model: {health.audio.installed ? `DCLAP (${health.audio.dim}-d), ${STATE_LABEL[health.audio.check.state] ?? health.audio.check.state}` : 'not installed'}
            {health.audio.check.detail ? ` — ${health.audio.check.detail}` : ''}. {health.audio.vectors} songs analysed and kept. License: {health.audio.license}.
          </p>
        )}
        {health && (
          <div className="panefoot">
            {health.audio.installed ? (
              <button className="push" type="button" disabled={modelBusy !== null} onClick={() => modelAction('test')}>
                {modelBusy === 'test' ? 'Testing…' : 'Test audio model'}
              </button>
            ) : (
              <button className="push" type="button" disabled={modelBusy !== null} onClick={() => modelAction('install')}>
                {modelBusy === 'install' ? 'Downloading…' : `Install audio model (${fmtBytes(health.audio.download_bytes)} download)`}
              </button>
            )}
          </div>
        )}
      </section>

      {status && (
        <section className="card" aria-labelledby="st-h">
          <h2 id="st-h">Storage and downloads</h2>
          <div className="meter" aria-label={`App storage ${fmtBytes(status.storage.total)} of ${fmtBytes(status.storage.hard_cap)}`}>
            <span style={{ width: `${Math.min(100, (status.storage.total / status.storage.hard_cap) * 100)}%` }} />
          </div>
          <p className="note">
            {fmtBytes(status.storage.total)} of {fmtBytes(status.storage.hard_cap)} used by the app. {status.storage.not_counted}
          </p>
          <dl className="kv">
            {Object.entries(status.storage.areas).map(([k, v]) => (
              <div key={k}>
                <dt>{k.replace(/_/g, ' ')}</dt>
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
                {fmtBytes(status.cache.bytes)} · {status.cache.hits} hits / {status.cache.misses} misses
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
