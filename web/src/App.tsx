import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CardCacheContext } from './card-cache-context';
import { Radio } from './Radio';
import { RadioPlayer } from './RadioPlayer';
import { radioSession } from './engine/radio-client';
import type { RadioStation } from './engine/radio';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { api, type Characteristics, type PlaylistMix, newEventId, type FeedbackKind, type JobStatus, type Playback, type PlaylistSummary, type RecItem, type RecResult, type SavedItem, type Settings, type TasteSummary, type Track } from './api';
import { Art } from './Art';
import { CustomDiscovery, type CustomStatus } from './CustomDiscovery';
import type { CustomCriteria } from './engine/custom-discovery';
import { Player, type ListenTelemetry, type Playing } from './Player';
import { Results, rowId, type FeedbackFlags } from './Results';
import { useDownloads } from './Downloads';
import { Search } from './Search';
import { AlbumView, albumTargetKey, type AlbumTarget } from './Albums';
import { ArtistView, artistTargetKey, type ArtistTarget } from './Artists';
import { SoundCard } from './SoundCard';
import { listMixNote } from './list-mix-note';
import { ProfileView } from './Profile';
import { SavedView } from './SavedView';
import { QueuePreparation } from './QueuePreparation';
import { ListDownloadBar, ListDownloadButton, ListFolderButton } from './ListDownloadBar';
import { useCardCache } from './useCardCache';
import { useKeptKeys } from './useKeptKeys';
import { useQueueGenres } from './useQueueGenres';
import { savedTracks, playbackRows, preparationTracks, contextRows, addTargetOf, addedRow, insertAfter, SEARCH_CONTEXT } from './engine/queue-context';
import { runCarSimilar } from './engine/car-similar';
import { captureRows, moodMovable, placeMood, playMoodMove } from './engine/mood-apply';
import { phoneWait } from './engine/native-http';
import { PHONE_LIST, decodeCarAlbumId, decodePlaylistMediaId, mediaNativeAvailable, pickCarContext, pushMediaLibrary, pushMediaState, pushMediaTracks, setMediaHandlers, songFromTrack } from './engine/media-native';
import { engineAvailable, engineSend, listenFromEvent, markEngineEvent, subscribeEngineState } from './engine/native-engine';
import { applyCarSettings, discoveryForEngine } from './engine/car-settings';
import { SettingsView } from './Settings';
import { markSavedSettingsApplied, setEqConfig, setLocalMix, setMixSlider, setPlayThrough } from './audio-engine';
import { PLAY_THROUGH_DEFAULT } from './engine/crossfade';
import { dl, downloadsAvailable } from './engine/downloads';
import { readResume } from './engine/resume';
import { PROVIDER_LABEL, QUEUE_SIZE_MAX, QUEUE_SIZE_MIN, addSeed, artistOf, canPlayHere, classNames, describeTaste, dropExpired, expiredKeysOf, fmtBytes, LIST_LOOK_MS, keepFocus, historyBack, listStart, mergeRerank, nextRepeat, playbackOfTrack, readyFilter, settledWithin, similarSummary, stepQueue, type RepeatMode } from './util';
import { queueAudio } from './engine/queue-audio';
import { CarCatalog } from './engine/car-catalog';
import { BrandLogo } from './BrandLogo';
import { GearGlyph } from './GearGlyph';
import { moodTint, type MoodLead } from './brand-tint';

type Tab = 'discover' | 'radio' | 'saved' | 'profile' | 'settings';

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

/** ARTIST-PAGE-001: what can open over a tab. */
type DetailPage = { kind: 'album'; target: AlbumTarget } | { kind: 'artist'; target: ArtistTarget };
/** Pages kept for Back; going deeper than this forgets the oldest. */
const MAX_PAGES = 12;

export function App() {
  const [tab, setTab] = useState<Tab>('discover');
  const tabRef = useRef<Tab>('discover');
  tabRef.current = tab;
  // ALBUM-OPEN-001: an album open over the tab it was opened from; the tab's own view stays mounted
  // (hidden) so its search, results and scroll come back unchanged with Back.
  // ARTIST-PAGE-001: artist and album pages open from each other, so they stack; Back returns to the
  // page before, with its scroll and the button that opened the next one focused again.
  const [pages, setPages] = useState<{ page: DetailPage; tab: Tab; scroll: number; opener: HTMLElement | null }[]>([]);
  const top = pages.length ? pages[pages.length - 1]! : null;
  const albumOpen = top !== null && top.tab === tab;
  const openPage = (page: DetailPage) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPages((p) => [...p.filter((x) => x.tab === tab), { page, tab, scroll: window.scrollY, opener }].slice(-MAX_PAGES));
    window.scrollTo?.({ top: 0 });
  };
  const openAlbum = (target: AlbumTarget) => openPage({ kind: 'album', target });
  const openArtist = (target: ArtistTarget) => openPage({ kind: 'artist', target });
  const closeAlbum = () => {
    const y = top?.scroll ?? 0;
    const opener = top?.opener ?? null;
    setPages((p) => p.slice(0, -1));
    requestAnimationFrame(() => {
      window.scrollTo?.({ top: y });
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  };
  const [seeds, setSeeds] = useState<Track[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);
  const [similarStatus, setSimilarStatus] = useState('');
  const setSimilarStatusState = setSimilarStatus;
  const similarRef = useRef(false);
  // NEXT-FAV-CUSTOM-001: Customize discovery.
  const [customOpen, setCustomOpen] = useState(false);
  const [customStatus, setCustomStatus] = useState<CustomStatus>({ running: false, text: '' });
  const customJob = useRef<string | null>(null);
  const [result, setResult] = useState<RecResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const radioStation = useSyncExternalStore(radioSession.subscribe, () => radioSession.get().station);
  useEffect(() => { void radioSession.restore(); }, []);
  const tune = (s: RadioStation) => {
    startTokenRef.current++;
    engineSend({ op: 'pause' });
    setPlaying(null);
    void radioSession.start(s);
  };
  const [flags, setFlags] = useState<Record<string, FeedbackFlags>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [shuffle, setShuffle] = useState(() => readFlag(SHUFFLE_KEY) === 'on');
  const [repeat, setRepeat] = useState<RepeatMode>(() => {
    const v = readFlag(REPEAT_KEY);
    return v === 'once' || v === 'twice' || v === 'one' ? v : 'off';
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
  /** SEARCH-QUEUE-001: the result list a search play came from. Held here, so it outlives the search box. */
  const [searchList, setSearchList] = useState<Track[]>([]);
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
  // MOOD-QUEUE-001: the listening mood's last order of the songs still to come, and its animation.
  const moodSeq = useRef(0);
  const moodOrderRef = useRef<string[]>([]);
  const moodPreferRef = useRef<Map<string, number> | null>(null);
  // ALBUM-NO-X-001 (owner, 2026-11-19): "When listening to an album get rid of the X button." Set while the
  // songs playing come from an album (its page or a saved album); the player then has no Dislike.
  const [albumPlaying, setAlbumPlaying] = useState(false);
  // MOOD-SHUFFLE-001: how well each song fits the mood; shuffle's next pick is weighted by it.
  const [moodFitState, setMoodFitState] = useState<{ fit: Map<string, number>; confidence: number } | null>(null);
  const moodBefore = useRef<Map<string, number>>(new Map());
  const [moodTrigger, setMoodTrigger] = useState(0);
  const [moodPulse, setMoodPulse] = useState<{ tick: number; leading: string[]; moved: string[]; at: number } | null>(null);
  const nudgeMood = () => setMoodTrigger((n) => n + 1);
  // JPLAY-BRAND-001: the listening mood's leading genres, for the logo's colour.
  const [moodLead, setMoodLead] = useState<MoodLead | null>(null);
  // One id per app session: groups this sitting's events for the session taste horizon.
  const sessionRef = useRef(`s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const [taste, setTaste] = useState<TasteSummary | null>(null);
  // PLAYLIST-QUEUE-001: the saved list now in the now playing queue, and whether the queue it replaced can come back.
  const [queueList, setQueueList] = useState<{ id: string; name: string } | null>(null);
  const [canRestore, setCanRestore] = useState(false);
  // PLAYLIST-MIX-001: that list's own listening mix.
  const [listMix, setListMix] = useState<PlaylistMix | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const [carCatalog] = useState(() => new CarCatalog(
    api.search, track => queueAudio.isReady(track), api.searchLyrics, api.searchAlbums, (id) => api.album({ id }),
    // CAR-SEARCH-TYPES-001: the car's Identify icon uses the phone's own fingerprinting.
    (signature, ms) => api.identifyAudio(signature, ms), () => import('./engine/listen'),
  ));

  // ---------------------------------------------------------------- load persisted state
  useEffect(() => {
    Promise.all([api.seeds(), api.settings(), api.feedbackState()])
      .then(([s, st, fb]) => {
        setSeeds(s.seeds);
        setQueueList(s.playlist ?? null);
        setCanRestore(Boolean(s.can_restore));
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
    markSavedSettingsApplied(); // EQ-RESTORE-001: from here the engine may be told this page's sound settings
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

  /**
   * NEXT-FAV-CUSTOM-001: find songs for the listener's own criteria and add them to the end of Now playing. Songs
   * already listed or removed are never added again.
   */
  const runCustom = async (criteria: CustomCriteria) => {
    if (customJob.current) return;
    if (jobRef.current && !job?.done) void api.cancelJob(jobRef.current).catch(() => undefined);
    jobRef.current = null;
    setCustomStatus({ running: true, text: 'Starting\u2026' });
    try {
      const exclude = [...(result?.items ?? []).map((x) => x.track.key), ...hidden];
      const { job: id } = await api.discoverCustom(criteria, exclude);
      customJob.current = id;
      for (;;) {
        const status = await api.job(id);
        if (customJob.current !== id) return;
        if (status.done) {
          if (status.error === 'cancelled') { setCustomStatus({ running: false, text: 'Stopped. Nothing was added.' }); break; }
          if (status.error) throw new Error(status.error);
          const out = status.result as unknown as { added: number; reason?: string; queue?: RecResult | null } | null;
          if (out?.queue && out.added > 0) setResult(out.queue);
          const added = out?.added ?? 0;
          setCustomStatus({ running: false, text: added > 0
            ? `Added ${added} ${added === 1 ? 'song' : 'songs'} to Now playing.${out?.reason ? ` ${out.reason}` : ''}`
            : out?.reason || 'No matching songs found. Try fewer genre restrictions or more artist sources.' });
          break;
        }
        setCustomStatus({ running: true, text: `${status.progress || 'Finding songs'}\u2026` });
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      setCustomStatus({ running: false, text: `Could not finish: ${(e as Error).message}` });
    } finally {
      customJob.current = null;
      nudgeMood();
    }
  };
  const stopCustom = () => {
    const id = customJob.current;
    if (id) void api.cancelJob(id).catch(() => undefined);
  };

  /** SIMILAR-SOUND-001: the selected song itself, not a general taste seed. Its job is distinct
   * from discovery's progressive job: only the final, audio-verified additions update the queue. */
  /** Returns what it found (or why not), for a caller that is not showing the queue's status line. */
  const findSimilar = async (track: Track): Promise<string | null> => {
    if (similarRef.current) return null;
    let said = '';
    const setSimilarStatus = (m: string) => { said = m; setSimilarStatusState(m); };
    similarRef.current = true; setSimilarBusy(true); setSimilarStatus(`Looking for songs that sound like “${track.title}” on all services…`);
    try {
      if (jobRef.current && !job?.done) void api.cancelJob(jobRef.current).catch(() => undefined);
      // Stop the old progressive result from replacing this queue after the new request starts.
      jobRef.current = null;
      const { job: id } = await api.similar(track);
      for (;;) {
        const status = await api.job(id);
        if (status.done) {
          if (status.error) throw new Error(status.error);
          const out = status.result as unknown as { added: number; reached?: number; below?: number; unmeasured?: number; minimum: number; queue?: RecResult; reason?: string } | null;
          if (!out) throw new Error('The sound comparison did not return a result.');
          if (out.queue && out.added > 0) {
            setResult(out.queue);
            setSimilarStatus(similarSummary(out, track.title));
          } else setSimilarStatus(out.reason || `No new songs reached ${out.minimum}% sound match. The list is unchanged.`);
          break;
        }
        setSimilarStatus(status.progress || 'Comparing the sound…');
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) { setSimilarStatus(`Could not find similar songs: ${(e as Error).message}`); }
    finally { similarRef.current = false; setSimilarBusy(false); nudgeMood(); }
    return said;
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
        setQueueList(null);
        setCanRestore(false);
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

  /**
   * PLAYLIST-QUEUE-001: a saved list takes the place of the now playing queue. Its songs become the
   * starting songs, the first one plays, and discovery runs from all of them.
   */
  const useListAsQueue = (id: string) => {
    jobRef.current = null;
    api.queuePlaylist(id).then(
      (r) => {
        setSeeds(r.seeds);
        setQueueList(r.playlist ?? null);
        setCanRestore(Boolean(r.can_restore));
        setResult(null);
        setJob(null);
        setRunErr(null);
        setHidden(new Set());
        setFocusKey(null);
        setTab('discover');
        // SHUFFLE-START-001: shuffled, the list opens on a song already held in full.
        startList(r.seeds, (first) => play(playbackRows([first])[0]!, { newRound: true }));
        const name = r.playlist?.name ?? 'The list';
        flash(`“${name}” is your now playing queue: ${r.seeds.length} starting ${r.seeds.length === 1 ? 'song' : 'songs'}. Finding new music from ${r.seeds.length === 1 ? 'it' : 'them'}…${r.missing ? ` ${r.missing} could not be looked up.` : ''}`);
        void run(true);
      },
      (e: Error) => flash(e.message),
    );
  };

  /** Bring back the now playing queue a saved list replaced. */
  const restoreQueue = () => {
    jobRef.current = null;
    api.restoreQueue().then(
      (r) => {
        setSeeds(r.seeds);
        setQueueList(null);
        setCanRestore(false);
        setListMix(null);
        setJob(null);
        setHidden(new Set());
        setResult(null);
        api.last().then((x) => setResult((prev) => prev ?? x), () => undefined);
        flash('Your earlier now playing queue is back.');
      },
      (e: Error) => flash(e.message),
    );
  };

  // The list's mix, again whenever its songs change or a run has learned more of their genres.
  useEffect(() => {
    if (!queueList) return;
    let live = true;
    api.playlistMix(queueList.id).then((m) => live && setListMix(m), () => live && setListMix(null));
    return () => {
      live = false;
    };
  }, [queueList, lists, job?.done]);

  // Only the mix of the list now in the queue, never a stale one from the list before it.
  const shownMix = queueList && listMix?.id === queueList.id ? listMix : null;

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
  // SHUFFLE-ROUND-001: row taps and refreshes within one list must not erase its heard set.
  // A genuinely different playback context starts its own round and navigation history.
  const enterPlayingContext = (context: string | null) => {
    if (context !== playingContext) {
      heardRef.current = new Set();
      historyRef.current = [];
    }
    setPlayingContext(context);
  };
  /** SHUFFLE-START-001: bumped by every play, so a list start still looking gives way to it. */
  const startTokenRef = useRef(0);
  const cancelFiniteFor = (key: string) => {
    if (playing?.track.key !== key && (repeat === 'once' || repeat === 'twice')) {
      writeFlag(REPEAT_KEY, 'off'); setRepeat('off');
    }
  };
  const play = (it: RecItem, o?: { newRound?: boolean; back?: boolean; keepList?: boolean }) => {
    if (it.track.provider === 'radio' && it.track.radio_station) { tune(it.track.radio_station); return; }
    if (radioSession.get().station) { void radioSession.stop().then(() => play(it, o)); return; }
    startTokenRef.current++;
    cancelFiniteFor(it.track.key);
    // Playing from the queue leaves any saved list behind, so the queue's own rule applies again.
    if (!o?.keepList) { playingListRef.current = null; enterPlayingContext(null); setAlbumPlaying(false); }
    playedRef.current.add(it.track.key);
    if (o?.newRound) heardRef.current = new Set();
    heardRef.current.add(it.track.key);
    if (!o?.back) historyRef.current = [...historyRef.current.slice(-199), it.track.key];
    setPlaying({ track: it.track, playback: it.playback });
    setFocusKey(it.track.key);
  };
  const previewTrack = (t: Track) => {
    if (t.provider === 'radio' && t.radio_station) { tune(t.radio_station); return; }
    if (radioSession.get().station) { void radioSession.stop().then(() => previewTrack(t)); return; }
    startTokenRef.current++; cancelFiniteFor(t.key); setPlaying({ track: t, playback: playbackOfTrack(t) });
  };
  /** A radio song or artist name was clicked: leave the live stream and play the real catalogue song. */
  const playFromRadio = (t: Track) => {
    const go = () => playFromSearch(t, [t]);
    if (radioSession.get().station) { void radioSession.stop().then(go); } else { go(); }
  };
  /** SEARCH-QUEUE-001: a song played from a search list, with that list as what the skip buttons walk. */
  const playFromSearch = (t: Track, list: Track[], o?: { album?: boolean }) => {
    playingListRef.current = null;
    setAlbumPlaying(Boolean(o?.album));
    setSearchList(list.length ? list : [t]);
    enterPlayingContext(SEARCH_CONTEXT);
    heardRef.current.add(t.key);
    historyRef.current = [...historyRef.current.slice(-199), t.key];
    previewTrack(t);
  };
  /** A song played from the Saved view; `listId` is the list it came from, so that list's rule judges it. */
  const playFromSaved = (t: Track, listId?: string) => {
    playingListRef.current = listId ?? null;
    setAlbumPlaying(Boolean(listId && lists.find((l) => l.id === listId)?.album));
    enterPlayingContext(listId ?? 'all');
    heardRef.current.add(t.key);
    historyRef.current = [...historyRef.current.slice(-199), t.key];
    previewTrack(t);
  };
  /**
   * SHUFFLE-START-001: start a whole list. Shuffled, it opens on a song already held in full. A list
   * the app has not examined reads as "nothing held" (or as holding only the song it happens to be
   * playing), so it first asks what is held: file checks only, nothing when every song has been
   * examined already, and bounded by LIST_LOOK_MS. Anything the listener plays meanwhile wins.
   */
  const startList = (list: readonly Track[], go: (t: Track) => void) => {
    const ready = readyFilter(queueAudio, downloadsAvailable());
    const token = ++startTokenRef.current;
    const begin = () => {
      if (token !== startTokenRef.current) return;
      const t = listStart(list, { shuffle, ready });
      if (t) go(t);
    };
    const look = (queueAudio as { look?: (tracks: readonly Track[]) => Promise<unknown> }).look;
    if (!shuffle || !ready || !list.length || typeof look !== 'function') return begin();
    void settledWithin(Promise.resolve().then(() => look.call(queueAudio, list)), LIST_LOOK_MS).then(begin);
  };
  const playAll = (list: Track[]) => startList(list, (t) => playFromSearch(t, list));
  const playAlbum = (list: Track[]) => startList(list, (t) => playFromSearch(t, list, { album: true }));
  const playAllSaved = (list: Track[], listId: string) => startList(list, (t) => playFromSaved(t, listId));
  // PLAYLIST-QUEUE-001: with a saved list in the now playing queue, its songs play first, in the list's
  // order, then the songs discovered from them. Otherwise the queue is the discovered songs, as before.
  const queueRows = useMemo(() => {
    if (!queueList) return items;
    const own = new Set(visibleSeeds.map((t) => t.key));
    return [...playbackRows(visibleSeeds), ...items.filter((x) => !own.has(x.track.key))];
  }, [queueList, items, visibleSeeds]);
  // The rows the skip buttons walk: the queue, the saved list played from, or the search results.
  const activeItems = useMemo(() => contextRows(playingContext, { queueRows, search: searchList, saved, lists }), [queueRows, playingContext, searchList, saved, lists]);
  // JPLAY-BRAND-001: the logo takes the listening mood's colour (else the song playing's).
  const ownPlayingChars = activeItems.find((x) => x.track.key === playing?.track.key)?.characteristics ?? playing?.track.characteristics ?? null;
  // A song played from search results carries no genres: ask the engine (as the rows' bubbles do).
  const [askedChars, setAskedChars] = useState<{ key: string; c: Characteristics } | null>(null);
  useEffect(() => {
    const t = playing?.track;
    if (!t || ownPlayingChars || askedChars?.key === t.key) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const ask = () => {
      api.genres([t]).then((r) => {
        if (!live) return;
        const c = r.items?.[t.key] ?? null;
        if (c) setAskedChars({ key: t.key, c });
        else if (r.pending?.includes(t.key) && ++tries < 6) timer = setTimeout(ask, 3000);
      }, () => undefined);
    };
    ask();
    return () => { live = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing?.track.key, Boolean(ownPlayingChars)]);
  const playingChars = ownPlayingChars ?? (askedChars?.key === playing?.track.key ? askedChars?.c : null) ?? null;
  const logoTint = moodTint(moodLead, playingChars);
  const playingKey = playing?.track.key ?? null;
  /**
   * MOOD-QUEUE-001 (owner, 2026-11-19): the now playing queue follows the listening mood. It never
   * applies to an album or saved list played in order (only with shuffle on), nor to search results.
   */
  const moodOn = settings?.mood_queue !== false && !result?.sample;
  const moodQueueScope = moodOn && playingContext === null && (!queueList || shuffle);
  const moodListScope = moodOn && playingContext !== null && playingContext !== SEARCH_CONTEXT && shuffle;
  /** A re-rank answer keeps the songs the mood had placed where they were until the mood answers again. */
  const keepMood = (xs: RecItem[]): RecItem[] => {
    if (!moodQueueScope || !moodOrderRef.current.length) return xs;
    const movable = new Set(moodMovable(xs, { currentKey: playingKey, played: playedRef.current, hidden }).map((x) => x.track.key));
    return placeMood(xs, moodOrderRef.current.filter((k) => movable.has(k)));
  };
  useEffect(() => {
    if (!moodQueueScope && !moodListScope) { moodPreferRef.current = null; moodOrderRef.current = []; setMoodFitState(null); return; }
    const rows = moodQueueScope ? (result?.items ?? []) : activeItems;
    const movable = moodMovable(rows, { currentKey: playingKey, played: playedRef.current, hidden });
    if (movable.length < 2) return;
    const seq = ++moodSeq.current;
    const keys = movable.map((x) => x.track.key);
    const shownNow = moodOrderRef.current.filter((k) => keys.includes(k));
    const timer = window.setTimeout(() => {
      const cur = playing ? { track: playing.track, characteristics: rows.find((x) => x.track.key === playingKey)?.characteristics ?? null } : undefined;
      // Every song the shuffle may pick from is scored too (hand-added ones, a list's songs), never moved.
      const score = activeItems.filter((x) => !keys.includes(x.track.key) && x.track.key !== playingKey && !hidden.has(x.track.key)).slice(0, 400)
        .map((x) => ({ track: x.track, characteristics: x.characteristics ?? null }));
      api.mood({ upcoming: movable.map((x) => ({ track: x.track, characteristics: x.characteristics ?? null })), score, shown: shownNow.length ? shownNow : keys, current: cur })
        .then((plan) => {
          if (seq !== moodSeq.current || plan.off) return;
          setMoodLead({ leading: plan.leading ?? [], confidence: plan.confidence ?? 0 });
          moodPreferRef.current = new Map(plan.order.map((k, i) => [k, i] as const));
          if (plan.fit) setMoodFitState({ fit: new Map(Object.entries(plan.fit)), confidence: plan.confidence ?? 0 });
          if (!moodQueueScope) return;
          moodOrderRef.current = plan.order;
          if (!plan.changed) return;
          moodBefore.current = captureRows(document);
          setResult((prev) => (prev && !prev.sample ? { ...prev, items: placeMood(prev.items, plan.order) } : prev));
          setMoodPulse((p) => ({ tick: (p?.tick ?? 0) + 1, leading: plan.leading, moved: plan.moved, at: Date.now() }));
        }, () => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moodTrigger, playingKey, moodQueueScope, moodListScope, settings?.adventurous]);
  // The moved rows slide from their old places (FLIP); with reduced motion they are only marked.
  useLayoutEffect(() => {
    if (!moodPulse) return;
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    playMoodMove(document, moodBefore.current, new Set(moodPulse.moved.map(rowId)), reduced);
  }, [moodPulse?.tick]);
  const [moodNoteOn, setMoodNoteOn] = useState(false);
  useEffect(() => {
    if (!moodPulse) return;
    setMoodNoteOn(true);
    const t = window.setTimeout(() => setMoodNoteOn(false), 4500);
    return () => window.clearTimeout(t);
  }, [moodPulse?.tick]);
  const playingLiked = Boolean(playingKey && flags[playingKey]?.like);
  const playingDisliked = Boolean(playingKey && flags[playingKey]?.dislike);
  const inQueue = playingKey != null && activeItems.some((x) => x.track.key === playingKey);
  const ready = readyFilter(queueAudio, downloadsAvailable());
  const readySignature = useMemo(() => ready ? activeItems.filter(x => ready(x.track)).map(x => x.track.key).join('\0') : '', [activeItems, cacheRevision]);
  // SEARCH-QUEUE-001: sequential search Next may fetch its selected full song. Shuffle, however,
  // must obey local readiness even in a search list (SHUFFLE-ROUND-001).
  const stepReady = playingContext === SEARCH_CONTEXT && !shuffle ? undefined : ready;
  // MOOD-QUEUE-001: with shuffle on, the next song is picked from the few that fit the mood best.
  const moodShuffle = moodOn && shuffle && moodFitState ? { fit: moodFitState.fit, confidence: moodFitState.confidence, adventurous: settings?.adventurous ?? 0.5 } : null;
  const queueOpts = { shuffle, repeat, heard: heardRef.current, ready: stepReady, mood: moodShuffle, prefer: moodOn && shuffle && !moodShuffle ? moodPreferRef.current ?? undefined : undefined };
  const nextStep = stepQueue(activeItems, inQueue ? playingKey : null, 1, hidden, queueOpts);
  const back = shuffle ? historyBack(historyRef.current, playingKey, stepReady ? activeItems.filter(x => stepReady(x.track)) : activeItems, hidden) : null;
  const prevStep = shuffle ? (back ? { item: back.item, wrapped: false } : null) : inQueue ? stepQueue(activeItems, playingKey, -1, hidden, queueOpts) : null;
  const goNext = () => {
    // Recheck the shell's current local-file answer at the moment of transition: eviction can
    // happen after Up Next was rendered. A stale pick must never become a spinner or preview.
    const live = stepQueue(activeItems, inQueue ? playingKey : null, 1, hidden, queueOpts);
    if (live && (!stepReady || stepReady(live.item.track))) play(live.item, { newRound: live.wrapped, keepList: true });
  };
  const goPrev = () => {
    if (!prevStep || (stepReady && !stepReady(prevStep.item.track))) return;
    if (back) historyRef.current = historyRef.current.slice(0, back.keep);
    play(prevStep.item, { back: Boolean(back), keepList: true });
  };
  const toggleShuffle = () =>
    setShuffle((s) => {
      const on = !s;
      writeFlag(SHUFFLE_KEY, on ? 'on' : 'off');
      // Toggling shuffle is not permission to replay songs while unheard ones remain.
      if (playingKey) heardRef.current.add(playingKey);
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
  /**
   * QUEUE-ADD-001: the search row's add button puts a song into what the listener is listening to: the
   * saved list being played from, the saved list in the queue (whose songs are starting songs, so the
   * added one is too), or the now playing queue, where it goes right after the song playing.
   */
  const addTarget = addTargetOf(playingContext, queueList, lists);
  const addLabel = addTarget.kind === 'queue' ? 'Now playing queue' : `\u201c${addTarget.name}\u201d`;
  const addedKeys = new Set(addTarget.kind === 'queue' ? queueRows.map((x) => x.track.key) : (lists.find((l) => l.id === addTarget.id)?.items ?? []).map((i) => i.key));
  const addToListening = (t: Track) => {
    if (addTarget.kind === 'queue') {
      const row = addedRow(t);
      const after = playingKey && queueRows.some((x) => x.track.key === playingKey) ? playingKey : null;
      setResult((prev) => {
        if (!prev) return prev;
        const next = insertAfter(prev.items, row, after);
        return { ...prev, items: next, count: next.length };
      });
      api.queueAdd(row, after).then((r) => setResult((prev) => prev ?? r), (e: Error) => flash(`Could not add that: ${e.message}`));
      flash(`Added \u201c${t.title}\u201d to your now playing queue.`);
      // QUEUE-SEED-001: a song put in the queue by hand is a starting song too, so one added song is
      // enough to discover from — the listener should not have to find a second control for that.
      if (!seeds.some((x) => x.key === t.key)) {
        const next = [...seeds, { ...t, emphasis: t.emphasis ?? 1 }];
        setSeeds(next);
        void (async () => {
          try {
            await api.putSeeds(next);
            // A discovery already under way is reading these same seeds; let it finish.
            if (!running) await run(true);
          } catch (e) {
            flash(`Could not start from that song: ${(e as Error).message}`);
          }
        })();
      }
      return;
    }
    const target = addTarget;
    void (async () => {
      try {
        // Saving first lets the list name the song: a list holds keys, and the engine knows a song
        // from what was saved, queued or started from.
        await api.feedback('save', t, { event_id: newEventId('save', t.key) });
        const r = await api.playlistEdit('add', { ids: [target.id], key: t.key });
        setLists(r.lists);
        if (target.seed && !seeds.some((x) => x.key === t.key)) {
          // At the end, in the list's own order (PLAYLIST-QUEUE-001), then discover from it.
          const next = [...seeds, { ...t, emphasis: t.emphasis ?? 1 }];
          setSeeds(next);
          await api.putSeeds(next);
          void run(true);
        }
        flash(`Added \u201c${t.title}\u201d to ${addLabel}.`);
      } catch (e) {
        flash(`Could not add that: ${(e as Error).message}`);
      }
    })();
  };
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
  /** A song chosen by its id — a car row (playlist-scoped or not), or the song the engine is playing. */
  /** CAR-RADIO-CONTROLS-001: the song identified on the radio, for a star or playlist pick made in the car. */
  const onAirSong = (id: string): Track | undefined => { const r = radioSession.get(); return r.identified && r.track?.key === id && r.track.provider !== 'radio' ? r.track : undefined; };
  const trackById = (id: string): Track | undefined =>
    activeItems.find((x) => x.track.key === id)?.track
    ?? lists.flatMap((l) => savedTracks(saved, lists, l.id)).find((t) => t.key === id)
    ?? (saved ?? []).map((s) => s.track).find((x) => x.key === id)
    ?? carCatalog.find(id);
  /**
   * SERVICE-API-001: a car row the service engine found (the phone page was closed or hidden) is not
   * known here. Ask the service for its exact list and play it as a search list, whole; a newer
   * choice made meanwhile wins, and an unknown or mismatched answer plays nothing.
   */
  const carContextSeq = useRef(0);
  const playFromService = (id: string, seq: number) => {
    api.carContext(id).then((ctx) => {
      const hit = pickCarContext(ctx, id);
      if (hit && seq === carContextSeq.current) playFromSearch(hit.track, hit.tracks);
    }, () => undefined);
  };
  const playById = (id: string) => {
        const seq = ++carContextSeq.current;
        // ALBUM-CAR-001: an album's song from a car search plays the album around it, in album order.
        if (decodeCarAlbumId(id)) {
          const hit = carCatalog.albumOf(id);
          if (hit) playFromSearch(hit.track, hit.tracks);
          else playFromService(id, seq); // A stale/forged car id must not play an unrelated song.
          return;
        }
        const scoped = decodePlaylistMediaId(id);
        // CAR-LOCAL-001: a song from the car's "On this phone" list plays in that list (held songs only).
        if (scoped?.listId === PHONE_LIST) {
          const seen = new Set<string>();
          const held = [...activeItems.map((x) => x.track), ...lists.flatMap((l) => savedTracks(saved, lists, l.id))]
            .filter((t) => t && !seen.has(t.key) && seen.add(t.key) && nativeReady(t));
          const track = held.find((t) => t.key === scoped.key);
          if (track) playFromSearch(track, held); else playFromService(id, seq);
          return;
        }
        if (scoped) {
          const list = lists.find((l) => l.id === scoped.listId);
          const track = list && savedTracks(saved, lists, list.id).find((t) => t.key === scoped.key);
          if (!track) { playFromService(id, seq); return; } // A stale/forged car id must not play an unrelated song.
          playingListRef.current = list.id;
          enterPlayingContext(list.id);
          const row = playbackRows([track])[0];
          if (row) play(row, { keepList: true });
          return;
        }
        const inActive = activeItems.find((x) => x.track.key === id);
        if (inActive) { play(inActive, { keepList: true }); return; }
        const t = trackById(id);
        const row = t ? playbackRows([t])[0] : undefined;
        if (row) play(row, { keepList: true });
        else playFromService(id, seq);
  };
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    setMediaHandlers({
      next: goNext,
      prev: goPrev,
      playIndex: (i) => { const it = activeItems[i]; if (it) play(it, { keepList: true }); },
      playId: playById,
      catalogSearch: (query, opts) => carCatalog.searchAll(query, opts),
      identifyAudio: (samples) => carCatalog.identifyClip(samples),
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
      // CAR-ACTIONS-001: the car's Star and Dislike buttons teach the same taste as the app's own.
      feedback: (id, kind, carTrack) => {
        const t = trackById(id) ?? (playing?.track.key === id ? playing.track : undefined) ?? onAirSong(id) ?? carTrack;
        if (!t) return;
        learnFeedback(t, kind).catch((e) => flash(`Could not save that: ${(e as Error).message}`));
      },
      // CAR-CONTROLS-001: a playlist picked in the car after a row's star, saved like the app's own add.
      playlistAdd: (id, listId, carTrack) => {
        const t = trackById(id) ?? (playing?.track.key === id ? playing.track : undefined) ?? onAirSong(id) ?? carTrack;
        const list = lists.find((l) => l.id === listId && !l.album);
        if (!t || !list) return;
        void (async () => {
          try {
            await api.feedback('save', t, { event_id: newEventId('save', t.key) });
            const r = await api.playlistEdit('add', { ids: [list.id], key: t.key, tracks: [t] });
            setLists(r.lists);
          } catch (e) {
            flash(`Could not add that to ${list.name}: ${(e as Error).message}`);
          }
        })();
      },
      // CAR-SIMILAR-001: the car's Find similar button runs the phone's own sound match for the car's song.
      findSimilar: async (id) => {
        if (similarRef.current) throw new Error('Already looking for similar songs. Try again when that finishes.');
        similarRef.current = true; setSimilarBusy(true);
        try {
          if (jobRef.current && !job?.done) void api.cancelJob(jobRef.current).catch(() => undefined);
          jobRef.current = null;
          const out = await runCarSimilar(id, {
            findTrack: (k) => trackById(k) ?? (playing?.track.key === k ? playing.track : null),
            similar: api.similar, job: api.job, song: nativeSong, wait: phoneWait,
            onQueue: (q) => setResult(q as RecResult),
          });
          setSimilarStatus(out.added
            ? `Added ${out.added} new song${out.added === 1 ? '' : 's'} with at least ${out.minimum}% sound match, from the car.`
            : out.reason || `No new songs reached ${out.minimum}% sound match. The list is unchanged.`);
          return out;
        } catch (e) {
          setSimilarStatus(`Could not find similar songs: ${(e as Error).message}`);
          throw e;
        } finally { similarRef.current = false; setSimilarBusy(false); nudgeMood(); }
      },
      repeat: (mode) => {
        const target: RepeatMode = mode === 1 ? 'one' : mode === 3 ? 'once' : mode === 4 ? 'twice' : 'off';
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
      title: playing?.track.title ?? 'jPlay',
      artist: playing ? artistOf(playing.track) : '',
      album: playing?.track.album ?? null,
      artwork: playing?.track.artwork ?? null,
      durationMs: playing?.track.duration ? Math.round(playing.track.duration * 1000) : -1,
      canNext: Boolean(nextStep),
      canPrev: Boolean(prevStep),
      shuffle,
      repeat: repeat === 'one' ? 1 : repeat === 'once' ? 3 : repeat === 'twice' ? 4 : 0,
      queue: activeItems.map((x) => nativeSong(x.track)),
      queueIndex: idx,
      liked: playingLiked,
      disliked: playingDisliked,
    });
  }, [playing, activeItems, playingKey, Boolean(nextStep), Boolean(prevStep), shuffle, repeat, readySignature, playingLiked, playingDisliked]);
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    pushMediaLibrary(
      activeItems.map((x) => nativeSong(x.track)),
      lists.map((l) => ({
        id: l.id, title: l.name, songs: savedTracks(saved, lists, l.id).map((t) => nativeSong(t)),
        // ALBUM-SAVE-001: saved albums are listed under Albums in the car.
        ...(l.album ? { album: true, artist: l.album.artist, artwork: l.album.artwork } : {}),
      })),
    );
    // NATIVE-COLD-STATE-001: their original Tracks too, so a cold car start acquires these exact songs.
    pushMediaTracks([...activeItems.map((x) => x.track), ...lists.flatMap((l) => savedTracks(saved, lists, l.id))]);
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
        nudgeMood();
        if (!r || seq !== rerankSeq.current) return;
        setTaste(r.taste);
        setResult((prev) => {
          if (!prev || prev.sample) return prev;
          const merged = keepMood(mergeRerank(prev.items, r.items, playedRef.current));
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
          // MOOD-DISCOVER-001: songs found for the mood are then put in their place by the mood.
          .then(({ job: id, mood }) => (id ? follow(id).then(() => { if (mood?.length) nudgeMood(); }) : undefined))
          .catch(() => undefined);
      })
      .catch(() => undefined);
  };
  /**
   * The Android engine played on while this page was closed or asleep. When the page comes back
   * the engine lists what it did (`pending`): each song it finished or skipped teaches taste by the
   * same rules a watched song does, and the page then follows the song the engine is on now.
   */
  const engineSync = useRef<(st: Parameters<Parameters<typeof subscribeEngineState>[0]>[0]) => void>(() => undefined);
  useEffect(() => {
    engineSync.current = (st) => {
      for (const ev of st.pending ?? []) {
        if (!markEngineEvent(ev.seq)) continue;
        const listen = listenFromEvent(ev);
        const track = listen ? trackById(ev.from.id) : undefined;
        if (listen && track) {
          onListen(listen.kind, track, listen.listened, {
            instance: `engine-${ev.seq}-${Date.now().toString(36)}`,
            medium: 'full',
            duration: listen.duration,
            coverage: listen.coverage,
          });
        }
      }
      if (st.pending && st.id && st.id !== playingKey) playById(st.mediaId ?? st.id);
    };
  });
  useEffect(() => {
    if (!engineAvailable()) return;
    const off = subscribeEngineState((st) => engineSync.current(st));
    engineSend({ op: 'hello' });
    return off;
  }, []);
  // CAR-SETTINGS-001: the car's EQ / discovery / mood buttons save here as the phone's own settings; the phone's
  // discovery level and mood switch go to the engine so the car's buttons read them.
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    setMediaHandlers({
      carSettings: (change) => {
        setSettings((s) => (s ? { ...s, ...change } : s));
        void applyCarSettings(change, { save: (p) => api.putSettings(p).then(setSettings), send: engineSend }).catch((e: Error) => flash(e.message));
      },
    });
  });
  useEffect(() => {
    const cmd = engineAvailable() ? discoveryForEngine(settings) : null;
    if (cmd) engineSend(cmd);
  }, [settings?.adventurous, settings?.mood_queue]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const feedbackPending = useRef(new Set<string>());

  /** Explicit judgements teach the same live ranker as listening, without another provider run. */
  const learnFeedback = async (track: Track, kind: FeedbackKind) => {
    const k = track.key;
    if (feedbackPending.current.has(k)) return;
    feedbackPending.current.add(k);
    try {
      // Persist before presenting a successful judgement; a failed write must not poison the UI.
      if (!result?.sample) await api.feedback(kind, track, { event_id: newEventId(kind, k), session: sessionRef.current, origin: 'explicit' });
      setFlags((f) => {
        const cur = { ...(f[k] ?? {}) };
        if (kind === 'like') Object.assign(cur, { like: true, dislike: false });
        if (kind === 'unlike') cur.like = false;
        if (kind === 'dislike') Object.assign(cur, { dislike: true, like: false });
        if (kind === 'undislike') cur.dislike = false;
        if (kind === 'hide') cur.hide = true;
        return { ...f, [k]: cur };
      });
      // REMOVE-QUIET-001 (owner, 2026-11-19): "get rid of the message when removing a song" — the row going
      // away is the answer; no notice follows it.
      if (kind === 'hide') setHidden((h) => new Set(h).add(k));
      if (result?.sample) return;
      const seq = ++rerankSeq.current;
      // MOOD-QUEUE-001: a star or a dislike re-plans the songs to come for the mood.
      nudgeMood();
      await refreshTaste();
      if (!result) return;
      // Protect playback/history and owner-added entries, but apply the learned order to upcoming
      // recommendations now. Disliked songs are excluded by the engine, not just painted red.
      try {
        const r = await api.rerank([...playedRef.current]);
        if (seq !== rerankSeq.current) return;
        setTaste(r.taste);
        setResult(prev => {
          if (!prev || prev.sample) return prev;
          const protectedKeys = new Set(playedRef.current);
          if (playing) protectedKeys.add(playing.track.key);
          const merged = keepMood(mergeRerank(prev.items, r.items, protectedKeys));
          setFocusKey(f => keepFocus(prev.items.map(x => x.track.key), f, merged.map(x => x.track.key)));
          return { ...prev, items: merged, count: merged.length };
        });
      } catch {
        // A manually added queue can have no discovery pool yet. The judgement and colour update
        // still succeeded and will inform the next discovery run.
      }
    } finally {
      feedbackPending.current.delete(k);
    }
  };
  const onFeedback = async (it: RecItem, kind: FeedbackKind) => {
    try { await learnFeedback(it.track, kind); }
    catch (e) { flash(`Could not save that: ${(e as Error).message}`); }
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
    void learnFeedback(track, like ? 'like' : 'unlike').catch((e: Error) => flash(`Could not save that: ${e.message}`));
  };

  /** Take a song off Saved: the like is removed on the engine and the row goes at once. */
  const removeSaved = (track: Track) => {
    setSaved((list) => (list ? list.filter((x) => x.track.key !== track.key) : list));
    setFlags((f) => ({ ...f, [track.key]: { ...(f[track.key] ?? {}), like: false } }));
    api.feedback('unlike', track).then(() => void refreshTaste(), (e: Error) => flash(`Could not remove that: ${e.message}`));
  };

  // ---------------------------------------------------------------- render
  const running = Boolean(job && !job.done);
  // GENRE-LOAD-001: the rows with no genre are looked up a few at a time, once no run is going.
  useQueueGenres(result, running, setResult);
  // ALLOWANCE-SEEN-001: every source the last discovery asked was refused for the day's allowance.
  const allowanceSpent = Object.values(result?.sources ?? {}).some((s) => s.state === 'budget');
  const sample = Boolean(result?.sample);
  const adventurous = settings?.adventurous ?? 0.5;
  const fresh = settings?.fresh ?? false;
  const queueSize = settings?.queue_size ?? 20;
  const tasteLine = describeTaste(taste);

  const transferNote = result && !sample ? Object.values(result.transfer ?? {}).reduce((a, b) => a + (b || 0), 0) : 0;
  const srcEntries = Object.entries(job?.sources ?? result?.sources ?? {});
  const failed = srcEntries.filter(([, s]) => s.state !== 'ok' && s.state !== 'skipped');

  // The desktop player bar is fixed to the bottom; its measured height keeps the last song clear of it.
  // STRIP-H-001 (QA, 2026-11-19): the bar is often rendered after this effect first runs (or replaced),
  // which left the 120px fallback under a 165px bar and hid the last row; it is found whenever it appears.
  useEffect(() => {
    if (docked) return;
    let ro: ResizeObserver | null = null;
    let seen: HTMLElement | null = null;
    const attach = () => {
      const rail = document.querySelector<HTMLElement>('.rail');
      if (!rail || rail === seen) return;
      ro?.disconnect();
      seen = rail;
      const set = () => document.documentElement.style.setProperty('--strip-h', `${rail.offsetHeight}px`);
      set();
      ro = new ResizeObserver(set);
      ro.observe(rail);
    };
    attach();
    const mo = new MutationObserver(attach);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { mo.disconnect(); ro?.disconnect(); };
  }, [docked]);

  // The phone dock is measured the same way: its rows (title, progress, controls, song actions) wrap
  // differently by width and language, so a fixed --dock-h would either cover the last song or leave a gap.
  useEffect(() => {
    const root = document.documentElement;
    if (!docked || (!playing && !radioStation)) {
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
  }, [docked, Boolean(playing), Boolean(radioStation)]);

  return (
    <div className={classNames('app', docked && 'app--docked', (playing || radioStation) && docked && 'has-dock', !docked && 'has-strip')}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <nav className="side" aria-label="jPlay">
        <div className="brand">
          <BrandLogo tint={logoTint} />
        </div>
        <ul className="side__nav">
          {(
            [
              ['discover', 'Discover', 'discover'],
              ['radio', 'Radio', 'note'],
              ['saved', 'Saved', 'heart'],
              ['profile', 'Profile', 'eq'],
              ['settings', 'Settings', 'gear'],
            ] as const
          ).map(([id, label, g]) => (
            <li key={id}>
              <button className={classNames('side__item', tab === id && 'is-on')} type="button" aria-label={label} aria-current={tab === id ? 'page' : undefined} onClick={() => { setPages([]); setTab(id); }}>
                {g === 'gear' ? <GearGlyph size={15} /> : <Glyph name={g} size={15} />}
                <span>{label}</span>
                {/* DOWNLOADS-IN-SETTINGS-001: the download list lives in Settings now; its running count shows here. */}
                {id === 'settings' && dls.activeCount > 0 && <span className="count">{dls.activeCount}</span>}
              </button>
            </li>
          ))}
        </ul>
        <p className="side__count" aria-live="polite">
          {seeds.length} starting {seeds.length === 1 ? 'song' : 'songs'}
        </p>
      </nav>

      <main id="main" className="main">
        {/* JPLAY-BRAND-001: a phone has no side bar, so the logo heads the page. */}
        <header className="phonebrand">
          <BrandLogo tint={logoTint} />
        </header>
        <CardCacheContext.Provider value={cardCache}>
        {offline && (
          <p className="banner banner--bad" role="alert">
            <Glyph name="offline" size={14} /> The jPlay service is not answering on this computer. Start it with <code>pnpm discovery</code> and reload.
          </p>
        )}
        {notice && (
          <p className="toast" role="status">
            {notice}
          </p>
        )}

        {albumOpen && top.page.kind === 'artist' && (
          <ArtistView
            key={`${pages.length}:${artistTargetKey(top.page.target)}`}
            target={top.page.target}
            onBack={closeAlbum}
            onPreview={playFromSearch}
            onPlayAll={playAll}
            onOpenAlbum={(a) => openAlbum({ id: a.id })}
            onOpenArtist={openArtist}
            seedKeys={new Set(seeds.map((s) => s.key))}
            onAdd={onAdd}
            onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
            onLike={likeTrack}
            onRemoveSeed={(t) => saveSeeds(seeds.filter((s) => s.key !== t.key))}
            lists={lists}
            onLists={setLists}
            onQueueAdd={addToListening}
            addLabel={addLabel}
            addedKeys={addedKeys}
            playingKey={playingKey}
          />
        )}
        {albumOpen && top.page.kind === 'album' && (
          <AlbumView
            key={`${pages.length}:${albumTargetKey(top.page.target)}`}
            target={top.page.target}
            onOpenArtist={openArtist}
            onBack={closeAlbum}
            onPreview={(t, list) => playFromSearch(t, list, { album: true })}
            onPlayAll={playAlbum}
            seedKeys={new Set(seeds.map((s) => s.key))}
            onAdd={onAdd}
            onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
            onLike={likeTrack}
            onRemoveSeed={(t) => saveSeeds(seeds.filter((s) => s.key !== t.key))}
            lists={lists}
            onLists={setLists}
            onQueueAdd={addToListening}
            addLabel={addLabel}
            addedKeys={addedKeys}
            playingKey={playingKey}
          />
        )}

        {tab === 'discover' && (
          <div className="tabpane" hidden={albumOpen}>
            <div ref={searchRef}>
              <Search
                seeds={seeds}
                onAdd={onAdd}
                onPreview={playFromSearch}
                onOpenSettings={() => setTab('settings')}
                onQueueAdd={addToListening}
                addLabel={addLabel}
                addedKeys={addedKeys}
                onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
                onLike={likeTrack}
                onRemoveSeed={(t) => saveSeeds(seeds.filter((s) => s.key !== t.key))}
                lists={lists}
                onLists={setLists}
                onOpenAlbumTarget={openAlbum}
                onOpenArtist={openArtist}
                playingKey={playingKey}
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
                  <span>Prefer new releases</span>
                  <span className="go__freshnote">songs from the last 60 days, when the source gives a date</span>
                </label>
              </div>
              <div className="go__row">
                <button className="push push--default push--big" type="button" disabled={!seeds.length || running || !loaded} aria-describedby="go-why" onClick={() => void run()}>
                  {running ? 'Finding…' : 'Find my next favorite'}
                </button>
                {running && (
                  <button className="push push--big" type="button" onClick={cancel}>
                    Stop
                  </button>
                )}
                <span id="go-why" className="go__why" aria-live="polite">
                  {customStatus.text && (customStatus.running || !customOpen) ? customStatus.text : !seeds.length ? 'Add at least one starting song first.' : running ? job?.progress : ''}
                </span>
                {customStatus.running && !customOpen && (
                  <button className="push push--big" type="button" onClick={stopCustom}>Stop</button>
                )}
                <CustomDiscovery
                  open={customOpen}
                  onClose={() => setCustomOpen(false)}
                  defaults={{ count: queueSize, adventurous }}
                  status={customStatus}
                  onRun={(c) => void runCustom(c)}
                  onStop={stopCustom}
                />
                {settings?.sample_mode && (
                  <button className="linkbtn go__sample" type="button" onClick={loadSample}>
                    Show sample data
                  </button>
                )}
              </div>
              {/* NEXT-FAV-CUSTOM-001: the same search with the listener's own genres, artists and sliders, beneath the
                  one-tap run (which never inherits these choices). */}
              <div className="go__more">
                <button className="push go__custom" type="button" disabled={!loaded} aria-haspopup="dialog" aria-expanded={customOpen}
                  onClick={() => setCustomOpen(true)}>
                  <Glyph name="eq" size={14} /> Customize discovery
                </button>
              </div>
            </section>

            <SoundCard taste={taste} listening={Boolean(playing)} />
            {queueList && (
              <SoundCard
                key={queueList.id}
                taste={shownMix?.taste ?? null}
                listening={Boolean(playing) && activeItems === queueRows}
                title={`Sound of “${queueList.name}”`}
                label="This list's mix"
                historyKey={`airwave.sound.list.${queueList.id}`}
                idleText={shownMix ? listMixNote(shownMix) : 'Reading the list…'}
                emptyText={shownMix ? `No genre known yet for the ${shownMix.songs} songs in this list. Discovery looks them up; this fills in as it does.` : 'Reading the list…'}
              />
            )}

            <section className="queue" aria-labelledby="queue-h" aria-busy={running || similarBusy}>
              {queueList && (
                <div className="banner banner--list" role="note">
                  <span>
                    <Glyph name="info" size={14} />
                    Playing your list <strong>“{queueList.name}”</strong>. All {visibleSeeds.length} of its songs are starting songs, and new music is found from them.
                  </span>
                  {canRestore && (
                    <button className="push push--small" type="button" onClick={restoreQueue}>
                      Bring back my queue
                    </button>
                  )}
                </div>
              )}
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
              {similarStatus && <p className="state" role="status" aria-live="polite">{similarBusy && <span className="sdot sdot--busy" aria-hidden="true" />} {similarStatus}</p>}
              {runErr && (
                <p className="state state--bad" role="alert">
                  <Glyph name="warning" size={14} /> {runErr}
                </p>
              )}
              {/* ALLOWANCE-SEEN-001: a day's allowance that is used up stops discovery, genre reading
                  and album colour. Say so where the new music would have been, not only in Settings. */}
              {allowanceSpent && !running && (
                <div className="budget-note" role="note" aria-label="Discovery allowance used up">
                  <p className="state">
                    <Glyph name="info" size={14} /> Today’s download allowance is all used up, so no new music could be
                    found and genres were not read. It resets tomorrow.
                  </p>
                  <button className="push" type="button" onClick={() => setTab('settings')} aria-label="Raise the allowance in Settings">
                    Raise the allowance in Settings
                  </button>
                </div>
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
                        <ListFolderButton tracks={queueTracks} name={queueList?.name ?? 'Now playing queue'} label="the now playing queue" />
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
                    {moodPulse && moodNoteOn && (
                      <p className="mood-note" role="status" aria-label={`Queue re-arranged for your mood${moodPulse.leading.length ? `: ${moodPulse.leading.join(', ')}` : ''}`} key={moodPulse.tick}>
                        <span className="mood-note__icon" aria-hidden="true"><Glyph name="shuffle" size={14} /></span>
                        <span>Queue re-arranged for your mood{moodPulse.leading.length ? `: ${moodPulse.leading.join(' · ')}` : ''}</span>
                      </p>
                    )}
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
                      onSimilar={sample ? undefined : (t) => void findSimilar(t)}
                      similarBusy={similarBusy}
                      onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
                      cacheOf={cardCache}
                      lists={lists}
                      onLists={setLists}
                      onOpenAlbum={(t) => openAlbum({ track: t })}
                    onOpenArtist={openArtist}
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
                      <ListFolderButton tracks={queueTracks} name={queueList?.name ?? 'Now playing queue'} label="the now playing queue" />
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
                    onSimilar={(t) => void findSimilar(t)}
                    similarBusy={similarBusy}
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
          </div>
        )}

        {tab === 'radio' && <div className="tabpane" hidden={albumOpen}><Radio onTune={tune} onOpenArtist={openArtist} onPlaySong={playFromRadio} /></div>}

        {tab === 'saved' && (
          <div className="tabpane" hidden={albumOpen}>
          <SavedView
            saved={saved}
            lists={lists}
            onLists={setLists}
            onVisibleList={setVisibleSavedList}
            onPreview={playFromSaved}
            onPlayAll={playAllSaved}
            onRemoveSaved={removeSaved}
            onDownload={dls.on ? (t) => void dls.downloadTrack(t) : undefined}
            cacheOf={cardCache}
            onUseAsQueue={useListAsQueue}
            queueListId={queueList?.id ?? null}
            onOpenAlbum={(t) => openAlbum({ track: t })}
            onOpenAlbumId={(id) => openAlbum({ id })}
            onOpenArtist={openArtist}
            // ROW-UNIFY-001: Find similar on a saved song adds to the Discover queue; the outcome is shown here.
            onSimilar={(t) => void findSimilar(t).then((m) => { if (m) flash(m); })}
            similarBusy={similarBusy}
          />
          </div>
        )}

        {tab === 'profile' && <div className="tabpane" hidden={albumOpen}><ProfileView /></div>}

        {tab === 'settings' && (
          <div className="tabpane" hidden={albumOpen}>
          <SettingsView
            settings={settings}
            sources={Object.fromEntries(srcEntries)}
            downloads={dls}
            onSettings={patchSettings}
            onFormulaSaved={setSettings}
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
          </div>
        )}
        </CardCacheContext.Provider>
      </main>

      <aside className="rail" aria-label="Player">
        {!radioStation && <QueuePreparation tracks={cacheTracks} parallel={settings?.dl_parallel ?? 0}
          preload={{ target: settings?.preload_target ?? 'all', count: settings?.preload_count ?? 20 }} />}
        {radioStation ? <RadioPlayer docked={docked} onOpenArtist={openArtist} onPlaySong={playFromRadio} onDownloadSong={dls.on ? dls.downloadTrack : undefined} /> : <Player
          onOpenArtist={openArtist}
          playing={playing}
          upNext={upNext}
          docked={docked}
          canPrev={Boolean(prevStep)}
          canNext={Boolean(nextStep)}
          shuffle={shuffle}
          repeat={repeat}
          cacheGb={settings?.cache_gb ?? 1}
          actions={{
            songKey: playing?.track.key,
            // STAR-MENU-001: the player's star opens the same saved-list menu as a song row.
            songTitle: playing?.track.title,
            noDislike: albumPlaying,
            onLists: setLists,
            lists,
            flags: (playing && flags[playing.track.key]) || {},
            downloadState: dls.trackState(playing?.track.key),
            downloadAvailable: dls.on,
            onFeedback: async (kind) => {
              if (!playing) return;
              await learnFeedback(playing.track, kind);
            },
            onDownload: async () => (playing ? dls.downloadTrack(playing.track) : false),
            // DOWNLOADS-IN-SETTINGS-001: the download list lives in the Settings Downloads section.
            onDownloads: () => setTab('settings'),
            // PLAYER-SIMILAR-001: the song playing, from any tab; the queue's status line is on Discover,
            // so elsewhere the outcome is also shown as a short notice.
            onSimilar: playing ? () => {
              const track = playing.track;
              void findSimilar(track).then((m) => { if (m && tabRef.current !== 'discover') flash(m); });
            } : undefined,
            similarBusy,
          }}
          onShuffle={toggleShuffle}
          onRepeat={cycleRepeat}
          onRepeatConsumed={(remaining) => setRepeat(() => { writeFlag(REPEAT_KEY, remaining); return remaining; })}
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
        />}
      </aside>
    </div>
  );
}
