import { useCallback, useEffect, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { api, type Track } from './api';
import { DL_FORMATS, dl, downloadsAvailable, matchTarget, targetFor, urlAllowedFor, type DlFormat, type DlHealth, type DlJob, type DlTool } from './engine/downloads';
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
export function useDownloads(flash: (m: string) => void) {
  const on = downloadsAvailable();
  const [jobs, setJobs] = useState<DlJob[]>([]);
  /** Which native job each song's download button started, so the button can show that job's state. */
  const [trackJobs, setTrackJobs] = useState<Record<string, string>>({});
  const [format, setFormatState] = useState<DlFormat>(loadFormat);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!on) return [] as DlJob[];
    try {
      const r = await dl.jobs();
      setJobs(r.jobs);
      return r.jobs;
    } catch {
      return [] as DlJob[];
    }
  }, [on]);

  const poll = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void refresh().then((list) => {
      if (list.some(active)) timer.current = setTimeout(poll, 1000);
    });
  }, [refresh]);

  useEffect(() => {
    poll();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poll]);

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
          flash(`Downloading “${r2.job.label || label}”. Follow it in Downloads.`);
          poll();
          return r2.job;
        }
        const r = await dl.start(url, tool, format, label);
        flash(`Downloading “${r.job.label || label}”. Follow it in Downloads.`);
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
      const remember = (job: DlJob | null) => {
        if (job) setTrackJobs((m) => ({ ...m, [t.key]: job.id }));
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
          return false;
        }
        return remember(await start(target.tool, target.url, label));
      } catch (e) {
        flash(`Could not look up “${t.title}”: ${(e as Error).message}`);
        return false;
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

  return { on, jobs, refresh: poll, format, setFormat, start, downloadTrack, trackState, activeCount: jobs.filter(active).length };
}

export type Downloads = ReturnType<typeof useDownloads>;

const STAGE: Record<string, string> = { queued: 'Waiting', fetching: 'Downloading', converting: 'Converting', finalizing: 'Saving', done: 'Done' };

export function DownloadsView({ d }: { d: Downloads }) {
  const [health, setHealth] = useState<DlHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [tool, setTool] = useState<DlTool>('yt-dlp');

  useEffect(() => {
    if (!d.on) return;
    dl.health().then(setHealth, (e: Error) => setErr(e.message));
  }, [d.on]);

  if (!d.on) {
    return (
      <section className="card" aria-labelledby="dl-h">
        <h2 id="dl-h">Downloads</h2>
        <p className="empty">Downloads work in the Windows and Android apps. This page is running in a browser.</p>
      </section>
    );
  }

  const linkOk = link.trim() !== '' && urlAllowedFor(tool, link.trim());
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!linkOk) return;
    void d.start(tool, link.trim(), link.trim()).then((job) => job && setLink(''));
  };

  return (
    <section className="card" aria-labelledby="dl-h">
      <h2 id="dl-h">Downloads</h2>
      <p className="note">
        yt-dlp fetches from YouTube, YouTube Music and SoundCloud; spotDL fetches a Spotify track by finding it on YouTube Music. Only download what you have the right to keep.
      </p>

      <form className="dl__form" onSubmit={submit}>
        <label className="dl__lbl">
          Tool
          <select className="field" value={tool} onChange={(e) => setTool(e.target.value as DlTool)}>
            <option value="yt-dlp">yt-dlp (YouTube, SoundCloud)</option>
            <option value="spotdl">spotDL (Spotify track link)</option>
          </select>
        </label>
        <label className="dl__lbl">
          Format
          <select className="field" value={d.format} onChange={(e) => d.setFormat(e.target.value as DlFormat)} aria-describedby="dl-format-note">
            {DL_FORMATS.filter((f) => !(tool === 'spotdl' && f === 'original')).map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        <label className="dl__lbl dl__lbl--grow">
          Link
          <input className="field" type="url" inputMode="url" placeholder={tool === 'spotdl' ? 'https://open.spotify.com/track/…' : 'https://www.youtube.com/watch?v=…'} value={link} onChange={(e) => setLink(e.target.value)} aria-invalid={link.trim() !== '' && !linkOk} />
        </label>
        <button className="push push--big" type="submit" disabled={!linkOk}>
          Download
        </button>
      </form>
      <p className="dl__note" id="dl-format-note">{FORMAT_NOTE[d.format]}</p>
      {link.trim() !== '' && !linkOk && <p className="state state--bad">{tool === 'spotdl' ? 'spotDL needs a Spotify track link (open.spotify.com/track/…).' : 'yt-dlp needs a YouTube, YouTube Music or SoundCloud link.'}</p>}

      {err && <p className="state state--bad">{err}</p>}
      {health && (
        <ul className="dl__tools" aria-label="Tools">
          {health.tools.map((t) => (
            <li key={t.id} className={classNames('dl__tool', !t.present && 'is-bad')}>
              <strong>{t.id}</strong> {t.present ? (t.version && /^\d/.test(t.version) ? `v${t.version}` : (t.version ?? 'ready')) : 'unavailable'}
              {t.detail && <span className="dl__why"> {t.detail}</span>}
            </li>
          ))}
          <li className="dl__tool">Saved to {health.saves_to}</li>
        </ul>
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
                  <div className="meter" role="progressbar" aria-label={`Progress for ${j.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.percent != null ? Math.round(j.percent) : undefined}>
                    <span style={{ width: `${j.percent ?? 4}%` }} />
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
