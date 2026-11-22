import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import './local-music.css';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { api, type Track } from './api';
import { DL_FORMATS, dl, downloadsAvailable, matchTarget, targetFor, urlAllowedFor, type DlFormat, type DlHealth, type DlJob, type DlTool } from './engine/downloads';
import { songSources } from './engine/song-sources';
import { heldCopy } from './engine/held';
import { classNames, fmtBytes } from './util';

const FORMAT_KEY = 'airwave.dl.format';
/**
 * Measured on a real download (2026-11-02): YouTube Music serves Opus at about 163 kbps, and asking
 * for MP3 re-encodes it to 153 kbps — 6% smaller, but everything above 16.6 kHz is gone where the
 * source reached 20.1 kHz. "Original" keeps the source bytes, so it is the default.
 *
 * The option text stays short because a closed <select> cannot wrap or ellipsise gracefully: at
 * 390px only two of the long labels fit. The tradeoff is spelled out in FORMAT_NOTE underneath,
 * where the text can wrap.
 */
const FORMAT_LABEL: Record<DlFormat, string> = {
  original: 'Original',
  opus: 'Opus',
  m4a: 'M4A (AAC)',
  mp3: 'MP3',
  flac: 'FLAC',
  wav: 'WAV',
};

const FORMAT_NOTE: Record<DlFormat, string> = {
  original: 'Keeps the source audio exactly as it arrives. Nothing is re-encoded, so no quality is lost.',
  opus: 'Re-encodes unless the source is already Opus, which it usually is on YouTube Music.',
  m4a: 'Re-encodes unless the source is already AAC.',
  mp3: 'Plays on anything, but re-encodes the audio and loses the top treble.',
  flac: 'A lossless container. It cannot restore detail the source already dropped, and the file is much larger.',
  wav: 'Uncompressed and very large. It restores nothing the source dropped.',
};

const loadFormat = (): DlFormat => {
  try {
    const v = window.localStorage.getItem(FORMAT_KEY);
    if (v && (DL_FORMATS as readonly string[]).includes(v)) return v as DlFormat;
  } catch {
    /* storage can be unavailable */
  }
  return 'original';
};

const active = (j: DlJob): boolean => j.state === 'queued' || j.state === 'running';

/** Owns the download list. Polls once a second while something is running, and once on demand otherwise. */
/** RING-CLOSE-001: how long the shell's answer to a Download press stands in for a job its list has not shown. */
export const FRESH_MAX_MS = 5000;

export function useDownloads(flash: (m: string) => void) {
  const on = downloadsAvailable();
  const [jobs, setJobs] = useState<DlJob[]>([]);
  /** Which native job each song's download button started, so the button can show that job's state. */
  const [trackJobs, setTrackJobs] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState<Record<string, true>>({});
  /** The shell's answer to each song's Download press, until its job shows in the list. */
  const [fresh, setFresh] = useState<Record<string, { job: DlJob; at: number }>>({});
  const freshRef = useRef(fresh);
  freshRef.current = fresh;
  /** Songs a Download press saved for good this session. */
  const [saved, setSaved] = useState<Record<string, true>>({});
  const [format, setFormatState] = useState<DlFormat>(loadFormat);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!on) return [] as DlJob[];
    try {
      const r = await dl.jobs();
      setJobs(r.jobs);
      // The shell's answer to a press stands in until its job shows in the list (or, if it never does, for a few seconds).
      const now = Date.now();
      setFresh((m) => { const keep = Object.entries(m).filter(([, f]) => !r.jobs.some((j) => j.id === f.job.id) && now - f.at < FRESH_MAX_MS); return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep); });
      return r.jobs;
    } catch {
      return [] as DlJob[];
    }
  }, [on]);

  const poll = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void refresh().then((list) => {
      // PLAY-RING-004: often enough that a Play button's ring follows the real percent of a short download.
      // A press the shell has answered, whose job the list has not shown yet, is looked for again too.
      if (list.some(active) || Object.keys(freshRef.current).length) timer.current = setTimeout(poll, 300);
    });
  }, [refresh]);

  useEffect(() => {
    poll();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);
  // RING-CLOSE-001: the shell answered a press; read its list now rather than at the next tick.
  const awaited = Object.keys(fresh).length > 0;
  useEffect(() => { if (awaited) poll(); }, [awaited, poll]);

  const setFormat = (f: DlFormat) => {
    setFormatState(f);
    try {
      window.localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* not remembered */
    }
  };

  /** True when the native shell can run the spotdl program itself (Windows). Android cannot. */
  const runsSpotdl = useRef<boolean | null>(null);
  const spotdlHere = useCallback(async () => {
    if (runsSpotdl.current == null) {
      try {
        runsSpotdl.current = (await dl.health()).runs_spotdl;
      } catch {
        runsSpotdl.current = false;
      }
    }
    return runsSpotdl.current;
  }, []);

  const start = useCallback(
    async (tool: DlTool, url: string, label: string): Promise<DlJob | null> => {
      try {
        if (tool === 'spotdl' && !(await spotdlHere())) {
          // spotDL's own method: read the Spotify track, find it on YouTube Music, fetch that with yt-dlp.
          flash('Finding that Spotify song on YouTube Music…');
          const res = await api.resolve(url);
          let song: Track | undefined;
          if (res.kind === 'track') song = res.track;
          else if (res.kind === 'choice' && res.choice === 'artist' && res.track) {
            // Spotify's public link data names the song but not the artist. Take the best-ranked search
            // result with exactly that title and say which artist that was.
            const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
            song = res.tracks.find((c) => norm(c.title) === norm(res.track!.title) && c.artists?.length);
            if (song) flash(`Spotify did not name the artist; using “${song.title}” by ${(song.artists ?? []).join(', ')}.`);
          }
          if (!song) throw new Error('That Spotify link did not identify a single song. Search for the song and use its download button instead.');
          const m = await api.fullSong(song);
          const target = m.id ? matchTarget(m.id) : null;
          if (!target) throw new Error(`No confident YouTube Music match for “${song.title}”, so nothing was downloaded.`);
          const r2 = await dl.start(target.url, target.tool, format, label === url ? song.title : label);
          flash(`Downloading \u201c${r2.job.label || label}\u201d. Follow it under Settings \u2192 Downloads.`);
          poll();
          return r2.job;
        }
        // Whichever tool and format: if a permanent copy is already on disk, reuse it. Without
        // this a second Download of a spotdl song wrote "Artist - Title (2).opus".
        const already = await heldCopy((u) => dl.local(u), url);
        if (already) {
          flash(`“${label}” is already in your Downloads folder.`);
          poll();
          return {
            id: `held:${url}`, url, tool, format, label, state: 'done', stage: 'done', percent: 100,
            message: null, error: null, files: already.file ? [already.file] : [], saved_to: null,
          } satisfies DlJob;
        }
        if (tool === 'yt-dlp' && format === 'original') {
          // The queue cache may already hold this exact song; keeping it costs no second download.
          // Windows answers with a job, Android with ok/saved_to and no job — both mean "kept".
          const kept = await dl.keep(url).catch(() => null);
          if (kept?.job) {
            flash(kept.job.state === 'done' ? 'This song is kept in your Downloads folder.' : 'This song will be kept when its queue download finishes.');
            poll();
            return kept.job;
          }
          if (kept?.ok) {
            flash(kept.alreadyKept ? 'This song is already in your Downloads folder.' : `Kept this song in ${kept.saved_to || 'your Downloads folder'}.`);
            poll();
            // Shells that copy the cached file synchronously (Android) report no job. The song IS
            // kept, so answer with a finished record: returning null would read as a failure.
            return {
              id: `kept:${url}`, url, tool, format, label, state: 'done', stage: 'done', percent: 100,
              message: null, error: null, files: kept.file ? [kept.file] : [], saved_to: kept.saved_to ?? null,
            } satisfies DlJob;
          }
        }
        const r = await dl.start(url, tool, format, label);
        flash(`Downloading \u201c${r.job.label || label}\u201d. Follow it under Settings \u2192 Downloads.`);
        poll();
        return r.job;
      } catch (e) {
        flash((e as Error).message);
        return null;
      }
    },
    [format, flash, poll, spotdlHere],
  );

  /** Songs with their own link go straight to a tool; others are matched on YouTube Music first. */
  const downloadTrack = useCallback(
    async (t: Track) => {
      // PLAY-RING-004: from the press until the job exists (the song is being matched), the row already reads as started.
      setStarting((m) => ({ ...m, [t.key]: true }));
      const remember = (job: DlJob | null) => {
        if (job) {
          // ROW-DL-KEPT-001: the link this song is saved under, so the app still knows it is saved when reopened.
          songSources.keep(t.key, job.url);
          setTrackJobs((m) => ({ ...m, [t.key]: job.id }));
          // RING-CLOSE-001: the job is shown from the moment the shell answers, not from the next look at its list;
          // in between the row read "not started" for a blink and its ring reset.
          setFresh((m) => ({ ...m, [t.key]: { job, at: Date.now() } }));
          // A press that saved the song (it was already held, or the cached copy was kept) stays saved in the row:
          // the shell lists no job for it.
          if (job.state === 'done') setSaved((m) => ({ ...m, [t.key]: true }));
        }
        setStarting((m) => { const { [t.key]: _gone, ...rest } = m; return rest; });
        return Boolean(job);
      };
      const label = `${t.title}${t.artists?.length ? ` — ${t.artists.join(', ')}` : ''}`;
      const direct = targetFor(t);
      if (direct) return remember(await start(direct.tool, direct.url, label));
      flash(`Finding “${t.title}” on YouTube Music…`);
      try {
        const m = await api.fullSong(t);
        const target = m.id ? matchTarget(m.id) : null;
        if (!target) {
          flash(`No confident YouTube Music match for “${t.title}”, so nothing was downloaded.`);
          return remember(null);
        }
        return remember(await start(target.tool, target.url, label));
      } catch (e) {
        flash(`Could not look up “${t.title}”: ${(e as Error).message}`);
        return remember(null);
      }
    },
    [start, flash],
  );

  /** What the song's own download button shows: the state of the job that button started. */
  const trackState = useCallback(
    (key: string | null | undefined): 'idle' | 'working' | 'done' | 'error' => {
      const id = key ? trackJobs[key] : undefined;
      const job = id ? jobs.find((j) => j.id === id) : undefined;
      if (!job) return 'idle';
      if (active(job)) return 'working';
      if (job.state === 'done') return 'done';
      if (job.state === 'failed') return 'error';
      return 'idle';
    },
    [jobs, trackJobs],
  );

  /** PLAY-LIVE-001: the job a song's Download button started, as the rows read it (state and real percent). */
  const jobOf = useCallback(
    (key: string): { state: string; percent: number | null } | null => {
      const id = trackJobs[key];
      const job = id ? jobs.find((j) => j.id === id) : undefined;
      if (job) return { state: job.state, percent: job.percent ?? null };
      if (saved[key]) return { state: 'done', percent: 100 };
      // Not in the list yet (or never listed): the shell's own answer to the press.
      const first = fresh[key];
      if (first && first.job.id === id) return { state: first.job.state, percent: first.job.percent ?? null };
      return starting[key] ? { state: 'queued', percent: null } : null;
    },
    [jobs, trackJobs, starting, fresh, saved],
  );

  return { on, jobs, refresh: poll, format, setFormat, start, downloadTrack, trackState, jobOf, activeCount: jobs.filter(active).length };
}

export type Downloads = ReturnType<typeof useDownloads>;

const STAGE: Record<string, string> = { queued: 'Waiting', fetching: 'Downloading', converting: 'Converting', finalizing: 'Saving', done: 'Done' };

export function DownloadsView({ d }: { d: Downloads }) {
  const [health, setHealth] = useState<DlHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!d.on) return;
    dl.health().then(setHealth, (e: Error) => setErr(e.message));
  }, [d.on]);

  if (!d.on) {
    return (
      <section className="card" aria-labelledby="dl-h">
        <h2 id="dl-h">Local music</h2>
        <p className="empty">Downloads work in the Windows and Android apps. This page is running in a browser.</p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="dl-h">
      <h2 id="dl-h">Local music</h2>

      {err && <p className="state state--bad">{err}</p>}
      {health && health.tools.some((x) => !x.present) && (
        <ul className="dl__tools" aria-label="Tools">
          {/* Only a missing tool is worth a line; working versions were noise (DL-SIMPLE-001). */}
          {health.tools.filter((t) => !t.present).map((t) => (
            <li key={t.id} className={classNames('dl__tool', !t.present && 'is-bad')}>
              <strong>{t.id}</strong> {t.present ? (t.version && /^\d/.test(t.version) ? `v${t.version}` : (t.version ?? 'ready')) : 'unavailable'}
              {t.detail && <span className="dl__why"> {t.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {health && (
        // LOCAL-MUSIC-001 (owner 2026-11-17: "make the saved to local music folder bigger and labeled").
        <div className="localfolder">
          <span className="localfolder__label" id="localfolder-label">Local music folder</span>
          <span className="localfolder__hint">Downloaded songs and downloaded playlists are saved here.</span>
          <div className="localfolder__row">
            <output className="localfolder__path" aria-labelledby="localfolder-label" title={health.saves_to}>{health.saves_to}</output>
            <button className="push" type="button" onClick={() => void dl.chooseFolder().then((r) => setHealth({ ...health, saves_to: r.saves_to })).catch((e: Error) => setErr(e.message))}>Change folder</button>
          </div>
        </div>
      )}

      {d.jobs.length === 0 ? (
        <p className="empty">Nothing downloaded yet. Use the download button next to a song, or paste a link above.</p>
      ) : (
        <ul className="well tracks" aria-label="Download list">
          {[...d.jobs].reverse().map((j) => (
            <li key={j.id} className="track dl__job">
              <div className="track__text">
                <span className="track__title">{j.label || j.url}</span>
                <span className="track__artist">
                  {j.tool} · {j.format}
                  {' · '}
                  {j.state === 'failed' ? 'Failed' : j.state === 'cancelled' ? 'Cancelled' : (STAGE[j.stage] ?? j.stage)}
                  {j.state === 'running' && j.percent != null ? ` ${Math.round(j.percent)}%` : ''}
                </span>
                {active(j) && (
                  <div className="meter meter--dl" role="progressbar" aria-label={`Progress for ${j.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.percent != null ? Math.round(j.percent) : undefined}
                    style={{ '--fill': `${j.percent ?? 4}%` } as CSSProperties}>
                    <span />
                  </div>
                )}
                {j.state === 'failed' && <span className="track__warn">{j.error}</span>}
                {j.state === 'done' && j.files.map((f) => (
                  <span key={f.name} className="track__meta">
                    {f.name} · {fmtBytes(f.bytes)}
                  </span>
                ))}
              </div>
              <span className="track__actions">
                {j.state === 'done' && (
                  <button className="iconbtn" type="button" aria-label={`Show ${j.label} in its folder`} title="Show in folder" onClick={() => void dl.reveal(j.id)}>
                    <Glyph name="folder" size={14} />
                  </button>
                )}
                {active(j) ? (
                  <button className="push addbtn" type="button" onClick={() => void dl.cancel(j.id).then(d.refresh)}>
                    Cancel
                  </button>
                ) : (
                  <button className="iconbtn" type="button" aria-label={`Remove ${j.label} from the list`} title="Remove from list" onClick={() => void dl.forget(j.id).then(d.refresh)}>
                    <Glyph name="close" size={14} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
