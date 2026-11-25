import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CardCacheContext } from './card-cache-context';
import { Radio } from './Radio';
import { RadioPlayer } from './RadioPlayer';
import { radioSession } from './engine/radio-client';
import type { RadioStation } from './engine/radio';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { api, type Characteristics, type PlaylistMix, newEventId, type FeedbackKind, type JobStatus, type Playback, type PlaylistSummary, type RecItem, type RecResult, type SavedItem, type Settings, type TasteSummary, type Track } from './api';
import { Art } from './Art';
import { CustomDiscovery, readCustom, type CustomStatus } from './CustomDiscovery';
import { hasCustomChoices, type CustomCriteria } from './engine/custom-discovery';
import { TasteSpinner } from './TasteSpinner';
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
import { ListDownloadButton, ListFolderButton, ListLoadedNote } from './ListDownloadBar';
import './discover-tidy.css';
import { useCardCache } from './useCardCache';
import { withJob } from './engine/play-state';
import { useKeptKeys } from './useKeptKeys';
import { useQueueGenres } from './useQueueGenres';
import { savedTracks, playbackRows, preparationTracks, contextRows, addTargetOf, addedRow, insertAfter, SEARCH_CONTEXT } from './engine/queue-context';
import { runCarSimilar } from './engine/car-similar';
import { captureRows, moodMovable, pinNext, placeMood, playMoodMove } from './engine/mood-apply';
import { arrangeShuffle, forgetOrder, heardIn, keepOrder, keptOrder, newShuffleSeed, rememberStarted, restoreOrder, seededRand, startedOnRecord, unionHeard } from './engine/shuffle-order';
import { MAX_ARTIST_RUN } from './engine/artist-variety';
import { phoneWait } from './engine/native-http';
import { favArtistsStore } from './fav-artists-store';
import { CAR_NEW_LIST, CAR_NEW_LIST_NAME, PHONE_LIST, artistNamesOf, decodeCarAlbumId, decodePlaylistMediaId, mediaNativeAvailable, pickCarContext, pushMediaLibrary, pushMediaState, pushMediaTracks, setMediaHandlers, songFromTrack } from './engine/media-native';
import { engineAvailable, engineSend, listenFromEvent, markEngineEvent, subscribeEngineState } from './engine/native-engine';
import { engineInstance } from './engine/service-listening';
import { keepTrying } from './engine/playlist-delta';
import { similarDetail, SimilarNotice, type SimilarNote } from './SimilarNotice';
import { applyCarSettings, discoveryForEngine } from './engine/car-settings';
import { SettingsView } from './Settings';
import { markSavedSettingsApplied, setEqConfig, setLocalMix, setMixSlider, setPlayThrough } from './audio-engine';
import { PLAY_THROUGH_DEFAULT } from './engine/crossfade';
import { dl, downloadsAvailable } from './engine/downloads';
import { clearResume, readResume } from './engine/resume';
import { clearStoppedAt, countPlay, writeStoppedAt } from './engine/session';
import { beginFreshSession, clearQueueForSession, clearedKeys, readPlays, subtractCleared, unclearKey, writePlays } from './engine/session-state';
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

// SESSION-RESET-001: the launch check runs once per page load, before any restore.
const launchFresh = beginFreshSession(localStorage, Date.now());

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
  /** SIMILAR-NOTICE-001: the Find similar card over every page, and the first song it added (for Show). */
  const [similarNote, setSimilarNote] = useState<SimilarNote | null>(null);
  const similarFirstNew = useRef<string | null>(null);
  const similarNoteTimer = useRef<number | undefined>(undefined);
  const showSimilarNote = (n: SimilarNote | null) => {
    window.clearTimeout(similarNoteTimer.current);
    setSimilarNote(n);
    // A result stays long enough to read and act on; a search in progress stays until it ends.
    if (n && n.phase !== 'busy') similarNoteTimer.current = window.setTimeout(() => setSimilarNote((x) => (x === n ? null : x)), 9000);
  };
  /** What a finished sound match says on the card, and which of its songs is new. */
  const noteSimilarResult = (title: string, out: { added: number; reached?: number; below?: number; unmeasured?: number; minimum: number; reason?: string; queue?: RecResult } | null, before: Set<string>) => {
    if (out && out.added > 0) {
      similarFirstNew.current = out.queue?.items.find((x) => !before.has(x.track.key))?.track.key ?? null;
      showSimilarNote({ phase: 'done', title, added: out.added, detail: similarDetail(out) });
    } else {
      showSimilarNote({ phase: 'none', title, detail: out?.reason || `No new songs reached ${out?.minimum ?? 70}% sound match. The list is unchanged.` });
    }
  };
  const showSimilarSongs = () => {
    setTab('discover');
    if (similarFirstNew.current) setFocusKey(similarFirstNew.current);
    showSimilarNote(null);
  };
  // NEXT-FAV-CUSTOM-001: Customize discovery.
  const [customOpen, setCustomOpen] = useState(false);
  const [customStatus, setCustomStatus] = useState<CustomStatus>({ running: false, text: '' });
  const customJob = useRef<string | null>(null);
  const [result, setResult] = useState<RecResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const radioStation = useSyncExternalStore(radioSession.subscribe, () => radioSession.get().station);
  // CAR-RADIO-ADOPT-001: a station the car starts while this page is open in the background is adopted too.
  useEffect(() => {
    void radioSession.restore();
    const t = setInterval(() => void radioSession.restore(), 5000);
    return () => clearInterval(t);
  }, []);
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
  // SHUFFLE-ONCE-001 (owner, 2026-11-24: "shuffle should only play a song once before finding a new song"): songs
  // finished or skipped before, on record from earlier sessions and from the car. The queue's shuffle never comes back
  // to them; a saved list keeps its own rounds.
  const [heardOnRecord, setHeardOnRecord] = useState<ReadonlySet<string>>(() => startedOnRecord());
  const historyRef = useRef<string[]>([]);
  /** ARTIST-RUN-001: the artist credits of the songs played, oldest first (the newest few are all it needs). */
  const artistRunRef = useRef<string[]>([]);
  const [saved, setSaved] = useState<SavedItem[] | null>(null);
  /** The listener's saved lists. Loaded with Saved and refreshed by every list edit. */
  const [lists, setListsRaw] = useState<PlaylistSummary[]>([]);
  // PLAYLIST-KEEP-001: "no lists yet" and "the lists have not been read yet" are different things. Until the engine
  // has answered once, the car is not told the listener has no playlists.
  const [listsKnown, setListsKnown] = useState(false);
  const setLists = useCallback((next: PlaylistSummary[]) => { setListsRaw(next); setListsKnown(true); }, []);
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
  /** QUEUE-NEXT-001: the song the player will play next, for the mood's re-arrangement to keep in place. */
  const nextKeyRef = useRef<string | null>(null);
  // SHUFFLE-ORDER-001: the shuffled order of the songs to come, the round it belongs to, and the list's own order.
  const shuffleOrderRef = useRef<string[]>([]);
  // WP5 (S8): the mood fits the shown order was dealt with (null: dealt before any mood answer), and the mood answer
  // standing when the last active signal (star, dislike, Find similar) came; the next answer after it re-deals the tail.
  const shuffleDealtFitRef = useRef<ReadonlyMap<string, number> | null>(null);
  // WP5 (plan step 5): the seed the shown order was drawn from, kept with it, so the order can be dealt again from a
  // bug report; and whether the order kept on this device has already been looked for this session (step 4).
  const shuffleSeedRef = useRef<number | null>(null);
  const shuffleKeptRead = useRef(false);
  const activeSignalRef = useRef<{ fit: ReadonlyMap<string, number> | null } | null>(null);
  // An active signal counts once a newer mood answer than the one standing at the signal has arrived.
  const activeNow = (m: { fit: ReadonlyMap<string, number> } | null) => Boolean(m && activeSignalRef.current && activeSignalRef.current.fit !== m.fit);
  const [shuffleEpoch, setShuffleEpoch] = useState(0);
  const shuffleEpochDone = useRef(-1);
  const unshuffledRef = useRef<string[] | null>(null);
  const discoverShuffleRef = useRef(false);
  // SHUFFLE-ONCE-001: what the queue's shuffle counts as heard: this session's songs and those on record. A saved list
  // or a search list counts only its own round. Cached on both sets so a render does not rebuild it.
  const heardCache = useRef<{ round: Set<string>; size: number; record: ReadonlySet<string>; all: ReadonlySet<string> } | null>(null);
  const heardNow = (): ReadonlySet<string> => {
    const round = heardRef.current;
    if (!discoverShuffleRef.current || !heardOnRecord.size) return round;
    const c = heardCache.current;
    if (c && c.round === round && c.size === round.size && c.record === heardOnRecord) return c.all;
    const all = unionHeard(round, heardOnRecord);
    heardCache.current = { round, size: round.size, record: heardOnRecord, all };
    return all;
  };
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
        setHeardOnRecord(subtractCleared(unionHeard(heardIn(fb.state), startedOnRecord()), clearedKeys(localStorage)));
        if (fb.taste) setTaste(fb.taste);
        setLoaded(true);
        sessionReady.current = true;
        // A launch counts as a stop as of now until audio starts, so a process killed while idle
        // leaves this marker, not an older one, and a quick relaunch does not reset the session.
        writeStoppedAt(localStorage, Date.now());
        // Where the listener was when the app last stopped (RESUME-001). Restored only in the
        // installed shells, where the song is a local file: the place is useless without the audio.
        if (launchFresh) clearResume();
        if (downloadsAvailable() && !launchFresh) {
          const point = readResume();
          if (point) setPlaying({ track: point.track, playback: point.playback, resumeAt: point.t });
        }
        // Bring back the last finished queue; it was counted as shown when it was first drawn.
        api.last().then(
          (r) => {
            r.items.forEach((x) => shownRef.current.add(x.track.key));
            // SESSION-RESET-001: a new session makes the queue's songs eligible for shuffle again.
            if (launchFresh) {
              clearQueueForSession(localStorage, r.items.map((x) => x.track.key));
              setHeardOnRecord((h) => new Set(subtractCleared(h, clearedKeys(localStorage))));
            }
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
    // NEXT-FAV-COLD-001 (owner, 2026-11-23): with no starting song the engine starts from the listener's stars,
    // their listening and their taste map, so a press is never refused here; the engine answers when it truly
    // has nothing to go on.
    void force;
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
    activeSignalRef.current = { fit: moodFitState?.fit ?? null };
    let said = '';
    const setSimilarStatus = (m: string) => { said = m; setSimilarStatusState(m); };
    similarRef.current = true; setSimilarBusy(true); setSimilarStatus(`Looking for songs that sound like “${track.title}” on all services…`);
    showSimilarNote({ phase: 'busy', title: track.title, progress: 'Looking on every service…' });
    const before = new Set((result?.items ?? []).map((x) => x.track.key));
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
          noteSimilarResult(track.title, out.queue ? out : { ...out, added: 0 }, before);
          break;
        }
        setSimilarStatus(status.progress || 'Comparing the sound…');
        showSimilarNote({ phase: 'busy', title: track.title, progress: status.progress || 'Comparing the sound…' });
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      setSimilarStatus(`Could not find similar songs: ${(e as Error).message}`);
      showSimilarNote({ phase: 'error', title: track.title, detail: (e as Error).message });
    }
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
    countSong(it.track.key);
    if (o?.newRound) { heardRef.current = new Set(); setShuffleEpoch((n) => n + 1); }
    heardRef.current.add(it.track.key);
    // SHUFFLE-ONCE-001: a song started in the now playing queue is heard for good, even if the app closes mid-way.
    if ((!o?.keepList || playingContext === null) && !result?.sample) {
      rememberStarted(it.track.key);
      if (!heardOnRecord.has(it.track.key)) setHeardOnRecord((h) => new Set(h).add(it.track.key));
    }
    if (!o?.back) historyRef.current = [...historyRef.current.slice(-199), it.track.key];
    if (!o?.back) artistRunRef.current = [...artistRunRef.current.slice(-(MAX_ARTIST_RUN - 1)), it.track.artists?.[0] ?? it.track.artist ?? ''];
    setPlaying({ track: it.track, playback: it.playback });
    setFocusKey(it.track.key);
  };
  const previewTrack = (t: Track) => {
    if (t.provider === 'radio' && t.radio_station) { tune(t.radio_station); return; }
    if (radioSession.get().station) { void radioSession.stop().then(() => previewTrack(t)); return; }
    countSong(t.key);
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
    if (discoverShuffleRef.current) return arrangeShuffle(xs, { playingKey, heard: heardNow(), order: shuffleOrderRef.current, reshuffle: false, rand: Math.random, hidden, recentArtists: artistRunRef.current }).items;
    if (!moodQueueScope || !moodOrderRef.current.length) return xs;
    const movable = new Set(moodMovable(xs, { currentKey: playingKey, played: playedRef.current, hidden }).map((x) => x.track.key));
    return placeMood(xs, moodOrderRef.current.filter((k) => movable.has(k)));
  };
  // WP6 (M2, D2): when the song playing started, so the mood can ramp it over its first 45 s; re-ask the mood at 45 s.
  // Wall-clock since the song started (a pause counts too): an approximation of the seconds heard.
  const moodSongStart = useRef(Date.now());
  useEffect(() => {
    moodSongStart.current = Date.now();
    if (!playingKey) return;
    const t = window.setTimeout(() => nudgeMood(), 45_000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playingKey]);
  useEffect(() => {
    if (!moodQueueScope && !moodListScope) { moodPreferRef.current = null; moodOrderRef.current = []; setMoodFitState(null); return; }
    const rows = moodQueueScope ? (result?.items ?? []) : activeItems;
    const movable = moodMovable(rows, { currentKey: playingKey, played: playedRef.current, hidden });
    if (movable.length < 2) return;
    const seq = ++moodSeq.current;
    const keys = movable.map((x) => x.track.key);
    const shownNow = moodOrderRef.current.filter((k) => keys.includes(k));
    const timer = window.setTimeout(() => {
      const heard = Math.max(0, Math.round((Date.now() - moodSongStart.current) / 1000));
      const cur = playing ? { track: playing.track, characteristics: rows.find((x) => x.track.key === playingKey)?.characteristics ?? null, heard } : undefined;
      // Every song the shuffle may pick from is scored too (hand-added ones, a list's songs), never moved.
      const score = activeItems.filter((x) => !keys.includes(x.track.key) && x.track.key !== playingKey && !hidden.has(x.track.key)).slice(0, 400)
        .map((x) => ({ track: x.track, characteristics: x.characteristics ?? null }));
      // WP6 (M1): each row's engine score, so the mood's base term is the engine's view, not the list place.
      api.mood({ upcoming: movable.map((x) => ({ track: x.track, characteristics: x.characteristics ?? null, score: typeof x.score === 'number' ? x.score : null })), score, shown: shownNow.length ? shownNow : keys, current: cur })
        .then((plan) => {
          if (seq !== moodSeq.current || plan.off) return;
          setMoodLead({ leading: plan.leading ?? [], confidence: plan.confidence ?? 0 });
          moodPreferRef.current = new Map(plan.order.map((k, i) => [k, i] as const));
          if (plan.fit) setMoodFitState({ fit: new Map(Object.entries(plan.fit)), confidence: plan.confidence ?? 0 });
          if (!moodQueueScope || discoverShuffleRef.current) return;
          moodOrderRef.current = plan.order;
          if (!plan.changed) return;
          moodBefore.current = captureRows(document);
          setResult((prev) => (prev && !prev.sample ? { ...prev, items: pinNext(placeMood(prev.items, plan.order), playingKey, nextKeyRef.current) } : prev));
          // The note (and the move animation) only when the mood itself moved rows; a run-cap-only change stays silent.
          if (plan.mood) setMoodPulse((p) => ({ tick: (p?.tick ?? 0) + 1, leading: plan.leading, moved: plan.moved, at: Date.now() }));
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
  // SHUFFLE-ORDER-001: in the Discover queue the shuffled order is in the list itself, and playback walks it.
  const discoverShuffle = shuffle && playingContext === null && !result?.sample;
  discoverShuffleRef.current = discoverShuffle;
  // ARTIST-RUN-001 (owner, 2026-11-24): the Discover queue's shuffle never plays one artist more than four times in a row
  // while another artist's song is there to play.
  const queueOpts = { shuffle, repeat, heard: heardNow(), ready: stepReady, inOrder: discoverShuffle, recentArtists: discoverShuffle ? artistRunRef.current : undefined, mood: discoverShuffle ? null : moodShuffle, prefer: !discoverShuffle && moodOn && shuffle && !moodShuffle ? moodPreferRef.current ?? undefined : undefined };
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
      if (on) setShuffleEpoch((n) => n + 1);
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
  nextKeyRef.current = nextKey;
  // QUEUE-NEXT-001 (owner, 2026-11-20): the Discover queue shows the song the player will play next directly after
  // the song playing (a shuffle or mood pick, or the next song that is ready), so the two never disagree.
  useEffect(() => {
    if (playingContext !== null || discoverShuffle) return;
    setResult((prev) => {
      if (!prev || prev.sample) return prev;
      const pinned = pinNext(prev.items, playingKey, nextKey);
      return pinned === prev.items ? prev : { ...prev, items: pinned };
    });
  }, [nextKey, playingKey, result?.items, playingContext]);
  // SHUFFLE-ORDER-001 (owner, 2026-11-20): with shuffle on, the Discover queue shows the real play order: songs heard
  // this round, the song playing, then the songs to come in the shuffled order playback will walk. Shuffle off puts
  // the list back in its own order.
  useEffect(() => {
    if (!result || result.sample) return;
    if (!discoverShuffle) {
      if (unshuffledRef.current) {
        const back = restoreOrder(result.items, unshuffledRef.current);
        unshuffledRef.current = null; shuffleOrderRef.current = []; shuffleEpochDone.current = -1; shuffleDealtFitRef.current = null;
        // WP5 (plan step 4): shuffle off drops the kept order; turning it on again deals a new one.
        shuffleSeedRef.current = null; forgetOrder();
        setResult((prev) => (prev && prev.items === result.items ? { ...prev, items: back } : prev));
      }
      return;
    }
    if (!unshuffledRef.current) unshuffledRef.current = result.items.map((x) => x.track.key);
    let reshuffle = shuffleEpochDone.current !== shuffleEpoch;
    // WP5 (plan step 4): a restart takes up the order kept on this device for this round again, while at least 60% of
    // its keys are still in the queue (keptOrder). Below that the queue has moved on under it, and this round deals.
    if (reshuffle && !shuffleKeptRead.current) {
      shuffleKeptRead.current = true;
      const kept = keptOrder(shuffleEpoch, new Set(result.items.map((x) => x.track.key)));
      if (kept) { shuffleOrderRef.current = kept.order; shuffleSeedRef.current = kept.seed; reshuffle = false; }
    }
    shuffleEpochDone.current = shuffleEpoch;
    // WP5 (plan step 5): the draw comes from a generator seeded by the number kept with the order.
    if (reshuffle || shuffleSeedRef.current === null) shuffleSeedRef.current = newShuffleSeed();
    const seed = shuffleSeedRef.current;
    const fit = moodOn && moodFitState ? { fit: moodFitState.fit, confidence: moodFitState.confidence, adventurous: settings?.adventurous ?? 0.5 } : null;
    const r = arrangeShuffle(result.items, { playingKey, heard: heardNow(), order: shuffleOrderRef.current, reshuffle, rand: seededRand(seed), mood: fit, hidden, recentArtists: artistRunRef.current,
      ready: (x) => canPlayHere(x.playback) && (!stepReady || stepReady(x.track)), dealtFit: shuffleDealtFitRef.current, activeSignal: activeNow(fit) });
    shuffleOrderRef.current = r.order;
    shuffleDealtFitRef.current = r.dealtFit;
    // WP5 (plan step 4): keep the order shown (with its round and its seed) for the next start.
    keepOrder({ order: r.order, epoch: shuffleEpoch, seed });
    if (activeNow(fit)) activeSignalRef.current = null;
    if (r.items !== result.items) setResult((prev) => (prev && prev.items === result.items ? { ...prev, items: r.items } : prev));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoverShuffle, result?.items, playingKey, shuffleEpoch, readySignature, hidden, heardOnRecord, moodFitState]);
  /**
   * QUEUE-ADD-001: the search row's add button puts a song into what the listener is listening to: the
   * saved list being played from, the saved list in the queue (whose songs are starting songs, so the
   * added one is too), or the now playing queue, where it goes right after the song playing.
   */
  const addTarget = addTargetOf(playingContext, queueList, lists);
  const addLabel = addTarget.kind === 'queue' ? 'Now playing queue' : `\u201c${addTarget.name}\u201d`;
  const addedKeys = new Set(addTarget.kind === 'queue' ? queueRows.map((x) => x.track.key) : (lists.find((l) => l.id === addTarget.id)?.items ?? []).map((i) => i.key));
  /**
   * SEARCH-DBL-NEXT-001 (owner, 2026-11-21): "double tapping or double clicking a song in search should add it to the
   * discover / now playing queue, and add that new song right after the song currently playing". The playing song
   * keeps playing and stays in the player; the + button with the queue chosen does the same.
   */
  const queueNext = (t: Track) => {
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
  };

  const addToListening = (t: Track) => {
    if (addTarget.kind === 'queue') {
      queueNext(t);
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
    const heard = heardNow();
    const rest = shuffle ? activeItems.filter((x) => x.track.key !== playingKey && !heard.has(x.track.key) && !hidden.has(x.track.key)) : activeItems.slice(i + 1).filter(x => !hidden.has(x.track.key));
    const ordered = nextKey ? [...rest.filter((x) => x.track.key === nextKey), ...rest.filter((x) => x.track.key !== nextKey)] : rest;
    return ordered
      .filter(x => playable(x) && (!ready || ready(x.track)))
      .slice(0, 4)
      .map((x) => ({ key: x.track.key, title: x.track.title, artist: artistOf(x.track), artwork: x.track.artwork, preview: x.playback.preview, track: x.track }));
  }, [activeItems, inQueue, playingKey, shuffle, hidden, nextKey, readySignature, heardOnRecord]);
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
  // DISCOVER-TIDY-001: each song once, the same count as the loaded line above the queue.
  const queueSongCount = useMemo(() => new Set(queueTracks.map((t) => t.key)).size, [queueTracks]);
  // TASTE-SPIN-001: the taste line's arrow turns while a song plays.
  const [songPlaying, setSongPlaying] = useState(false);
  // SESSION-RESET-001: play counts per listening session, and the stop marker that starts the next one.
  const [plays, setPlays] = useState<Record<string, number>>(() => readPlays(localStorage));
  const sessionReady = useRef(false);
  useEffect(() => { writePlays(localStorage, plays); }, [plays]);
  const countSong = (key: string) => { unclearKey(localStorage, key); setPlays((p) => countPlay(p, key)); };
  // Stop marker: written when audio stops, cleared when it starts. Skipped until the launch check has run,
  // so a reopen cannot overwrite the old marker.
  useEffect(() => {
    if (!sessionReady.current) return;
    if (songPlaying) clearStoppedAt(localStorage); else writeStoppedAt(localStorage, Date.now());
  }, [songPlaying]);
  useEffect(() => {
    const onHide = () => { if (sessionReady.current && !songPlaying) writeStoppedAt(localStorage, Date.now()); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [songPlaying]);
  // ROW-DL-KEPT-001: asked again each time one of the listener's own downloads finishes.
  const keptKeys = useKeptKeys(cacheTracks, dls.jobs.filter((j) => j.state === 'done').length);
  const queueCache = useCardCache(cacheTracks, keptKeys);
  // PLAY-LIVE-001: each row's state is the queue cache's word with the song's own Download job folded in, so a Play
  // button turns blue (and its ring fills) as the download runs and finishes, with nothing else asked of the listener.
  const cardCache = useMemo(() => (key: string) => withJob(queueCache(key), dls.jobOf(key)), [queueCache, dls.jobOf]);

  // MEDIA-NATIVE-001: mirror the player onto the Android native MediaSession / Android Auto. Every
  // call is a no-op outside the Android app, so these run unconditionally but only act in the shell.
  // App owns the list, queue and navigation; Player (below) owns play/pause, the playhead and seek.
  const nativeReady = (t: Track) => (ready ? ready(t) : false);
  /** The ready song as the native side needs it, including the exact file the native engine plays. */
  const nativeSong = (t: Track) => { const r = nativeReady(t); return songFromTrack(t, r, r ? queueAudio.readyUrl(t) : null); };
  /** SHUFFLE-ONCE-001: a song of the list playing, marked when the queue's shuffle counts it as heard. */
  const queueSong = (t: Track) => {
    const s = nativeSong(t);
    return discoverShuffle && t.key !== playingKey && heardNow().has(t.key) ? { ...s, heard: true } : s;
  };
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
        learnFeedback(t, kind, { fromCar: true }).catch((e) => flash(`Could not save that: ${(e as Error).message}`));
      },
      // CAR-X-001 (owner, 2026-11-24): "ensure the X button works on android auto". The car's X: the song it is playing
      // leaves the queue at once and the next one plays, wherever the song sits (the page may not know it is playing).
      leave: (id) => {
        const k = trackById(id)?.key ?? id;
        setHidden((h) => new Set(h).add(k));
        leaveSong(k);
      },
      // ARTIST-FAV-CAR-001: the car's Star the artist button stars every artist of the song (the active algorithm's list).
      starArtists: async (id, credit, carTrack) => {
        const t = trackById(id) ?? (playing?.track.key === id ? playing.track : undefined) ?? onAirSong(id) ?? carTrack;
        // CAR-ANSWERABLE-001: only the names that really saved go back to the car.
        const saved: string[] = [];
        for (const name of artistNamesOf(t, credit)) {
          if (await favArtistsStore.add({ name }).then(() => true).catch(() => false)) saved.push(name);
        }
        return saved;
      },
      // CAR-CONTROLS-001: a playlist picked in the car after a row's star, saved like the app's own add.
      playlistAdd: (id, listId, carTrack) => {
        const t = trackById(id) ?? (playing?.track.key === id ? playing.track : undefined) ?? onAirSong(id) ?? carTrack;
        // CAR-HEART-ALWAYS-001: with no playlist the car offers to start one; it is made once and found by name after.
        const starting = listId === CAR_NEW_LIST;
        const list = lists.find((l) => !l.album && (starting ? l.name === CAR_NEW_LIST_NAME : l.id === listId));
        if (!t || (!list && !starting)) return;
        const name = list?.name ?? CAR_NEW_LIST_NAME;
        void (async () => {
          try {
            await api.feedback('save', t, { event_id: newEventId('save', t.key) });
            const r = list
              ? await api.playlistEdit('add', { ids: [list.id], key: t.key, tracks: [t] })
              : await api.playlistEdit('create', { name, key: t.key, tracks: [t] });
            setLists(r.lists);
          } catch (e) {
            flash(`Could not add that to ${name}: ${(e as Error).message}`);
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
          // SIMILAR-NOTICE-001: the phone shows the car's result too (the car shows its own message).
          const title = trackById(id)?.title ?? (playing?.track.key === id ? playing.track.title : 'this song');
          if (out.added) { similarFirstNew.current = null; showSimilarNote({ phase: 'done', title, added: out.added, detail: `at least ${out.minimum}% sound match, from the car` }); }
          else showSimilarNote({ phase: 'none', title, detail: out.reason || `No new songs reached ${out.minimum}% sound match. The list is unchanged.` });
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
      queue: activeItems.map((x) => queueSong(x.track)),
      queueIndex: idx,
      liked: playingLiked,
      disliked: playingDisliked,
      // SHUFFLE-ONCE-001: the phone's engine, playing on alone (the car, the screen off), keeps the rule too.
      once: discoverShuffle,
    });
  }, [playing, activeItems, playingKey, Boolean(nextStep), Boolean(prevStep), shuffle, repeat, readySignature, playingLiked, playingDisliked, discoverShuffle, heardOnRecord]);
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    pushMediaLibrary(
      activeItems.map((x) => queueSong(x.track)),
      // PLAYLIST-KEEP-001: before the lists have been read the car keeps the playlists it already has.
      !listsKnown ? null : lists.map((l) => ({
        id: l.id, title: l.name, songs: savedTracks(saved, lists, l.id).map((t) => nativeSong(t)),
        // ALBUM-SAVE-001: saved albums are listed under Albums in the car.
        ...(l.album ? { album: true, artist: l.album.artist, artwork: l.album.artwork } : {}),
      })),
    );
    // NATIVE-COLD-STATE-001: their original Tracks too, so a cold car start acquires these exact songs.
    pushMediaTracks([...activeItems.map((x) => x.track), ...lists.flatMap((l) => savedTracks(saved, lists, l.id))]);
  }, [activeItems, lists, listsKnown, saved, readySignature, discoverShuffle, heardOnRecord, playingKey]);

  // A skip or a full listen is recorded, then the songs still to come are ranked again with it.
  // Only the newest answer is applied, so two quick skips cannot show the older order.
  // The event id is derived from the playback instance, so a duplicated player callback or a UI
  // retry re-sends the SAME id and the store's dedupe actually catches it.
  const refreshTaste = () => api.feedbackState().then((r) => setTaste(r.taste ?? null), () => undefined);

  const onListen = (kind: 'complete' | 'skip' | 'partial' | 'replay', t: Track, listened: number, meta: ListenTelemetry) => {
    const sample = Boolean(result?.sample);
    // SHUFFLE-ONCE-001: heard now is heard for good, whichever list it was heard from.
    if ((kind === 'complete' || kind === 'skip' || kind === 'partial') && !heardOnRecord.has(t.key)) setHeardOnRecord((h) => new Set(h).add(t.key));
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
        // QUEUE-DATA-FLOW-001: a re-rank that fails must not cost the queue its top-up further down this chain.
        return sample || !result ? null : api.rerank([...playedRef.current]).catch(() => null);
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
        // QUEUE-KEEP-DISCOVER-001: a skipped song counts too, so skipping through the queue still keeps it growing.
        if (sample || !result || (kind !== 'complete' && kind !== 'skip' && kind !== 'partial')) return;
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
            // QUEUE-HEARD-001: the same listen id the service page used if it already recorded this event.
            instance: engineInstance(ev),
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

  /**
   * REMOVE-X-001 / CAR-X-001: song [k] is taken out while it plays. The next one plays: from the song's own place (it
   * must still be in the list to have one; it is never the answer), else the first one ready in the list; with none,
   * the song stops. Used by the app's X and by the car's X (which names the song the car is playing).
   */
  const leaveSong = (k: string) => {
    const gone = new Set(hidden).add(k);
    const fromHere = stepQueue(activeItems, activeItems.some((x) => x.track.key === k) ? k : null, 1, hidden, queueOpts);
    const after = (fromHere && fromHere.item.track.key !== k ? fromHere : null)
      ?? stepQueue(activeItems.filter((x) => x.track.key !== k), null, 1, gone, queueOpts);
    if (after && (!stepReady || stepReady(after.item.track))) { play(after.item, { newRound: after.wrapped, keepList: true }); return; }
    // CAR-X-001: nothing downloaded yet to move to: the next song in the list still plays (it fetches, then starts), so
    // the X never leaves the removed song playing. Only with no other song at all does it stop.
    const fetchable = stepQueue(activeItems, activeItems.some((x) => x.track.key === k) ? k : null, 1, gone, { ...queueOpts, ready: undefined })
      ?? stepQueue(activeItems.filter((x) => x.track.key !== k), null, 1, gone, { ...queueOpts, ready: undefined });
    if (fetchable && fetchable.item.track.key !== k) { play(fetchable.item, { newRound: fetchable.wrapped, keepList: true }); return; }
    startTokenRef.current++; engineSend({ op: 'pause' }); setPlaying(null);
  };

  /** Explicit judgements teach the same live ranker as listening, without another provider run. */
  const learnFeedback = async (track: Track, kind: FeedbackKind, o?: { fromCar?: boolean }) => {
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
      // REMOVE-X-001 (owner, 2026-11-24: "removing songs / the x button doesnt work"): a dislike takes the row out
      // at once and for this list, played or not. The engine keeps songs already played in its answer (the history is
      // protected), so leaving the removal to the re-rank kept every heard song in the queue, painted red.
      if (kind === 'hide' || kind === 'dislike') setHidden((h) => new Set(h).add(k));
      // The song playing is the one taken out: the next one plays now. The car moves on by itself (CAR-X-001: its
      // service asks with a `leave` command), so a dislike from the car never moves the song twice.
      if (kind === 'dislike' && !o?.fromCar && playing?.track.key === k) leaveSong(k);
      if (kind === 'hide' || kind === 'dislike') {
        // REMOVE-FOREVER-001: the app's own downloaded copy goes too (a copy kept in the Music folder stays).
        const cachedAt = downloadsAvailable() ? queueAudio.sourceHint(track) : null;
        if (cachedAt) void dl.evict(cachedAt).catch(() => undefined);
      }
      if (result?.sample) return;
      const seq = ++rerankSeq.current;
      // MOOD-QUEUE-001: a star or a dislike re-plans the songs to come for the mood.
      // WP5 (S8): and is an active signal, so that next mood answer re-deals the shuffled tail.
      if (kind === 'like' || kind === 'dislike') activeSignalRef.current = { fit: moodFitState?.fit ?? null };
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
    // PLAYLIST-KEEP-001 (owner, 2026-11-23: "the playlist dont load or save the music"): a read that fails (the
    // engine busy at start, a slow answer) is tried again. It used to be shown as an empty Saved and no lists.
    if (tab === 'saved') api.saved().then((r) => setSaved(r.items), () => setSaved((prev) => prev ?? []));
    // The lists are needed on Discover too, for the menu the like button opens.
    if (tab !== 'saved' && tab !== 'discover') return;
    return keepTrying(() => api.playlists(), (r) => setLists(r.lists));
  }, [tab, flags]);

  // CAR-SAVE-HIDDEN-001 (owner, 2026-11-23): while this screen was away the car may have starred songs and added
  // them to playlists; the playback service's engine saves those. Back in front, read the stars again. The lists
  // and Saved follow them (the effect above), so the phone shows what the car did and never hands the car an
  // older set of playlists.
  const queueKeysRef = useRef<string[]>([]);
  useEffect(() => { queueKeysRef.current = (result?.items ?? []).map((x) => x.track.key); }, [result]);
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== 'visible') return;
      // SESSION-RESET-001: back after more than four minutes stopped is a new session.
      if (beginFreshSession(localStorage, Date.now())) {
        setPlays({});
        clearQueueForSession(localStorage, queueKeysRef.current);
      }
      api.feedbackState().then((fb) => {
        const f: Record<string, FeedbackFlags> = {};
        for (const [k, v] of Object.entries(fb.state)) f[k] = { like: v.like, dislike: v.dislike, hide: v.hide, save: v.save };
        setFlags(f);
        setHeardOnRecord(subtractCleared(unionHeard(heardIn(fb.state), startedOnRecord()), clearedKeys(localStorage)));
        if (fb.taste) setTaste(fb.taste);
      }, () => undefined);
    };
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);

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
  /** ALLOWANCE-ARCH-001: fill the background allowance at once (as "Check again" does) and look again. */
  const continueNow = () => {
    void api.health(true).catch(() => undefined).then(() => run(true));
  };
  const sample = Boolean(result?.sample);
  const adventurous = settings?.adventurous ?? 0.5;
  const fresh = settings?.fresh ?? false;
  const queueSize = settings?.queue_size ?? 20;
  // DISCOVER-TIDY-002 (owner): with custom discovery chosen, Find needs no starting song; it runs those choices.
  const customDefaults = { count: queueSize, adventurous };
  const customSet = hasCustomChoices(readCustom(customDefaults));
  const findNext = () => { if (!seeds.length && customSet) void runCustom(readCustom(customDefaults)); else void run(); };
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
        {similarNote && <SimilarNotice note={similarNote} onShow={similarFirstNew.current ? showSimilarSongs : undefined} onClose={() => showSimilarNote(null)} />}
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
                onQueueNext={queueNext}
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
                {/* DISCOVER-QUIET-001 (owner, 2026-11-22): "get rid of labels under a mix of familar and new and the label under
                    prefer new releases button but keep the spacing". The lines keep their room and print nothing. */}
                <p className="go__hint go__gone" aria-hidden="true">
                  Up to {queueSize} new {queueSize === 1 ? 'song' : 'songs'} per discovery — change it in Settings
                </p>
                <label className="go__fresh">
                  <input type="checkbox" checked={fresh} onChange={(e) => patchSettings({ fresh: e.target.checked })} />
                  <span>Prefer new releases</span>
                  <span className="go__freshnote go__gone" aria-hidden="true">songs from the last 60 days, when the source gives a date</span>
                </label>
              </div>
              <div className="go__row">
                {/* DISCOVER-TIDY-001 (owner): one row, Find my next favorite 75% and Customize discovery 25% as an icon. */}
                <div className="go__pair">
                  <button className="push push--default push--big" type="button" disabled={running || !loaded} aria-describedby="go-why" onClick={findNext}>
                    {running ? 'Finding…' : 'Find my next favorite'}
                  </button>
                  <button className="push push--big go__custom" type="button" disabled={!loaded} aria-haspopup="dialog" aria-expanded={customOpen}
                    aria-label="Customize discovery" title="Customize discovery" onClick={() => setCustomOpen(true)}>
                    <Glyph name="eq" size={20} />
                  </button>
                </div>
                {running && (
                  <button className="push push--big" type="button" onClick={cancel}>
                    Stop
                  </button>
                )}
                <span id="go-why" className="go__why" aria-live="polite">
                  {/* NEXT-FAV-COLD-001: when a run had no starting song, the line under the button says what it read. */}
                  {customStatus.text && (customStatus.running || !customOpen) ? customStatus.text : running ? job?.progress : result?.started_from ?? ''}
                </span>
                {customStatus.running && !customOpen && (
                  <button className="push push--big" type="button" onClick={stopCustom}>Stop</button>
                )}
                <CustomDiscovery
                  open={customOpen}
                  onClose={() => setCustomOpen(false)}
                  defaults={customDefaults}
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
              {similarStatus && <p className="state" role="status" aria-live="polite">{similarBusy && <span className="sdot sdot--busy" aria-hidden="true" />} {similarStatus}</p>}
              {runErr && (
                <p className="state state--bad" role="alert">
                  <Glyph name="warning" size={14} /> {runErr}
                </p>
              )}
              {/* ALLOWANCE-SEEN-001 + ALLOWANCE-ARCH-001 (owner, 2026-11-20): only background work waits for the
                  mobile data allowance, which refills by itself and does not apply on Wi-Fi. Say so where the new
                  music would have been, and offer to carry on at once. */}
              {allowanceSpent && !running && (
                <div className="budget-note" role="note" aria-label="Finding new songs is paused">
                  <p className="state">
                    <Glyph name="info" size={14} /> Some sources were skipped to save mobile data. Finding new songs
                    carries on by itself as the allowance refills, and is never limited on Wi-Fi.
                  </p>
                  <button className="push" type="button" onClick={continueNow} aria-label="Continue finding new songs now">
                    Continue now
                  </button>
                </div>
              )}
              {result ? (
                <>
                  {!sample && <ListLoadedNote tracks={queueTracks} />}
                  <div className="queue__head">
                    <h2 id="queue-h">
                      Now playing queue <span className="count">{queueSongCount}</span>
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
                      <TasteSpinner playing={songPlaying} songs={queueSongCount} /> {tasteLine}
                    </p>
                  )}
                  {(result.count - (result.items ?? []).filter(x => expired.has(x.track.key)).length) < result.asked && !sample && (
                    <p className="note">
                      Found {result.count - (result.items ?? []).filter(x => expired.has(x.track.key)).length} songs worth suggesting{result.empty_reason ? ` — ${result.empty_reason}` : '.'} Airwave does not pad the list.
                      {/* NEXT-FAV-COLD-001: a run with no starting song says what it read instead. */}
                      {result.started_from ? ` ${result.started_from}` : ''}
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
                    <Results plays={plays}
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
                  <ListLoadedNote tracks={queueTracks} />
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
                  <Results plays={plays}
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
                  <p>Press “Find my next favorite” and this reads your starred artists, your listening and your sound. Or search for a song you love and press Add to start from it.</p>
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
            // ROW-UNIFY-001: Find similar on a saved song adds to the Discover queue; the outcome shows on the card.
            onSimilar={(t) => void findSimilar(t)}
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
          onPausedChange={(p) => setSongPlaying(!p)}
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
            // PLAYER-SIMILAR-001: the song playing, from any tab; SIMILAR-NOTICE-001 shows the outcome on the card.
            onSimilar: playing ? () => { void findSimilar(playing.track); } : undefined,
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
