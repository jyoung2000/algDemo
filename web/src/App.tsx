import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { api, newEventId, type FeedbackKind, type JobStatus, type Playback, type PlaylistSummary, type RecItem, type RecResult, type SavedItem, type Settings, type TasteSummary, type Track } from './api';
import { Art } from './Art';
import { Player, type ListenTelemetry, type Playing } from './Player';
import { Results, rowId, type FeedbackFlags } from './Results';
import { DownloadsView, useDownloads } from './Downloads';
import { Search } from './Search';
import { SoundCard } from './SoundCard';
import { ProfileView } from './Profile';
import { SavedView } from './SavedView';
import { QueuePreparation } from './QueuePreparation';
import { ListDownloadBar, ListDownloadButton } from './ListDownloadBar';
import { useCardCache } from './useCardCache';
import { useKeptKeys } from './useKeptKeys';
import { savedTracks, playbackRows, preparationTracks } from './engine/queue-context';
import { decodePlaylistMediaId, mediaNativeAvailable, pushMediaLibrary, pushMediaState, setMediaHandlers, songFromTrack } from './engine/media-native';
import { SettingsView } from './Settings';
import { setEqConfig, setLocalMix, setMixSlider, setPlayThrough } from './audio-engine';
import { PLAY_THROUGH_DEFAULT } from './engine/crossfade';
import { dl, downloadsAvailable } from './engine/downloads';
import { readResume } from './engine/resume';
import { PROVIDER_LABEL, QUEUE_SIZE_MAX, QUEUE_SIZE_MIN, addSeed, artistOf, canPlayHere, classNames, describeTaste, dropExpired, expiredKeysOf, fmtBytes, keepFocus, historyBack, mergeRerank, nextRepeat, playbackOfTrack, readyFilter, stepQueue, type RepeatMode } from './util';
import { queueAudio } from './engine/queue-audio';
import { CarCatalog } from './engine/car-catalog';

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
  /** The listener's saved lists. Loaded with Saved and refreshed by every list edit. */
  const [lists, setLists] = useState<PlaylistSummary[]>([]);
  /**
   * Which saved list the current song was started from, or null for the discovery queue. A list
   * is topped up only once everything in it has been played, so the engine needs to know which.
   */
  const playingListRef = useRef<string | null>(null);
  const [playingContext, setPlayingContext] = useState<string | null>(null);
  const [visibleSavedList, setVisibleSavedList] = useState('all');
  // Readiness and the ten-minute give-up set change outside React as native downloads finish.
  // Keep the displayed list and committed Up Next in sync without polling or touching kept files.
  const [cacheRevision, setCacheRevision] = useState(0);
  useEffect(() => queueAudio.subscribe(() => setCacheRevision(x => x + 1)), []);
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
  const [carCatalog] = useState(() => new CarCatalog(api.search, track => queueAudio.isReady(track)));

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
        // Where the listener was when the app last stopped (RESUME-001). Restored only in the
        // installed shells, where the song is a local file: the place is useless without the audio.
        if (downloadsAvailable()) {
          const point = readResume();
          if (point) setPlaying({ track: point.track, playback: point.playback, resumeAt: point.t });
        }
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

  // The audio engine is a page-level singleton, not React state, because a browser allows one
  // AudioContext per page. Mirroring the stored settings into it here means the equaliser and the
  // mixer are live wherever the listener changed them, and survive a reload.
  useEffect(() => {
    if (!settings) return;
    setEqConfig(settings.eq);
    setMixSlider(settings.mix ?? 0);
    setLocalMix(settings.local_mix ?? true);
    setPlayThrough(settings.play_through ?? PLAY_THROUGH_DEFAULT);
  }, [settings?.eq, settings?.mix, settings?.local_mix, settings?.play_through]);

  // ---------------------------------------------------------------- recommendations
  const expired = expiredKeysOf(queueAudio);
  // A revision for an ordinary progress event must not recreate the prefetch list: update() emits
  // another progress event, which would otherwise form a render/update loop.
  const expiredSignature = [...expired].sort().join('\0');
  const visibleSeeds = useMemo(() => seeds.filter(t => !expired.has(t.key)), [seeds, expiredSignature]);
  const items = useMemo(() => dropExpired((result?.items ?? []).filter((x) => !hidden.has(x.track.key)), expired), [result, hidden, expiredSignature]);

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
        flash('Now playing queue cleared. Your listening history and settings are kept.');
      },
      (e: Error) => flash(`Could not clear the now playing queue: ${e.message}`),
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
  const play = (it: RecItem, o?: { newRound?: boolean; back?: boolean; keepList?: boolean }) => {
    // Playing from the queue leaves any saved list behind, so the queue's own rule applies again.
    if (!o?.keepList) { playingListRef.current = null; setPlayingContext(null); }
    playedRef.current.add(it.track.key);
    if (o?.newRound) heardRef.current = new Set();
    heardRef.current.add(it.track.key);
    if (!o?.back) historyRef.current = [...historyRef.current.slice(-199), it.track.key];
    setPlaying({ track: it.track, playback: it.playback });
    setFocusKey(it.track.key);
  };
  const previewTrack = (t: Track) => setPlaying({ track: t, playback: playbackOfTrack(t) });
  const activeItems = useMemo(() => playingContext === null ? items : playbackRows(savedTracks(saved, lists, playingContext)), [items, playingContext, saved, lists]);
  const playingKey = playing?.track.key ?? null;
  const inQueue = playingKey != null && activeItems.some((x) => x.track.key === playingKey);
  const ready = readyFilter(queueAudio, downloadsAvailable());
  const readySignature = useMemo(() => ready ? activeItems.filter(x => ready(x.track)).map(x => x.track.key).join('\0') : '', [activeItems, cacheRevision]);
  const queueOpts = { shuffle, repeat, heard: heardRef.current, ready };
  const nextStep = stepQueue(activeItems, inQueue ? playingKey : null, 1, hidden, queueOpts);
  const back = shuffle ? historyBack(historyRef.current, playingKey, ready ? activeItems.filter(x => ready(x.track)) : activeItems, hidden) : null;
  const prevStep = shuffle ? (back ? { item: back.item, wrapped: false } : null) : inQueue ? stepQueue(activeItems, playingKey, -1, hidden, queueOpts) : null;
  const goNext = () => {
    // Recheck the shell's current local-file answer at the moment of transition: eviction can
    // happen after Up Next was rendered. A stale pick must never become a spinner or preview.
    const live = stepQueue(activeItems, inQueue ? playingKey : null, 1, hidden, queueOpts);
    if (live && (!ready || ready(live.item.track))) play(live.item, { newRound: live.wrapped, keepList: true });
  };
  const goPrev = () => {
    if (!prevStep || (ready && !ready(prevStep.item.track))) return;
    if (back) historyRef.current = historyRef.current.slice(0, back.keep);
    play(prevStep.item, { back: Boolean(back), keepList: true });
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
  // The first entry is the song that WILL play next — the player cues, downloads and blends into
  // it (SHUFFLE-NEXT-001). Shuffled, that is the committed pick; the rest are the songs still to come.
  const nextKey = nextStep && !nextStep.wrapped ? nextStep.item.track.key : null;
  const upNext = useMemo(() => {
    const i = inQueue ? activeItems.findIndex((x) => x.track.key === playingKey) : -1;
    // A song belongs in the deck queue when this build can play it at all. Inside the apps that is
    // every song in the list, because the player downloads the full track (QUEUE-PLAY-001); asking
    // for a streaming preview here silently dropped preview-less songs out of the queue, so they
    // were never cued and never blended into.
    const playable = (x: RecItem) => canPlayHere(x.playback);
    const rest = shuffle ? activeItems.filter((x) => x.track.key !== playingKey && !heardRef.current.has(x.track.key) && !hidden.has(x.track.key)) : activeItems.slice(i + 1).filter(x => !hidden.has(x.track.key));
    const ordered = nextKey ? [...rest.filter((x) => x.track.key === nextKey), ...rest.filter((x) => x.track.key !== nextKey)] : rest;
    return ordered
      .filter(x => playable(x) && (!ready || ready(x.track)))
      .slice(0, 4)
      .map((x) => ({ key: x.track.key, title: x.track.title, artist: artistOf(x.track), artwork: x.track.artwork, preview: x.playback.preview, track: x.track }));
  }, [activeItems, inQueue, playingKey, shuffle, hidden, nextKey, readySignature]);
  // The four visible Up Next rows are NOT the download queue. Prepare every entry, even before Play.
  const cacheTracks = useMemo(() => preparationTracks(playing?.track ?? null, upNext.flatMap(x => x.track ? [x.track] : []),
    activeItems.filter(x => !hidden.has(x.track.key)).map(x => x.track),
    [...visibleSeeds, ...items.filter(x => !hidden.has(x.track.key)).map(x => x.track)],
    tab === 'saved' ? savedTracks(saved, lists, visibleSavedList) : []),
    [playing, upNext, activeItems, hidden, visibleSeeds, items, tab, saved, lists, visibleSavedList]);
  // Just the songs this screen is showing. cacheTracks is the union across tabs and the player,
  // so using it here would count songs the listener cannot see in the bar's denominator.
  const queueTracks = useMemo(() => [...visibleSeeds, ...items.filter((x) => !hidden.has(x.track.key)).map((x) => x.track)],
    [visibleSeeds, items, hidden]);
  const keptKeys = useKeptKeys(cacheTracks);
  const cardCache = useCardCache(cacheTracks, keptKeys);

  // MEDIA-NATIVE-001: mirror the player onto the Android native MediaSession / Android Auto. Every
  // call is a no-op outside the Android app, so these run unconditionally but only act in the shell.
  // App owns the list, queue and navigation; Player (below) owns play/pause, the playhead and seek.
  const nativeReady = (t: Track) => (ready ? ready(t) : false);
  /** The ready song as the native side needs it, including the exact file the native engine plays. */
  const nativeSong = (t: Track) => { const r = nativeReady(t); return songFromTrack(t, r, r ? queueAudio.readyUrl(t) : null); };
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    setMediaHandlers({
      next: goNext,
      prev: goPrev,
      playIndex: (i) => { const it = activeItems[i]; if (it) play(it, { keepList: true }); },
      playId: (id) => {
        const scoped = decodePlaylistMediaId(id);
        if (scoped) {
          const list = lists.find((l) => l.id === scoped.listId);
          const track = list && savedTracks(saved, lists, list.id).find((t) => t.key === scoped.key);
          if (!track) return; // A stale/forged car id must not play an unrelated song.
          playingListRef.current = list.id;
          setPlayingContext(list.id);
          heardRef.current = new Set([track.key]);
          historyRef.current = [track.key];
          const row = playbackRows([track])[0];
          if (row) play(row, { keepList: true });
          return;
        }
        const inActive = activeItems.find((x) => x.track.key === id);
        if (inActive) { play(inActive, { keepList: true }); return; }
        const fromList = lists.flatMap((l) => savedTracks(saved, lists, l.id)).find((t) => t.key === id);
        const t = fromList ?? (saved ?? []).map((s) => s.track).find((x) => x.key === id) ?? carCatalog.find(id);
        const row = t ? playbackRows([t])[0] : undefined;
        if (row) play(row, { keepList: true });
      },
      catalogSearch: query => carCatalog.search(query),
      search: (q) => {
        const ql = q.trim().toLowerCase();
        if (!ql) return;
        const pool = [...activeItems.map((x) => x.track), ...lists.flatMap((l) => savedTracks(saved, lists, l.id))];
        const hit = pool.find((t) => `${t.title} ${artistOf(t)}`.toLowerCase().includes(ql));
        if (!hit) return;
        const row = activeItems.find((x) => x.track.key === hit.key) ?? playbackRows([hit])[0];
        if (row) play(row, { keepList: true });
      },
      shuffle: (on) => { if (on !== shuffle) toggleShuffle(); },
      repeat: (mode) => {
        const target: RepeatMode = mode === 1 ? 'one' : mode === 2 ? 'all' : 'off';
        setRepeat(() => { writeFlag(REPEAT_KEY, target); return target; });
      },
    });
  });
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    const idx = Math.max(0, activeItems.findIndex((x) => x.track.key === playingKey));
    pushMediaState({
      hasTrack: Boolean(playing),
      mediaId: playing?.track.key ?? null,
      title: playing?.track.title ?? 'Airwave Discovery',
      artist: playing ? artistOf(playing.track) : '',
      album: playing?.track.album ?? null,
      artwork: playing?.track.artwork ?? null,
      durationMs: playing?.track.duration ? Math.round(playing.track.duration * 1000) : -1,
      canNext: Boolean(nextStep),
      canPrev: Boolean(prevStep),
      shuffle,
      repeat: repeat === 'one' ? 1 : repeat === 'all' ? 2 : 0,
      queue: activeItems.map((x) => nativeSong(x.track)),
      queueIndex: idx,
    });
  }, [playing, activeItems, playingKey, Boolean(nextStep), Boolean(prevStep), shuffle, repeat, readySignature]);
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    pushMediaLibrary(
      activeItems.map((x) => nativeSong(x.track)),
      lists.map((l) => ({ id: l.id, title: l.name, songs: savedTracks(saved, lists, l.id).map((t) => nativeSong(t)) })),
    );
  }, [activeItems, lists, saved, readySignature]);

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
          // When the song was started from a saved list, the engine applies that list's stricter
          // rule instead of the queue's: nothing new until everything in the list has been played.
          .recommend({ event_id: eventId, exclude: [...playedRef.current], list_id: playingListRef.current ?? undefined })
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
    if (it && canPlayHere(it.playback)) play(it);
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
    // The lists are needed on Discover too, for the menu the like button opens.
    if (tab === 'saved' || tab === 'discover') api.playlists().then((r) => setLists(r.lists), () => setLists([]));
  }, [tab, flags]);

  /**
   * Like or unlike a song that is not in a recommendation row — from the search list, say
   * (SEARCH-LIKE-001). Same engine call as the song list's like, so the algorithm learns the same.
   */
  const likeTrack = (track: Track, like: boolean) => {
    setFlags((f) => ({ ...f, [track.key]: { ...(f[track.key] ?? {}), like, ...(like ? { dislike: false } : {}) } }));
    api
      .feedback(like ? 'like' : 'unlike', track, { event_id: newEventId(like ? 'like' : 'unlike', track.key) })
      .then(() => void refreshTaste(), (e: Error) => flash(`Could not save that: ${e.message}`));
  };

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
              <Search
                seeds={seeds}
                onAdd={onAdd}
                onPreview={previewTrack}
                onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
                onLike={likeTrack}
                onRemoveSeed={(t) => saveSeeds(seeds.filter((s) => s.key !== t.key))}
                lists={lists}
                onLists={setLists}
              />
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
                  <Glyph name="info" size={14} /> Your last now playing queue, from {new Date(result.saved_at * 1000).toLocaleString()}. Press “Find my next favorite” for a fresh one.
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
                      Now playing queue <span className="count">{visibleSeeds.length + items.length}</span>
                    </h2>
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
                    {!sample && (
                      /* LIST-METER-003: one group, so the two actions stay side by side. Loose
                         siblings wrapped onto separate lines, because .push takes margin-left:auto. */
                      <div className="queue__actions">
                        <ListDownloadButton tracks={queueTracks} label="now playing queue" />
                        {/* CLEAR-ICON-001: the same icon-button shape as the download action beside it, so the
                            pair reads as one set of list controls rather than two unrelated widgets. */}
                        <button className="iconbtn" type="button" aria-label="Clear now playing queue" title="Clear now playing queue. Your listening history and settings are kept." onClick={clearList}>
                          <Glyph name="clear" size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                  {tasteLine && (
                    <p className="note note--taste" role="status" aria-live="polite">
                      <Glyph name="info" size={12} /> {tasteLine}
                    </p>
                  )}
                  {(result.count - (result.items ?? []).filter(x => expired.has(x.track.key)).length) < result.asked && !sample && (
                    <p className="note">
                      Found {result.count - (result.items ?? []).filter(x => expired.has(x.track.key)).length} songs worth suggesting{result.empty_reason ? ` — ${result.empty_reason}` : '.'} Airwave does not pad the list.
                    </p>
                  )}
                  {/* SRC-WARN-001: a quiet provider is a status detail, not news for the listener.
                      It is reported in Settings, next to the other runtime checks. */}
                  {items.length || visibleSeeds.length ? (
                    <>
                    <ListDownloadBar tracks={queueTracks} label="now playing queue" />
                    <Results
                      seeds={visibleSeeds}
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
                      cacheOf={cardCache}
                      lists={lists}
                      onLists={setLists}
                    />
                    </>
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
              ) : visibleSeeds.length ? (
                <>
                  <div className="queue__head">
                    <h2 id="queue-h">
                      Now playing queue <span className="count">{visibleSeeds.length}</span>
                    </h2>
                    {/* LIST-METER-003: same pairing on the seeds-only header. */}
                    <div className="queue__actions">
                      <ListDownloadButton tracks={queueTracks} label="now playing queue" />
                      {/* CLEAR-ICON-001: matches the download icon beside it. */}
                      <button className="iconbtn" type="button" aria-label="Clear now playing queue" title="Clear now playing queue. Your listening history and settings are kept." onClick={clearList}>
                        <Glyph name="clear" size={14} />
                      </button>
                    </div>
                  </div>
                  <Results
                    seeds={visibleSeeds}
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
                    cacheOf={cardCache}
                  />
                  <p className="queue__foot">Press “Find my next favorite” to add songs to your now playing queue.</p>
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
          <SavedView
            saved={saved}
            lists={lists}
            onLists={setLists}
            onVisibleList={setVisibleSavedList}
            onPreview={(t, listId) => {
              // Remember which list this play came from, so a finished song is judged by that
              // list's rule rather than the discovery queue's.
              playingListRef.current = listId ?? null;
              setPlayingContext(listId ?? 'all');
              heardRef.current = new Set([t.key]);
              historyRef.current = [t.key];
              previewTrack(t);
            }}
            onRemoveSaved={removeSaved}
            onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
            cacheOf={cardCache}
          />
        )}

        {tab === 'profile' && <ProfileView />}

        {tab === 'downloads' && <DownloadsView d={dls} />}

        {tab === 'settings' && (
          <SettingsView
            settings={settings}
            sources={Object.fromEntries(srcEntries)}
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
              // RESET-APP-001: everything back to default means the downloaded songs too, so the
              // app is as it shipped. `clear_cache` empties the engine's own store; the shell's
              // audio cache is a separate place and has to be told as well. Songs kept in the
              // Music folder are the owner's and are never removed.
              api.reset(true).then(async () => {
                setSeeds([]);
                setFlags({});
                setHidden(new Set());
                setResult(null);
                let songs = 0;
                try {
                  if (downloadsAvailable()) songs = (await dl.cacheClear()).removed;
                } catch {
                  // A shell that cannot clear its cache must not strand the rest of the reset.
                }
                api.settings().then(setSettings, () => undefined);
                flash(songs > 0
                  ? `Reset to defaults. Now playing queue, starting songs, feedback, settings and ${songs} downloaded songs cleared. Songs kept in your Music folder stay.`
                  : 'Reset to defaults. Your now playing queue, starting songs, feedback and settings are cleared.');
              })
            }
          />
        )}
      </main>

      <aside className="rail" aria-label="Player">
        <QueuePreparation tracks={cacheTracks} parallel={settings?.dl_parallel ?? 0}
          preload={{ target: settings?.preload_target ?? 'all', count: settings?.preload_count ?? 20 }} />
        <Player
          playing={playing}
          upNext={upNext}
          docked={docked}
          canPrev={Boolean(prevStep)}
          canNext={Boolean(nextStep)}
          shuffle={shuffle}
          repeat={repeat}
          cacheGb={settings?.cache_gb ?? 1}
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
            const it = activeItems.find((x) => x.track.key === k);
            if (it) play(it, { keepList: true });
          }}
        />
      </aside>
    </div>
  );
}
