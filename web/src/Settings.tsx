import { useEffect, useRef, useState } from 'react';
import './settings-buttons.css';
import { SourceMark } from './SourceMark';
import { RefreshGlyph } from './icons';
import { api, type Health, type Settings as S, type Status } from './api';
import { parseHistoryFile, type ImportSummary } from './engine/import';
import { MicSettings } from './MicSettings';
import { QueueDownloadSettings } from './QueueDownloadSettings';
import { DownloadsSettings } from './DownloadsSettings';
import type { Downloads } from './Downloads';
import { AudioSettings } from './AudioSettings';
import { RankingFormulaSettings } from './RankingFormulaSettings';
import { PROVIDER_LABEL, QUEUE_SIZE_MAX, QUEUE_SIZE_MIN, classNames, fmtBytes } from './util';
import './discovery-settings.css';
import { SIMILAR_DEFAULT, SIMILAR_MAX, SIMILAR_MIN } from './engine/similar-sound';
import { NumberField } from './NumberField';
import { FavArtistsSettings } from './FavArtists';
import { VolumeSetting } from './VolumeSetting';
import { CarKeep } from './CarKeep';

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
  onFormulaSaved?: (next: S) => void;
  /**
   * SRC-WARN-001: per-source outcome of the last discovery run. It used to sit above the song list,
   * where a slow provider read as a problem with the music; it belongs with the runtime checks.
   */
  sources?: Record<string, { state?: string }>;
  /** FOLDER-IMPORT-001: the app's one download list, so the Downloads section can host it here. */
  downloads?: Downloads;
}

/** ALLOWANCE-ARCH-001: what today's reading was for, in the order shown. */
const LANES: [string, string][] = [['interactive', 'you asked for'], ['playback', 'playing songs'], ['background', 'in the background'], ['other', 'earlier today']];

/** Whole minutes until paused background work resumes; never less than one. */
function resumeMinutes(at: number | null): number {
  return Math.max(1, Math.round(((at ?? 0) - Date.now() / 1000) / 60));
}

/** Settings and a discreet status panel. Every badge here comes from a runtime check, never a constant. */
export function SettingsView({ settings, onSettings, onReset, onResetTaste, onFormulaSaved, sources, downloads }: Props) {
  /**
   * The live keys are "provider:query" pairs, so a real run carries dozens of them. Group by the
   * provider, drop the query, and cap the list: the useful fact is WHICH provider went quiet, not
   * every search that hit it. 'skipped' is not a failure - the run chose not to use that source.
   */
  const quietProviders = [...new Set(
    Object.entries(sources ?? {})
      .filter(([, v]) => { const s = v?.state ?? 'ok'; return s !== 'ok' && s !== 'skipped'; })
      .map(([k]) => k.split(':')[0] ?? k),
  )].sort();
  const QUIET_SHOWN = 4;
  const quietSources = quietProviders.length > QUIET_SHOWN
    ? [...quietProviders.slice(0, QUIET_SHOWN), `${quietProviders.length - QUIET_SHOWN} more`]
    : quietProviders;
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmTaste, setConfirmTaste] = useState(false);
  const [modelBusy, setModelBusy] = useState<'install' | 'test' | null>(null);
  const [history, setHistory] = useState<ImportSummary | null>(null);
  // HISTORY-PICK-001: an app button opens the hidden file input; the chosen file's name sits beside it.
  const historyInput = useRef<HTMLInputElement>(null);
  const [historyName, setHistoryName] = useState('');
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

  /**
   * Re-read just the storage figures for the live meter. Deliberately silent: it sets no checking
   * flag and clears no error, so a poll never flickers the panel or blanks a real message.
   */
  const [freed, setFreed] = useState<number | null>(null);
  const refreshStorage = () =>
    api.status()
      .then((s) => setStatus(s))
      .catch(() => { /* a blip must not disturb a panel the listener is reading */ });

  const load = (refresh = false) => {
    setChecking(refresh);
    setErr(null);
    // ALLOWANCE-REFRESH-001: Check again also gives the day's allowance back; say how much it freed
    // so the listener can see why searching and discovery work again.
    Promise.all([api.health(refresh), api.status()])
      .then(([h, s]) => {
        setHealth(h);
        setStatus(s);
        const freed = h.allowance_refreshed;
        // ALLOWANCE-ARCH-001: what counts now is the background allowance given back.
        if (freed) setFreed(freed.restored_bytes ?? freed.cleared_bytes);
        return api.status().then(setStatus, () => undefined);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setChecking(false));
  };
  useEffect(() => load(false), []);
  // A storage meter that only reads once on mount is a screenshot. Measured on Windows 0.6.1: it
  // showed "381 MB of 1.07 GB" for 125 s while the shell already held a 3 GB limit. Poll the shell
  // while this panel is open, and stop when it closes or the tab is hidden so a background screen
  // never keeps waking the shell.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const start = () => {
      stop();
      // Cheap call (status() reads counters, it evicts nothing), but 4 s is plenty for a meter.
      timer = setInterval(() => { if (!document.hidden) void refreshStorage(); }, 4000);
    };
    const onVisible = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisible);
    start();
    return () => { document.removeEventListener('visibilitychange', onVisible); stop(); };
  }, []);

  const tr = status?.transfer_today ?? {};
  const allowance = status?.allowance ?? null;
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
        {/* VOLUME-SETTINGS-001 (owner, 2026-11-22): the app's volume, moved here from the player's controls. */}
        <VolumeSetting />
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
            The most new songs one discovery may add, whether you searched or your now playing queue ran low while
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
              onChange={(e) => { onSettings({ cache_gb: Number(e.target.value) }); void refreshStorage(); }} />
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
            Look for more songs once you finish one from your now playing queue and 3 or fewer unplayed ones are
            left. Pausing, seeking, skipping or replaying never starts a search on its own.
          </p>
          <label className="chk discovery-settings__toggle">
            <input
              type="checkbox"
              checked={settings?.mood_queue ?? true}
              aria-describedby="mood-queue-help"
              onChange={(e) => onSettings({ mood_queue: e.target.checked })}
            />
            <span className="box" aria-hidden="true" />
            <span>Follow my listening mood</span>
          </label>
          <p className="note" id="mood-queue-help">
            Re-arrange the songs still to come in your now playing queue, here and in Android Auto, to match what you
            are listening to now: its genre, subgenre and sound. Starring a song, Find similar sound and dislikes count
            most. Familiar keeps the queue close to your mood; Adventurous lets in more variety. Albums and saved
            playlists keep their order unless shuffle is on. The song playing and songs you added yourself never move.
          </p>
        </section>
        <FavArtistsSettings />
        <section className="discovery-settings" aria-labelledby="similar-h">
          <h3 id="similar-h">Similar sound</h3>
          <div className="discovery-settings__heading">
            <label htmlFor="similar-percent">Minimum sound match</label>
            <output htmlFor="similar-percent">{settings?.similar_percent ?? SIMILAR_DEFAULT}%</output>
          </div>
          <div className="dial discovery-settings__range">
            <input id="similar-percent" type="range" min={SIMILAR_MIN} max={SIMILAR_MAX} step={1}
              value={settings?.similar_percent ?? SIMILAR_DEFAULT} disabled={!settings}
              style={{ '--pct': `${(((settings?.similar_percent ?? SIMILAR_DEFAULT) - SIMILAR_MIN) / (SIMILAR_MAX - SIMILAR_MIN)) * 100}%` } as React.CSSProperties}
              onChange={(e) => onSettings({ similar_percent: Number(e.target.value) })} />
          </div>
          <p className="note">The “Find similar sound” button on any song in the now playing list adds only new songs whose analysed sound scores at least this much. It searches all seven full-song services, then compares available audio; songs without analysed audio never pass. The percentage is an audio-model match score, not a guarantee you’ll hear them as alike. Uses the discovery transfer allowance.</p>
        </section>
        <AudioSettings settings={settings} onSettings={onSettings} />
        <RankingFormulaSettings settings={settings} onSaved={onFormulaSaved} />
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
          {/* ALLOWANCE-ARCH-001 (owner, 2026-11-20): the allowance does not apply on Wi-Fi, and never to searching,
              playing or full-song downloads. It limits background work on mobile data only, and refills all day. */}
          <span className="k">Mobile data allowance</span>
          {/* One value cell: the settings grid pairs each label with exactly one item. */}
          <div>
            <label className="numrow">
              <NumberField
                className="field field--num"
                min={5}
                max={2000}
                step={5}
                value={settings?.daily_mb ?? 100}
                onValue={(n) => onSettings({ daily_mb: n })}
              />{' '}
              MB a day on mobile data, for finding new songs and tags in the background. It refills through the day.
            </label>
            {allowance && (
              <p className="note" role="status" aria-label="Mobile data allowance now">
                {allowance.unmetered
                  ? 'This connection is not metered (Wi-Fi or cable): nothing is limited.'
                  : allowance.paused
                    ? `On mobile data now: finding new songs is paused to save data and resumes by itself in about ${resumeMinutes(allowance.resumes_at)} min.`
                    : `On mobile data now: ${fmtBytes(allowance.level)} of ${fmtBytes(allowance.capacity)} left for background work.`}{' '}
                Searching, playing and downloading songs are never limited.
              </p>
            )}
          </div>
          <span className="k">Discovery allowance</span>
          <label className="numrow">
            <NumberField
              className="field field--num"
              min={2}
              max={200}
              step={1}
              value={settings?.request_mb ?? 20}
              onValue={(n) => onSettings({ request_mb: n })}
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
          <div className="history-pick">
            <button className="push" type="button" aria-label="Choose history file" disabled={historyBusy} onClick={() => historyInput.current?.click()}>
              Choose file…
            </button>
            <span className="history-pick__name" title={historyName || undefined}>{historyName || 'No file chosen'}</span>
          </div>
          <input
            ref={historyInput}
            className="sr"
            type="file"
            tabIndex={-1}
            aria-hidden="true"
            accept=".json,.jsonl,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setHistoryName(f?.name ?? '');
              void loadHistory(f);
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
          {/*
            * RESET-APP-001 — owner: "ensure the settings has a reset app icon that resets
            * everything back to default". The old control was labelled "Reset…", carried no icon,
            * and deliberately kept the downloaded songs, so it did not put the app back to how it
            * shipped. Songs you chose to keep in your Music folder are yours and are never touched.
            */}
          {confirm ? (
            <>
              <span className="note">
                Put everything back to default? Your now playing queue, starting songs, likes, dislikes, settings and
                downloaded songs in the app cache are cleared. Songs kept in your Music folder stay.
              </span>
              <button
                className="push push--danger"
                type="button"
                onClick={() => (setConfirm(false), onReset())}
              >
                Reset everything
              </button>
              <button className="push" type="button" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <button
              className="push"
              type="button"
              title="Put the app back to how it shipped. Songs kept in your Music folder stay."
              onClick={() => (setConfirmTaste(false), setConfirm(true))}
            >
              <RefreshGlyph size={13} /> Reset the app to defaults
            </button>
          )}
        </div>
      </section>

      {/* FOLDER-IMPORT-001: the Downloads section — download queue plus local folder imports. */}
      {downloads && <DownloadsSettings downloads={downloads} />}

      {/* CAR-KEEP-001: Android only; renders nothing where the phone bridge is absent. */}
      <CarKeep />

      <section className="card" aria-labelledby="src-h">
        <div className="card__head">
          <h2 id="src-h">Sources</h2>
          <button className="push" type="button" onClick={() => load(true)} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
        {err && <p className="state state--bad">{err}</p>}
        {freed !== null && (
          <p className="note" role="status">
            {freed > 0
              ? `Allowance refreshed: ${fmtBytes(freed)} given back for finding new songs on mobile data.`
              : 'Allowance refreshed: it was already full.'}
          </p>
        )}
        {quietSources.length > 0 && (
          // SRC-WARN-001: moved here from above the song list. The run still used every source
          // that did answer, so this is a status note, not a failure the listener must act on.
          <p className="note" role="status">
            Last discovery run: {quietSources.join(', ')} did not answer. The queue used the rest.
          </p>
        )}
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
                  <SourceMark provider={p} size={13} /> {PROVIDER_LABEL[p] ?? p}
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
              <dd>{allowance ? fmtBytes(trTotal) : `${fmtBytes(trTotal)} of ${fmtBytes(status.transfer_daily_cap)}`}</dd>
            </div>
            {/* ALLOWANCE-ARCH-001: what today's reading was for. Only the last of these draws on the allowance. */}
            {allowance && LANES.filter(([lane]) => (allowance.today[lane] ?? 0) > 0).map(([lane, label]) => (
              <div key={`lane-${lane}`}>
                <dt>· {label}</dt>
                <dd>{fmtBytes(allowance.today[lane])}</dd>
              </div>
            ))}
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
