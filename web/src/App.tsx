import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { api, newEventId, type FeedbackKind, type JobStatus, type Playback, type RecItem, type RecResult, type SavedItem, type Settings, type TasteSummary, type Track } from './api';
import { Art } from './Art';
import { Player, type ListenTelemetry, type Playing } from './Player';
import { Results, rowId, type FeedbackFlags } from './Results';
import { DownloadsView, useDownloads } from './Downloads';
import { Search } from './Search';
import { SoundCard } from './SoundCard';
import { ProfileView } from './Profile';
import { SettingsView } from './Settings';
import { PROVIDER_LABEL, QUEUE_SIZE_MAX, QUEUE_SIZE_MIN, addSeed, artistOf, classNames, describeTaste, fmtBytes, keepFocus, historyBack, mergeRerank, nextRepeat, playbackOfTrack, stepQueue, type RepeatMode } from './util';

type Tab = 'discover' | 'saved' | 'profile' | 'downloads' | 'settings';

/** One slider from Familiar to Adventurous, in steps of 0.01. Its label reads the position in words. */
function adventureLabel(a: number): string {
  if (a < 0.2) return 'Close to your starting songs';
  if (a < 0.4) return 'Mostly familiar artists';
  if (a <= 0.6) return 'A mix of familiar and new';
  if (a <= 0.8) return 'Mostly new artists';
  return 'Far from your starting songs';
}

const POLL_MS = 700;

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return m;
}

const SHUFFLE_KEY = 'airwave.shuffle';
const REPEAT_KEY = 'airwave.repeat';
function readFlag(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeFlag(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: the choice just is not remembered */
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>('discover');
  const [seeds, setSeeds] = useState<Track[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [result, setResult] = useState<RecResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [flags, setFlags] = useState<Record<string, FeedbackFlags>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [shuffle, setShuffle] = useState(() => readFlag(SHUFFLE_KEY) === 'on');
  const [repeat, setRepeat] = useState<RepeatMode>(() => {
    const v = readFlag(REPEAT_KEY);
    return v === 'all' || v === 'one' ? v : 'off';
  });
  /** Songs played this round (the shuffle never repeats one before every other has played) and the order they came in. */
  const heardRef = useRef<Set<string>>(new Set());
  const historyRef = useRef<string[]>([]);
  const [saved, setSaved] = useState<SavedItem[] | null>(null);
  const [offline, setOffline] = useState(false);
  const docked = useMedia('(max-width: 899px)');
  const jobRef = useRef<string | null>(null);
  const shownRef = useRef<Set<string>>(new Set());
  const playedRef = useRef<Set<string>>(new Set());
  const rerankSeq = useRef(0);
  // One id per app session: groups this sitting's events for the session taste horizon.
  const sessionRef = useRef(`s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const [taste, setTaste] = useState<TasteSummary | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------- load persisted state
  useEffect(() => {
    Promise.all([api.seeds(), api.settings(), api.feedbackState()])
      .then(([s, st, fb]) => {
        setSeeds(s.seeds);
        setSettings(st);
        const f: Record<string, FeedbackFlags> = {};
        for (const [k, v] of Object.entries(fb.state)) f[k] = { like: v.like, dislike: v.dislike, hide: v.hide, save: v.save };
        setFlags(f);
        if (fb.taste) setTaste(fb.taste);
        setLoaded(true);
        // Bring back the last finished queue; it was counted as shown when it was first drawn.
        api.last().then(
          (r) => {
            r.items.forEach((x) => shownRef.current.add(x.track.key));
            setResult((prev) => prev ?? r);
          },
          () => undefined,
        );
      })
      .catch(() => {
        setOffline(true);
        setLoaded(true);
      });
  }, []);

  const flash = (m: string) => {
    setNotice(m);
    window.setTimeout(() => setNotice((x) => (x === m ? null : x)), 3200);
  };
  const dls = useDownloads(flash);

  const saveSeeds = (next: Track[]) => {
    setSeeds(next);
    api.putSeeds(next).catch((e: Error) => flash(`Could not save your starting songs: ${e.message}`));
  };

  const onAdd = (t: Track) => {
    const r = addSeed(seeds, t);
    if (!r.added) return flash(r.reason ?? 'Not added.');
    setSeeds(r.seeds);
    // Save first, then discover: the engine reads starting songs from the store, and a freshly
    // added song should appear at the top of the list with new discoveries, not sit idle.
    api
      .putSeeds(r.seeds)
      .then(() => run(true))
      .catch((e: Error) => flash(`Could not save your starting songs: ${e.message}`));
  };

  const patchSettings = (p: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    api
      .putSettings(p)
      .then(setSettings)
      .catch((e: Error) => flash(e.message));
  };

  // ---------------------------------------------------------------- recommendations
  const items = useMemo(() => (result?.items ?? []).filter((x) => !hidden.has(x.track.key)), [result, hidden]);

  const applyResult = useCallback((r: RecResult) => {
    setResult((prev) => {
      const prevKeys = (prev?.items ?? []).map((x) => x.track.key);
      setFocusKey((f) => keepFocus(prevKeys, f, r.items.map((x) => x.track.key)));
      return r;
    });
  }, []);

  /** Watch one discovery batch, showing each phase's list as it arrives. */
  const follow = useCallback(
    async (id: string) => {
      jobRef.current = id;
      setJob({ job: id, phase: 'starting', progress: 'Starting…', done: false, error: null, result: null, elapsed_ms: 0, sources: {} });
      let lastPhase = '';
      while (jobRef.current === id) {
        const s = await api.job(id);
        if (jobRef.current !== id) break;
        setJob(s);
        if (s.result && s.result.phase !== lastPhase) {
          lastPhase = s.result.phase;
          applyResult(s.result);
        } else if (s.result && s.done) applyResult(s.result);
        if (s.done) {
          if (s.error) setRunErr(s.error);
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    },
    [applyResult],
  );

  const run = async (force = false) => {
    if (!force && !seeds.length) return;
    setRunErr(null);
    if (jobRef.current) void api.cancelJob(jobRef.current).catch(() => undefined);
    try {
      const { job: id } = await api.recommend();
      if (id) await follow(id);
    } catch (e) {
      setRunErr((e as Error).message);
      setJob(null);
    }
  };

  const cancel = () => {
    if (jobRef.current) void api.cancelJob(jobRef.current).catch(() => undefined);
  };

  /** Empty the song list (starting songs + queue). Taste, history and settings stay. */
  const clearList = () => {
    jobRef.current = null;
    api.clearQueue().then(
      () => {
        setSeeds([]);
        setResult(null);
        setJob(null);
        setRunErr(null);
        setFocusKey(null);
        setHidden(new Set());
        flash('Song list cleared. Your listening history and settings are kept.');
      },
      (e: Error) => flash(`Could not clear the list: ${e.message}`),
    );
  };

  const loadSample = () => {
    jobRef.current = null;
    setJob(null);
    setRunErr(null);
    api
      .sample()
      .then(applyResult)
      .catch((e: Error) => setRunErr(`Sample data is not available: ${e.message}`));
  };

  // Count an impression only for rows that were actually drawn, once per result set.
  useEffect(() => {
    if (!result || result.sample) return;
    const fresh = items.map((x) => x.track.key).filter((k) => !shownRef.current.has(k));
    if (!fresh.length) return;
    fresh.forEach((k) => shownRef.current.add(k));
    api.impressions(fresh).catch(() => undefined);
  }, [items, result]);

  // ---------------------------------------------------------------- playback
  const play = (it: RecItem, o?: { newRound?: boolean; back?: boolean }) => {
    playedRef.current.add(it.track.key);
    if (o?.newRound) heardRef.current = new Set();
    heardRef.current.add(it.track.key);
    if (!o?.back) historyRef.current = [...historyRef.current.slice(-199), it.track.key];
    setPlaying({ track: it.track, playback: it.playback });
    setFocusKey(it.track.key);
  };
  const previewTrack = (t: Track) => setPlaying({ track: t, playback: playbackOfTrack(t) });
  const playingKey = playing?.track.key ?? null;
  const inQueue = playingKey != null && items.some((x) => x.track.key === playingKey);
  const queueOpts = { shuffle, repeat, heard: heardRef.current };
  const nextStep = stepQueue(items, inQueue ? playingKey : null, 1, hidden, queueOpts);
  const back = shuffle ? historyBack(historyRef.current, playingKey, items, hidden) : null;
  const prevStep = shuffle ? (back ? { item: back.item, wrapped: false } : null) : inQueue ? stepQueue(items, playingKey, -1, hidden, queueOpts) : null;
  const goNext = () => {
    if (nextStep) play(nextStep.item, { newRound: nextStep.wrapped });
  };
  const goPrev = () => {
    if (!prevStep) return;
    if (back) historyRef.current = historyRef.current.slice(0, back.keep);
    play(prevStep.item, { back: Boolean(back) });
  };
  const toggleShuffle = () =>
    setShuffle((s) => {
      const on = !s;
      writeFlag(SHUFFLE_KEY, on ? 'on' : 'off');
      // A new shuffle round starts from the song now playing.
      heardRef.current = new Set(playingKey ? [playingKey] : []);
      return on;
    });
  const cycleRepeat = () =>
    setRepeat((r) => {
      const n = nextRepeat(r);
      writeFlag(REPEAT_KEY, n);
      return n;
    });
  const upNext = useMemo(() => {
    const i = inQueue ? items.findIndex((x) => x.track.key === playingKey) : -1;
    const playable = (x: RecItem) => x.playback.preview || x.playback.embed;
    // Shuffled, the songs still to come are the ones not heard this round; their order is decided when the next is picked.
    const rest = shuffle ? items.filter((x) => x.track.key !== playingKey && !heardRef.current.has(x.track.key) && !hidden.has(x.track.key)) : items.slice(i + 1);
    return rest
      .filter(playable)
      .slice(0, 4)
      .map((x) => ({ key: x.track.key, title: x.track.title, artist: artistOf(x.track), artwork: x.track.artwork }));
  }, [items, inQueue, playingKey, shuffle, hidden]);

  // A skip or a full listen is recorded, then the songs still to come are ranked again with it.
  // Only the newest answer is applied, so two quick skips cannot show the older order.
  // The event id is derived from the playback instance, so a duplicated player callback or a UI
  // retry re-sends the SAME id and the store's dedupe actually catches it.
  const refreshTaste = () => api.feedbackState().then((r) => setTaste(r.taste ?? null), () => undefined);

  const onListen = (kind: 'complete' | 'skip' | 'replay', t: Track, listened: number, meta: ListenTelemetry) => {
    const sample = Boolean(result?.sample);
    const seq = ++rerankSeq.current;
    const eventId = `${kind}:${t.key.slice(0, 40)}:${meta.instance}`.slice(0, 80);
    void api
      .feedback(kind, t, {
        event_id: eventId,
        listened: Math.round(listened * 10) / 10,
        duration: meta.duration ?? undefined,
        medium: meta.medium,
        coverage: Math.round(meta.coverage * 10) / 10,
        session: sessionRef.current,
        origin: 'queue',
      })
      .then(() => {
        // Learning shows even with no queue to re-rank: the Your sound card reads the same taste.
        if (sample || !result) void refreshTaste();
        return sample || !result ? null : api.rerank([...playedRef.current]);
      })
      .then((r) => {
        if (!r || seq !== rerankSeq.current) return;
        setTaste(r.taste);
        setResult((prev) => {
          if (!prev || prev.sample) return prev;
          const merged = mergeRerank(prev.items, r.items, playedRef.current);
          setFocusKey((f) => keepFocus(prev.items.map((x) => x.track.key), f, merged.map((x) => x.track.key)));
          return { ...prev, items: merged, count: merged.length };
        });
      })
      .then(() => {
        // Listening is the other way to discover. The engine decides whether the list is actually
        // running low and answers job:null otherwise, so a finished song usually costs nothing.
        if (sample || !result || kind !== 'complete') return;
        return api
          .recommend({ event_id: eventId, exclude: [...playedRef.current] })
          .then(({ job: id }) => (id ? follow(id) : undefined))
          .catch(() => undefined);
      })
      .catch(() => undefined);
  };

  const wheelStep = (dir: 1 | -1) => {
    if (!items.length) return;
    const i = focusKey ? items.findIndex((x) => x.track.key === focusKey) : -1;
    const n = items[Math.min(items.length - 1, Math.max(0, i + dir))];
    if (n) {
      setFocusKey(n.track.key);
      document.getElementById(rowId(n.track.key))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  const wheelSelect = () => {
    const it = items.find((x) => x.track.key === focusKey) ?? items[0];
    if (it && (it.playback.preview || it.playback.embed)) play(it);
  };

  // ---------------------------------------------------------------- feedback
  const onFeedback = (it: RecItem, kind: FeedbackKind) => {
    const k = it.track.key;
    setFlags((f) => {
      const cur = { ...(f[k] ?? {}) };
      if (kind === 'like') Object.assign(cur, { like: true, dislike: false });
      if (kind === 'unlike') cur.like = false;
      if (kind === 'dislike') Object.assign(cur, { dislike: true, like: false });
      if (kind === 'undislike') cur.dislike = false;
      if (kind === 'hide') cur.hide = true;
      return { ...f, [k]: cur };
    });
    if (kind === 'hide') {
      setHidden((h) => new Set(h).add(k));
      flash(`Hidden “${it.track.title}”. It will be less likely to come back for a while.`);
    }
    if (result?.sample) return; // sample rows are not real songs to learn from
    api.feedback(kind, it.track, { event_id: newEventId(kind, k) }).then(() => void refreshTaste(), (e: Error) => flash(`Could not save that: ${e.message}`));
  };

  useEffect(() => {
    if (tab === 'saved') api.saved().then((r) => setSaved(r.items), () => setSaved([]));
  }, [tab, flags]);

  /** Take a song off Saved: the like is removed on the engine and the row goes at once. */
  const removeSaved = (track: Track) => {
    setSaved((list) => (list ? list.filter((x) => x.track.key !== track.key) : list));
    setFlags((f) => ({ ...f, [track.key]: { ...(f[track.key] ?? {}), like: false } }));
    api.feedback('unlike', track).then(() => void refreshTaste(), (e: Error) => flash(`Could not remove that: ${e.message}`));
  };

  // ---------------------------------------------------------------- render
  const running = Boolean(job && !job.done);
  const sample = Boolean(result?.sample);
  const adventurous = settings?.adventurous ?? 0.5;
  const fresh = settings?.fresh ?? false;
  const queueSize = settings?.queue_size ?? 20;
  const tasteLine = describeTaste(taste);

  const transferNote = result && !sample ? Object.values(result.transfer ?? {}).reduce((a, b) => a + (b || 0), 0) : 0;
  const srcEntries = Object.entries(job?.sources ?? result?.sources ?? {});
  const failed = srcEntries.filter(([, s]) => s.state !== 'ok' && s.state !== 'skipped');

  // The desktop player bar is fixed to the bottom; its measured height keeps the last song clear of it.
  useEffect(() => {
    const rail = document.querySelector<HTMLElement>('.rail');
    if (!rail || docked) return;
    const set = () => document.documentElement.style.setProperty('--strip-h', `${rail.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(rail);
    return () => ro.disconnect();
  }, [docked, Boolean(playing)]);

  // The phone dock is measured the same way: its rows (title, progress, controls, song actions) wrap
  // differently by width and language, so a fixed --dock-h would either cover the last song or leave a gap.
  useEffect(() => {
    const root = document.documentElement;
    if (!docked || !playing) {
      root.style.removeProperty('--dock-h');
      return;
    }
    const dock = document.querySelector<HTMLElement>('.np--docked');
    if (!dock) return;
    const set = () => root.style.setProperty('--dock-h', `${dock.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(dock);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--dock-h');
    };
  }, [docked, Boolean(playing)]);

  return (
    <div className={classNames('app', docked && 'app--docked', playing && docked && 'has-dock', !docked && 'has-strip')}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="side" aria-label="Airwave">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <Glyph name="discover" size={18} />
          </span>
          <span className="brand__name">Airwave Discovery</span>
        </div>
        <ul className="side__nav">
          {(
            [
              ['discover', 'Discover', 'discover'],
              ['saved', 'Saved', 'heart'],
              ['profile', 'Profile', 'eq'],
              ...(dls.on ? ([['downloads', 'Downloads', 'download']] as const) : []),
              ['settings', 'Settings', 'gear'],
            ] as const
          ).map(([id, label, g]) => (
            <li key={id}>
              <button className={classNames('side__item', tab === id && 'is-on')} type="button" aria-label={label} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
                <Glyph name={g} size={15} />
                <span>{label}</span>
                {id === 'downloads' && dls.activeCount > 0 && <span className="count">{dls.activeCount}</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="side__count" aria-live="polite">
          {seeds.length} starting {seeds.length === 1 ? 'song' : 'songs'}
        </p>
      </nav>

      <main id="main" className="main">
        {offline && (
          <p className="banner banner--bad" role="alert">
            <Glyph name="offline" size={14} /> The Airwave service is not answering on this computer. Start it with <code>pnpm discovery</code> and reload.
          </p>
        )}
        {notice && (
          <p className="toast" role="status">
            {notice}
          </p>
        )}

        {tab === 'discover' && (
          <>
            <div ref={searchRef}>
              <Search seeds={seeds} onAdd={onAdd} onPreview={previewTrack} onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined} />
            </div>

            <section className="go" aria-label="Find recommendations">
              <div className="go__controls">
                <label className="dial">
                  <span className="dial__end">Familiar</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={adventurous}
                    aria-label="Familiar to adventurous"
                    aria-valuetext={`${adventureLabel(adventurous)} (${Math.round(adventurous * 100)}%)`}
                    style={{ ['--pct' as string]: `${adventurous * 100}%` }}
                    onChange={(e) => setSettings((s) => (s ? { ...s, adventurous: Number(e.target.value) } : s))}
                    onPointerUp={(e) => patchSettings({ adventurous: Number((e.target as HTMLInputElement).value) })}
                    onKeyUp={(e) => patchSettings({ adventurous: Number((e.target as HTMLInputElement).value) })}
                  />
                  <span className="dial__end">Adventurous</span>
                </label>
                <p className="go__hint go__level" aria-live="polite">{adventureLabel(adventurous)}</p>
                {/* The limit itself lives in Settings, where it also governs listening top-ups. */}
                <p className="go__hint">
                  Up to {queueSize} new {queueSize === 1 ? 'song' : 'songs'} per discovery — change it in Settings
                </p>
                <label className="go__fresh">
                  <input type="checkbox" checked={fresh} onChange={(e) => patchSettings({ fresh: e.target.checked })} />
                  <span>Favour new releases</span>
                  <span className="go__freshnote">songs from the last 60 days, when the source gives a date</span>
                </label>
              </div>
              <div className="go__row">
                <button className="push push--default push--big" type="button" disabled={!seeds.length || running || !loaded} aria-describedby="go-why" onClick={() => void run()}>
                  {running ? 'Finding…' : 'Find my next favorite'}
                </button>
                {running && (
                  <button className="push" type="button" onClick={cancel}>
                    Stop
                  </button>
                )}
                <span id="go-why" className="go__why">
                  {!seeds.length ? 'Add at least one starting song first.' : running ? job?.progress : ''}
                </span>
                {settings?.sample_mode && (
                  <button className="linkbtn go__sample" type="button" onClick={loadSample}>
                    Show sample data
                  </button>
                )}
              </div>
            </section>

            <SoundCard taste={taste} listening={Boolean(playing)} />

            <section className="queue" aria-labelledby="queue-h" aria-busy={running}>
              {sample && (
                <p className="banner banner--sample" role="note">
                  <Glyph name="info" size={14} /> {result!.sample!.label} Recorded {result!.sample!.recorded}. These rows are for looking at the interface; likes are not saved.
                </p>
              )}
              {result?.saved_at && !job && (
                <p className="banner" role="note">
                  <Glyph name="info" size={14} /> Your last queue, from {new Date(result.saved_at * 1000).toLocaleString()}. Press “Find my next favorite” for a fresh one.
                </p>
              )}
              {runErr && (
                <p className="state state--bad" role="alert">
                  <Glyph name="warning" size={14} /> {runErr}
                </p>
              )}
              {result ? (
                <>
                  <div className="queue__head">
                    <h2 id="queue-h">
                      Songs <span className="count">{seeds.length + items.length}</span>
                    </h2>
                    {!sample && (
                      <button className="push push--small" type="button" title="Empty the song list. Your listening history and settings are kept." onClick={clearList}>
                        <Glyph name="clear" size={12} /> Clear list
                      </button>
                    )}
                    <span className="queue__meta">
                      {running && result.phase === 'gathering' ? (
                        <>
                          <span className="sdot sdot--busy" aria-hidden="true" /> First songs found; still asking the other services…
                        </>
                      ) : running && result.phase === 'metadata' ? (
                        <>
                          <span className="sdot sdot--busy" aria-hidden="true" /> Listening to previews to refine the order…
                        </>
                      ) : result.phase === 'final' && result.audio?.compared ? (
                        `Order refined by sound: ${result.audio.compared} songs compared.${result.audio.stopped ? ` ${result.audio.stopped}` : ''}`
                      ) : result.audio?.stopped ? (
                        `Matched by metadata. ${result.audio.stopped}`
                      ) : result.audio?.skipped ? (
                        `Matched by metadata. ${result.audio.skipped}`
                      ) : (
                        'Matched by metadata.'
                      )}
                    </span>
                  </div>
                  {tasteLine && (
                    <p className="note note--taste" role="status" aria-live="polite">
                      <Glyph name="info" size={12} /> {tasteLine}
                    </p>
                  )}
                  {result.count < result.asked && !sample && (
                    <p className="note">
                      Found {result.count} songs worth suggesting{result.empty_reason ? ` — ${result.empty_reason}` : '.'} Airwave does not pad the list.
                    </p>
                  )}
                  {failed.length > 0 && (
                    <p className="note">
                      <Glyph name="warning" size={12} /> Some sources did not answer ({failed.map(([k]) => k).join(', ')}); the queue uses the rest.
                    </p>
                  )}
                  {items.length || seeds.length ? (
                    <Results
                      seeds={seeds}
                      onRemoveSeed={(k) => saveSeeds(seeds.filter((s) => s.key !== k))}
                      onEmphasis={(k, e) => saveSeeds(seeds.map((s) => (s.key === k ? { ...s, emphasis: e } : s)))}
                      items={items}
                      focusKey={focusKey}
                      playingKey={playingKey}
                      flags={flags}
                      onFocus={setFocusKey}
                      onPlay={play}
                      onPlayTrack={previewTrack}
                      onFeedback={onFeedback}
                      onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
                    />
                  ) : (
                    <p className="empty">No songs to show. Move the slider or add another starting song.</p>
                  )}
                  {!sample && (
                    <p className="queue__foot">
                      {transferNote ? `This request downloaded ${fmtBytes(transferNote)}. ` : ''}
                      {result.candidates ? `${result.candidates} candidates considered.` : ''}
                    </p>
                  )}
                </>
              ) : running ? (
                <div className="empty">
                  <span className="sdot sdot--busy" aria-hidden="true" /> {job?.progress || 'Asking the music services…'}
                </div>
              ) : seeds.length ? (
                <>
                  <div className="queue__head">
                    <h2 id="queue-h">
                      Songs <span className="count">{seeds.length}</span>
                    </h2>
                    <button className="push push--small" type="button" title="Empty the song list. Your listening history and settings are kept." onClick={clearList}>
                      <Glyph name="clear" size={12} /> Clear list
                    </button>
                  </div>
                  <Results
                    seeds={seeds}
                    onRemoveSeed={(k) => saveSeeds(seeds.filter((s) => s.key !== k))}
                    onEmphasis={(k, e) => saveSeeds(seeds.map((s) => (s.key === k ? { ...s, emphasis: e } : s)))}
                    items={[]}
                    focusKey={focusKey}
                    playingKey={playingKey}
                    flags={flags}
                    onFocus={setFocusKey}
                    onPlay={play}
                    onPlayTrack={previewTrack}
                    onFeedback={onFeedback}
                    onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
                  />
                  <p className="queue__foot">Press “Find my next favorite” to add songs to this list.</p>
                </>
              ) : (
                <div className="empty empty--hero">
                  <span className="empty__art" aria-hidden="true">
                    <Glyph name="note" size={28} />
                  </span>
                  <p>Search for a song you love, press Add, then find your next favorite.</p>
                </div>
              )}
            </section>
          </>
        )}

        {tab === 'saved' && (
          <section className="card" aria-labelledby="saved-h">
            <h2 id="saved-h">Saved</h2>
            {saved == null ? (
              <p className="state">
                <span className="sdot sdot--busy" aria-hidden="true" /> Loading…
              </p>
            ) : saved.length === 0 ? (
              <p className="empty">Songs you like appear here.</p>
            ) : (
              <ul className="well tracks">
                {saved.map((s) => (
                  <li key={s.track.key} className="track">
                    <Art src={s.track.artwork} size={44} />
                    <div className="track__text">
                      <span className="track__title">{s.track.title}</span>
                      <span className="track__artist">{artistOf(s.track)}</span>
                    </div>
                    <span className="track__actions">
                      <button className="iconbtn" type="button" aria-label={`Play ${s.track.title}`} onClick={() => previewTrack(s.track)}>
                        <Glyph name="play" size={14} />
                      </button>
                      {dls.on && (
                        <button className="iconbtn" type="button" aria-label={`Download ${s.track.title}`} title="Download" onClick={() => void dls.downloadTrack(s.track)}>
                          <Glyph name="download" size={14} />
                        </button>
                      )}
                      <button className="push addbtn" type="button" disabled={seeds.some((x) => x.key === s.track.key)} onClick={() => onAdd(s.track)}>
                        Add
                      </button>
                      <button
                        className="iconbtn"
                        type="button"
                        aria-label={`Remove ${s.track.title} from Saved`}
                        title="Remove from Saved"
                        onClick={() => removeSaved(s.track)}
                      >
                        <Glyph name="close" size={14} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {tab === 'profile' && <ProfileView />}

        {tab === 'downloads' && <DownloadsView d={dls} />}

        {tab === 'settings' && (
          <SettingsView
            settings={settings}
            onSettings={patchSettings}
            onResetTaste={() =>
              api.resetTaste().then(
                () => {
                  setFlags({});
                  setHidden(new Set());
                  flash('The ranking forgot your plays, likes and skips. Starting songs and settings kept.');
                  if (result && !result.sample) void run();
                },
                (e: Error) => flash(e.message),
              )
            }
            onReset={() =>
              api.reset(false).then(() => {
                setSeeds([]);
                setFlags({});
                setHidden(new Set());
                setResult(null);
                api.settings().then(setSettings, () => undefined);
                flash('Reset. Your starting songs, feedback and settings are cleared.');
              })
            }
          />
        )}
      </main>

      <aside className="rail" aria-label="Player">
        <Player
          playing={playing}
          upNext={upNext}
          docked={docked}
          canPrev={Boolean(prevStep)}
          canNext={Boolean(nextStep)}
          shuffle={shuffle}
          repeat={repeat}
          actions={{
            flags: (playing && flags[playing.track.key]) || {},
            downloadState: dls.trackState(playing?.track.key),
            downloadAvailable: dls.on,
            onFeedback: async (kind) => {
              const it = playing ? items.find((x) => x.track.key === playing.track.key) : undefined;
              if (it) {
                onFeedback(it, kind);
                return;
              }
              if (!playing) return;
              // The song playing may have left the list (a new queue, or a search result): record it directly.
              setFlags((f) => {
                const cur = { ...(f[playing.track.key] ?? {}) };
                if (kind === 'like') Object.assign(cur, { like: true, dislike: false });
                if (kind === 'unlike') cur.like = false;
                if (kind === 'dislike') Object.assign(cur, { dislike: true, like: false });
                if (kind === 'undislike') cur.dislike = false;
                return { ...f, [playing.track.key]: cur };
              });
              if (result?.sample) return;
              await api.feedback(kind, playing.track, { event_id: newEventId(kind, playing.track.key) });
              await refreshTaste();
            },
            onDownload: async () => (playing ? dls.downloadTrack(playing.track) : false),
            onDownloads: () => setTab('downloads'),
          }}
          onShuffle={toggleShuffle}
          onRepeat={cycleRepeat}
          onPrev={goPrev}
          onNext={goNext}
          onListen={onListen}
          onWheel={wheelStep}
          onSelect={wheelSelect}
          onMenu={() => {
            setTab('discover');
            window.setTimeout(() => searchRef.current?.querySelector('input')?.focus(), 0);
          }}
          onPickUpNext={(k) => {
            const it = items.find((x) => x.track.key === k);
            if (it) play(it);
          }}
        />
      </aside>
    </div>
  );
}
