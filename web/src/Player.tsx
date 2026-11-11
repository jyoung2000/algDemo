import { useEffect, useRef, useState } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import { ShuffleGlyph } from './icons';
import { api, type ArtistTarget, type Playback, type Track } from './api';
import { ArtistNames } from './ArtistLinks';
import { warmer } from './engine/warm-shell';
import { PREVIEW_ROUTE } from './engine/shape';
import { Art } from './Art';
import { Volume } from './Volume';
import { PlayerActions, type TrackActionProps } from './PlayerActions';
import { Wheel } from './Wheel';
import { loadYouTube, youtubeEmbedUrl, type YTPlayer } from './youtube';
import { attachElement, bus as audioBus, eqConfig, mixSlider, playThrough, resumeEngine, setUnprocessable, subscribeEngine } from './audio-engine';
import { localLibrary, sourceUrlFor } from './engine/local-audio';
import { rescueSource } from './engine/rescue';
import { pickStream } from './engine/stream-pick';
import { startHls } from './engine/hls';
import { downloadsAvailable, playbackActive } from './engine/downloads';
import { mediaNativeAvailable, pushMediaState, setMediaHandlers, songFromTrack } from './engine/media-native';
import { engineAvailable, engineRev, engineSend, engineSong, engineState, markEngineEvent, subscribeEngineState, type EngineState } from './engine/native-engine';
import { queueAudio } from './engine/queue-audio';
import { clearResume, writeResume } from './engine/resume';
import { type DeckId } from './engine/audio-bus';
import { PreviewMixer } from './engine/preview-mixer';
import { COMPLETE_S, ListenMeter, PROVIDER_LABEL, SKIP_MAX_S, SKIP_MIN_S, artistOf, classNames, fmtDuration, isSilent, markKey, qualifiesCompletion, toggleMuteState, type RepeatMode } from './util';

export interface Playing {
  track: Track;
  playback: Playback;
  /**
   * Seconds to start this song at, set only when the app reopens on a song the listener was
   * part-way through (RESUME-001). Consumed once: the deck seeks here on its first load and
   * ordinary plays of the same song start from zero.
   */
  resumeAt?: number;
}

export interface UpNext {
  key: string;
  title: string;
  artist: string;
  artwork?: string | null;
  /**
   * The next song's preview route, when it has one. The mixer needs it before the current song
   * ends: a crossfade means both are audible at once, so the incoming one has to be cued early.
   */
  preview?: string | null;
  /** The song itself, so the lookahead can ask about a full version before cueing a blend. */
  track?: Track;
}

interface Props {
  playing: Playing | null;
  upNext: UpNext[];
  docked: boolean;
  canPrev: boolean;
  canNext: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** Maximum private queue cache, in GB; downloads explicitly kept by the listener are separate. */
  cacheGb?: number;
  /** Like, dislike and download for the song now playing. */
  actions: TrackActionProps;
  onShuffle: () => void;
  onRepeat: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Only real, observed listening: a preview played to its end, or skipped by the user after a short listen.
   *  `meta.instance` is one nonce per loaded playback, so a duplicated end-callback cannot double-record;
   *  a second end of the same instance (loop) arrives as 'replay', later loops are not events at all. */
  onListen: (kind: 'complete' | 'skip' | 'replay', track: Track, listened: number, meta: ListenTelemetry) => void;
  onWheel: (dir: 1 | -1) => void;
  onSelect: () => void;
  onMenu: () => void;
  onPickUpNext: (key: string) => void;
  /** ARTIST-PAGE-001: the full-size player's artist line opens the artist's page. */
  onOpenArtist?: ((t: ArtistTarget) => void) | undefined;
}


/** What the player observed about the playback a listen event came from. */
export interface ListenTelemetry {
  /** One nonce per loaded playback; the same instance never records the same kind twice. */
  instance: string;
  medium: 'full' | 'preview';
  /** Length of what actually played (player-reported, else catalogue), seconds; null = unknown. */
  duration: number | null;
  /** Unique content heard (rewinds do not inflate it), seconds. */
  coverage: number;
}

const VOLUME_KEY = 'airwave.volume';

function loadVolume(): { value: number; muted: boolean } {
  try {
    const v = JSON.parse(window.localStorage.getItem(VOLUME_KEY) ?? 'null') as { value?: unknown; muted?: unknown } | null;
    const value = typeof v?.value === 'number' && v.value >= 0 && v.value <= 1 ? v.value : 0.8;
    return { value, muted: v?.muted === true };
  } catch {
    return { value: 0.8, muted: false };
  }
}

/** The YouTube video id a song plays from, when it already has one. */
function knownVideoId(p: Playing | null): string | null {
  if (!p) return null;
  const e = p.playback.embed;
  if (e?.provider === 'ytmusic') return /\/embed\/([\w-]{11})/.exec(e.url)?.[1] ?? null;
  return p.track.provider === 'ytmusic' ? p.track.platform_id : null;
}

/**
 * FAST-PLAY-001: the verified local link the queue preloader already holds for a song, if any.
 *
 * Owner: "the music on both apps needs to load faster when playing songs from song list". The
 * player asked the source chain for a video id on every play, including for songs the preloader had
 * already resolved AND downloaded — a network round trip in front of audio sitting on disk. The
 * method is read defensively so an older preloader build simply has no fast path.
 */
function readyLocalUrl(track: Track): string | null {
  const probe = queueAudio as { readyUrl?: (t: Track) => string | null };
  return typeof probe.readyUrl === 'function' ? probe.readyUrl(track) ?? null : null;
}

function knownLocalUrl(track: Track): string | null {
  const probe = queueAudio as { sourceHint?: (t: Track) => string | null };
  return typeof probe.sourceHint === 'function' ? probe.sourceHint(track) ?? null : null;
}

/** `local`: the downloaded full song, on a deck — the only full-song path the engine can reach. */
type Mode = 'full' | 'local' | 'preview' | 'embed' | 'none';

/**
 * Now playing. The full song plays in YouTube's own embedded player, which Airwave drives through
 * YouTube's player API (play, pause, seek, volume, progress); the page never downloads that audio.
 * A song with no YouTube Music version falls back to its 30-second Deezer preview in an <audio>
 * element. SoundCloud songs play in SoundCloud's widget, whose progress and volume Airwave cannot reach.
 */
export function Player({ playing, upNext, docked, canPrev, canNext, shuffle, repeat, cacheGb = 1, actions, onShuffle, onRepeat, onPrev, onNext, onListen, onWheel, onSelect, onMenu, onPickUpNext, onOpenArtist }: Props) {
  // Two decks, because a crossfade needs both songs audible at once: the outgoing song keeps
  // playing on its own element while the incoming one starts on the other. Both elements live for
  // the player's lifetime — a MediaElementAudioSourceNode can be made only once per element.
  const deckA = useRef<HTMLAudioElement>(null);
  const deckB = useRef<HTMLAudioElement>(null);
  const [deck, setDeck] = useState<DeckId>('a');
  /** Set when the mixer promotes a song that is ALREADY playing, so the load effect leaves it. */
  const promoted = useRef<string | null>(null);
  const [mixNote, setMixNote] = useState<string | null>(null);
  /** The song the Android engine is blending into right now, as it reports (null when not). */
  const [engineBlend, setEngineBlend] = useState<string | null>(null);
  const [mix, setMix] = useState(mixSlider);
  useEffect(
    () => subscribeEngine(() => setMix(mixSlider())),
    [],
  );
  // The shell's library of downloaded songs, re-read whenever it changes.
  const [libraryTick, setLibraryTick] = useState(0);
  useEffect(() => localLibrary.subscribe(() => setLibraryTick((n) => n + 1)), []);
  const meter = useRef(new ListenMeter());
  const [paused, setPaused] = useState(true);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [vol, setVol] = useState(loadVolume);
  const yt = useRef<YTPlayer | null>(null);
  const [ytReady, setYtReady] = useState(false);
  const ended = useRef(false);
  /** Playhead the resume point was last written at, so `timeupdate` does not write four times a second. */
  const savedAt = useRef(0);
  /**
   * The pending resume playhead, held outside React state because the deck load effect consumes it
   * exactly once: a re-render must not make the song jump back to it a second time.
   */
  const resumeAtRef = useRef<number | null>(playing?.resumeAt ?? null);
  const resumeKey = useRef<string | null>(playing?.resumeAt ? playing.track.key : null);
  if (playing?.resumeAt && resumeKey.current !== playing.track.key) {
    resumeKey.current = playing.track.key;
    resumeAtRef.current = playing.resumeAt;
  }
  const instance = useRef('');
  const endsThisInstance = useRef(0);
  const volRef = useRef(vol);
  volRef.current = vol;
  const lastLevel = useRef(vol.value);
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const onEndRef = useRef<(engineHeard?: number) => void>(() => undefined);
  const key = playing?.track.key ?? null;
  /**
   * Inside the Android app the service's native engine plays (plan ruling 2026-11-08): this page
   * chooses the song and what follows, and mirrors what the engine reports. The two <audio> decks
   * below stay silent there, so there is never double audio.
   */
  const native = engineAvailable();
  const onEngineRef = useRef<(s: EngineState) => void>(() => undefined);

  // `audio` is the deck playing now, so every existing use of it still means "the current element".
  // The mixer owns which deck that is: after a blend the incoming deck becomes the current one.
  const audio = deck === 'a' ? deckA : deckB;
  const mixer = useRef<PreviewMixer | null>(null);
  if (!mixer.current)
    mixer.current = new PreviewMixer(
      // Getters, because the elements do not exist on the first render but the mixer does.
      {
        get a() {
          return deckA.current as HTMLAudioElement;
        },
        get b() {
          return deckB.current as HTMLAudioElement;
        },
      },
      audioBus,
      (route) => (route.startsWith(PREVIEW_ROUTE) ? api.previewUrl(route).then((r) => r.url) : Promise.resolve(route)),
      setMixNote,
    );

  // Which source plays. A song with no YouTube video yet is looked up once; only a confident match is used.
  const knownId = knownVideoId(playing);
  const scEmbed = playing?.playback.embed?.provider === 'soundcloud' ? playing.playback.embed : null;
  const [found, setFound] = useState<{ key: string; id: string | null; url?: string } | null>(null);
  // STREAM-DL-001: this song's stream from its source while its download runs (engine/stream-pick.ts).
  const [streamOf, setStreamOf] = useState<{ key: string; url: string | null; started: boolean; failed: boolean; hls?: boolean } | null>(null);
  const [badVideo, setBadVideo] = useState<string | null>(null);
  const previewSrc = playing?.playback.preview ?? null;
  // Songs the mixer blended into. They are already playing, as the preview they were blended as,
  // so they must not be looked up on YouTube: the lookup leaves `src` null while it runs, which
  // tore down the very deck the blend had just handed over, and a late video id would replace a
  // song mid-play with an iframe starting from zero.
  const previewOnly = useRef(new Set<string>());
  const cuedSources = useRef(new Map<string, string>());
  /**
   * The full song always wins. An earlier version preferred the 30-second preview while the
   * mixer was on, because only a preview can be routed through the mixer; the owner rejected
   * that trade ("both softwares should play the full song not a 30 second preview"). So the
   * mixer reaches only the songs that have no full version, and says so.
   */
  const stayPreview = !downloadsAvailable() && key !== null && previewOnly.current.has(key);
  const promotedSource = key ? cuedSources.current.get(key) ?? null : null;
  // FAST-PLAY-001: a song whose file the queue already holds needs no resolution at all.
  const readySource = playing && downloadsAvailable() ? readyLocalUrl(playing.track) : null;
  // A previously verified link is worth a direct native disk check on cold start. It is NOT
  // considered ready for shuffle until that check succeeds; don't repeat a catalog search first.
  const hintedSource = playing && downloadsAvailable() && !readySource ? knownLocalUrl(playing.track) : null;
  const needsLookup = Boolean(playing && !knownId && !promotedSource && !readySource && !hintedSource && (!scEmbed || downloadsAvailable())) && !stayPreview;
  const lookedUp = found?.key === key;
  const lookingUp = needsLookup && !lookedUp;
  const candidate = stayPreview ? null : knownId ?? (lookedUp ? found.id : null);
  const videoId = candidate && candidate !== badVideo ? candidate : null;
  // In the installed apps, every added/discovered song is a full local file. A search preview
  // may still be remote, but the Now Playing queue never substitutes it or an iframe for a song.
  const canLocal = downloadsAvailable();
  const wantSource = canLocal && videoId ? sourceUrlFor(videoId) : null;
  const foundSource = canLocal && lookedUp ? found?.url ?? null : null;
  // Once this song has started in YouTube's player it stays there: a download finishing mid-song
  // must not swap players and restart it at 0:00. The file is for next time and for the lookahead.
  const inYouTube = useRef<string | null>(null);
  const latched = inYouTube.current === key;
  /**
   * NP-ALWAYS-001. Owner's screenshot: "No player here for this song. Open it in its app.", with no
   * progress bar and a dead play button, on a song that was carrying a YouTube Music link all
   * along. YouTube's iframe refuses plenty of videos (embedding off, an age gate, a region) and
   * Deezer has no preview for everything — but both shells carry yt-dlp, so there is one more
   * thing to try before sending a listener elsewhere: download the song and play it here.
   *
   * It runs only where the song would otherwise be silent, so listening to a playable song still
   * downloads nothing the listener did not ask for — that is what `local_mix` is for.
   */
  const previewPick = !canLocal && !videoId && !lookingUp ? previewSrc : null;
  const embedPick = !canLocal && !videoId && !previewPick && !lookingUp ? scEmbed : null;
  const stranded = !videoId && !foundSource && !previewPick && !embedPick && !lookingUp;
  const rescue = stranded
    ? rescueSource({
        badVideoId: badVideo,
        links: playing?.playback.open.length ? playing.playback.open : playing?.track.url ? [{ url: playing.track.url }] : [],
        shell: canLocal,
      })
    : null;
  const localSource = promotedSource ?? readySource ?? hintedSource ?? wantSource ?? foundSource ?? rescue;
  const nextTrackForCache = upNext[0]?.track;
  const upcomingSource = nextTrackForCache?.provider === 'ytmusic' ? sourceUrlFor(nextTrackForCache.platform_id) : null;
  const localStatus = localSource ? localLibrary.status(localSource) : 'missing';
  // In the Android app the engine reads the file itself, so the page only needs to know it is held;
  // fetching it into a Blob as the <audio> deck needs would read every song twice.
  const localSrc = localSource && !latched
    ? native ? (localLibrary.status(localSource) === 'ready' ? localSource : null) : localLibrary.src(localSource)
    : null;

  // Once the whole song is on disk, let the model hear it (FULL-SONG-EMBED-001). The listener is
  // already listening, so nothing is waiting on this; it is fire-and-forget, costs no transfer
  // allowance, and the engine answers "already" rather than re-running for a song played twice.
  const embeddedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!canLocal || !localSrc || !localSource || !playing) return;
    const k = playing.track.key;
    if (!k || embeddedRef.current.has(k)) return;
    embeddedRef.current.add(k);
    void api.embedLocal(playing.track, localSource).catch(() => embeddedRef.current.delete(k));
  }, [canLocal, localSrc, localSource, playing]);

  // FAST-PLAY-002: the song queued next is the one most likely to be pressed, so its source file is
  // named while the current song plays. Next then starts at once instead of waiting for yt-dlp.
  useEffect(() => {
    if (!nextTrackForCache) return;
    warmer().warm(nextTrackForCache);
  }, [nextTrackForCache]);

  useEffect(() => {
    if (!canLocal) return;
    const protectedUrls = [localSource, upcomingSource].filter((u): u is string => Boolean(u));
    localLibrary.protect(protectedUrls);
    void queueAudio.protect(cacheGb, protectedUrls).then(() => {
      if (localSource && playing) void localLibrary.ensure(localSource, `${playing.track.title} — ${playing.track.artist}`, true);
    }).catch((e) => setErr(`Queue cache: ${(e as Error).message}`));
  }, [canLocal, localSource, upcomingSource, cacheGb, key]);
  useEffect(() => {
    if (!localSource || !playing || canLocal) return;
    void localLibrary.ensure(localSource, `${playing.track.title} — ${playing.track.artist}`, true);
  }, [localSource, playing, canLocal]);
  const askingLocal = localSource !== null && !latched && (localStatus === 'unknown' || (localStatus === 'ready' && localSrc === null));
  const fetchingLocal = canLocal && localSource !== null && localStatus === 'running';
  const localError = localSource !== null && localStatus === 'missing' ? localLibrary.error(localSource) : null;
  // STREAM-DL-001: the song plays from its source while it downloads, on this page's own deck (the
  // Android engine streams for itself). Whichever is playable first wins; a stream that has started
  // plays to the end, since moving to the file then would restart the song.
  // Only what the deck reported is kept (it started; it failed); the choice itself is worked out here.
  // YouTube's own player is never used where songs download, so a stream never meets it.
  const streamNow = streamOf?.key === key ? streamOf : null;
  const streamSrc = native || !key ? null : streamNow?.hls && !streamNow.failed ? (streamNow.started || !localSrc ? streamNow.url : null) : pickStream({ canStream: canLocal && localLibrary.canStream(), source: localSource, localStatus, localSrc, current: streamNow });
  // In the Android app the engine streams for itself and says so in its state.
  const [engineStreams, setEngineStreams] = useState<string | null>(null);
  const streaming = Boolean(streamSrc) || (native && engineStreams !== null && engineStreams === key);
  // A downloadable full song never silently turns into a short catalogue preview.
  const src = streamSrc ?? localSrc ?? (canLocal ? null : previewPick);
  const embed = embedPick;
  const mode: Mode = localSrc || streaming ? 'local' : canLocal ? 'none' : askingLocal || fetchingLocal ? 'none' : videoId ? 'full' : src ? 'preview' : embed ? 'embed' : 'none';
  const hasSound = mode === 'full' || mode === 'local' || mode === 'preview';
  const onDeck = mode === 'local' || mode === 'preview';
  const pending = lookingUp || ((askingLocal || fetchingLocal) && !streaming);

  useEffect(() => {
    if (!playing || !needsLookup) return;
    let live = true;
    api
      .fullSong(playing.track)
      .then((r) => live && setFound({ key: playing.track.key, id: r.id, url: r.url }))
      .catch(() => live && setFound({ key: playing.track.key, id: null }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, needsLookup]);

  useEffect(() => {
    setBadVideo(null);
  }, [key]);

  // Volume and mute reach whichever source is playing, and are remembered.
  useEffect(() => {
    try {
      window.localStorage.setItem(VOLUME_KEY, JSON.stringify(vol));
    } catch {
      /* private mode: the volume just is not remembered */
    }
    if (vol.value > 0) lastLevel.current = vol.value;
    const silent = isSilent(vol);
    // Both decks, not just the current one: during a blend the incoming song is already audible,
    // and leaving it at full level would make every transition jump in loudness.
    for (const el of [deckA.current, deckB.current]) {
      if (!el) continue;
      el.volume = vol.value;
      el.muted = silent;
    }
    const p = yt.current;
    if (p && ytReady) {
      // YouTube's player ignores a volume of 0 (it stays at about 5%), so slider 0 is a mute.
      p.setVolume(Math.max(1, Math.round(vol.value * 100)));
      if (silent) p.mute();
      else p.unMute();
    }
  }, [vol, ytReady, src]);

  // The YouTube player for the current video: events in, controls out. The iframe belongs to React and is
  // replaced when the video changes, so the player object is only dropped here, never destroyed.
  const ytVideoId = mode === 'full' ? videoId : null;
  if (ytVideoId) inYouTube.current = key;
  useEffect(() => {
    yt.current = null;
    setYtReady(false);
    if (!ytVideoId) return;
    const videoId = ytVideoId;
    let live = true;
    let timer = 0;
    void loadYouTube()
      .then((YT) => {
        const frame = document.getElementById('yt-frame') as HTMLIFrameElement | null;
        if (!live || !frame) return;
        const p: YTPlayer = new YT.Player(frame, {
          events: {
            onReady: () => {
              if (!live) return;
              yt.current = p;
              setYtReady(true);
              timer = window.setInterval(() => {
                const c = p.getCurrentTime();
                const d = p.getDuration();
                setCur(c);
                if (d > 0) setDur(d);
                meter.current.tick(c, p.getPlayerState() === 1);
              }, 500);
            },
            onStateChange: (e) => {
              if (!live) return;
              if (e.data === 1) {
                setPaused(false);
                setLoading(false);
                ended.current = false;
              } else if (e.data === 2) setPaused(true);
              else if (e.data === 3) setLoading(true);
              else if (e.data === 0) {
                ended.current = true;
                setPaused(true);
                onEndRef.current();
              }
            },
            onError: () => live && setBadVideo(videoId),
          },
        });
        setLoading(true);
      })
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : 'The YouTube player could not be loaded.'));
    return () => {
      live = false;
      window.clearInterval(timer);
      yt.current = null;
    };
  }, [ytVideoId]);

  useEffect(() => {
    meter.current = new ListenMeter();
    ended.current = false;
    instance.current = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    endsThisInstance.current = 0;
    setCur(0);
    setDur(0);
    setErr(null);
    setPaused(true);
    if (native) {
      if (!playing) return;
      const song = engineSong(playing.track, Boolean(src), localSource);
      const st = engineState();
      if (st && st.id === key) {
        // The engine already plays this song: it advanced or blended into it itself, or the app
        // reopened on it. Mirror it; reloading would restart it and throw away the overlap.
        resumeAtRef.current = null;
        setPaused(!st.playWhenReady);
        setLoading(st.buffering);
        setCur(st.positionMs / 1000);
        if (st.durationMs > 0) setDur(st.durationMs / 1000);
        meter.current.seeked(st.positionMs / 1000);
        return;
      }
      const at = resumeAtRef.current;
      resumeAtRef.current = null;
      if (at && at > 0) savedAt.current = at;
      setLoading(true);
      // No file yet: the engine shows this song as loading and starts it when the file is sent.
      engineSend({ op: 'load', song, positionMs: Math.round(Math.max(0, at ?? 0) * 1000), play: true, rev: engineRev() });
      return;
    }
    const a = audio.current;
    if (!a) return;
    if (src) {
      // The mixer already blended into this song on this deck, and it is playing. Reassigning src
      // would restart it from zero and throw away the overlap the listener just heard.
      if (promoted.current === key) {
        promoted.current = null;
        setLoading(false);
        setPaused(a.paused);
        setDur(a.duration || 0);
        setCur(a.currentTime);
        meter.current.seeked(a.currentTime);
        return;
      }
      setLoading(true);
      // The catalogue holds a stable route, not a playable address: Deezer signs its preview URLs for
      // about fifteen minutes, so one is fetched now. A late answer for a song the user has already
      // moved past must not take over the element, hence the live check.
      let live = true;
      const begin = (url: string) => {
        if (!live || audio.current !== a) return;
        a.src = url;
        // Reopened on a song that was part-way through: pick it up where it stopped (RESUME-001).
        // Seeking before play() works even before metadata arrives on a local file, and a failed
        // seek must not stop the song from starting.
        const at = resumeAtRef.current;
        if (at && at > 0) {
          resumeAtRef.current = null;
          savedAt.current = at;
          const seekOnce = () => {
            try {
              a.currentTime = at;
            } catch {
              /* the song just starts from the beginning */
            }
          };
          if (a.readyState >= 1) seekOnce();
          else a.addEventListener('loadedmetadata', seekOnce, { once: true });
        }
        a.play().catch(() => {
          // Autoplay can be refused; the user presses play. Not an error and not a skip.
          setLoading(false);
          setPaused(true);
        });
      };
      if (src.startsWith(PREVIEW_ROUTE)) {
        api.previewUrl(src).then(
          (r) => begin(r.url),
          (e: unknown) => {
            if (!live) return;
            setLoading(false);
            setPaused(true);
            setErr(e instanceof Error && e.message ? e.message : 'This preview could not be reached.');
          },
        );
      } else if (streamNow?.hls && streamSrc && localSource && key) {
        // A progressive stream was unavailable: attach HLS to the SAME permanent audio deck.
        // No blob/second element is created, so seeking, progress, WebAudio and mixer remain intact.
        return startHls(a, localSource, () => setStreamOf({ key, url: null, started: false, failed: true }));
      } else begin(src);
      return () => {
        live = false;
      };
    } else {
      a.pause();
      a.removeAttribute('src');
      a.load();
      setPaused(true);
    }
  }, [key, src]);

  // The mixing graph is built only once the listener asks for it. Routing an element through Web
  // Audio lasts for that element's life, so an unwanted graph is not worth creating; and both
  // decks must be routed, not just the current one, or the incoming song arrives unprocessed.
  const wantGraph = !native && (mix > 0 || canLocal);
  useEffect(() => {
    if (!wantGraph) return;
    attachElement(deckA.current, 'a');
    attachElement(deckB.current, 'b');
    resumeEngine();
  }, [wantGraph]);

  // A song playing inside YouTube's or SoundCloud's own player cannot be processed or blended.
  // Saying so is the difference between an honest control and one that looks broken.
  useEffect(() => {
    setUnprocessable(mode === 'full' || mode === 'embed' ? 'iframe-playback' : null);
  }, [mode]);

  // Cue the next song while this one still plays: an overlap needs both loaded and decoded.
  //
  // Repeating one song is not a next song. Observed on the real app with repeat set to "this
  // song": the mixer cued the next preview and blended twelve audible seconds of it before the
  // repeat branch cancelled the blend and restarted the current song, so the listener heard the
  // next song fade in and then get yanked. The queue still reports a lookahead in that mode, so
  // the player has to be the one to say there is nothing to blend into.
  //
  // And it asks first. A blended-in song keeps playing as the preview it was blended as, so the
  // mixer must never cue a song that has a full version — that song is owed its full version in
  // YouTube's player. The lookahead resolves the next song the same way the player would, and
  // only cues one YouTube knows nothing about.
  const nextKey = upNext[0]?.key ?? null;
  const nextPreview = upNext[0]?.preview ?? null;
  const nextTrack = upNext[0]?.track ?? null;
  const repeatingOne = repeat === 'one';
  // A held full song is cued as the next deck (LOCAL-AUDIO-001): the blend lands on the whole
  // song. One the shell does not hold yet is downloaded now, so it is there by the time this song
  // ends — and if it is not, that song plays whole in YouTube's player, with no blend.
  const nextKnownId = nextTrack?.provider === 'ytmusic' && /^[A-Za-z0-9_-]{11}$/.test(nextTrack.platform_id ?? '') ? nextTrack.platform_id : null;
  // One song of lookahead regardless of the crossfader position. Never fetch the entire discovery
  // list: the private disk cache is bounded and a changing queue cancels this intent naturally.
  useEffect(() => {
    if (!canLocal || !nextTrack || repeatingOne) return;
    let live = true;
    void (nextKnownId ? Promise.resolve({ id: nextKnownId }) : api.fullSong(nextTrack)).then((match) => {
      if (!live) return;
      const source = sourceUrlFor(match.id) || rescueSource({ links: nextTrack.url ? [{ url: nextTrack.url }] : [], shell: true });
      if (!source) return;
      const protectedUrls = [localSource, source].filter((u): u is string => Boolean(u));
      localLibrary.protect(protectedUrls);
      void queueAudio.protect(cacheGb, protectedUrls).then(() => localLibrary.ensure(source, `${nextTrack.title} — ${nextTrack.artist}`, false, true)).catch(() => undefined);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [canLocal, nextKey, nextKnownId, repeatingOne, cacheGb, localSource]);
  // The engine is told what comes next as soon as its file is here: it blends into it with the
  // mixer on, and with the mixer off still starts it the moment this song ends, page or no page.
  const nextReady = native && nextTrack && !repeatingOne ? readyLocalUrl(nextTrack) : null;
  useEffect(() => {
    if (!native) return;
    engineSend({ op: 'cue', song: nextTrack && nextReady ? songFromTrack(nextTrack, true, nextReady) : null });
    // libraryTick: the next song's download finishing makes it ready to cue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, key, nextKey, nextReady, repeatingOne, mix, libraryTick]);
  useEffect(() => {
    if (native) return;
    if (mix <= 0 || !onDeck || !nextKey || repeatingOne) {
      mixer.current?.cancel();
      setMixNote(repeatingOne && mix > 0 ? 'Repeating this song — nothing to blend into.' : null);
      return;
    }
    let live = true;
    const cuePreview = () => {
      if (!live) return;
      if (canLocal) {
        mixer.current?.cancel();
        setMixNote('Waiting for the next full song to download — no preview blend.');
      } else void mixer.current?.prepare({ key: nextKey, preview: nextPreview });
    };
    const cueFull = (source: string | null) => {
      if (!canLocal || !source) {
        mixer.current?.cancel();
        setMixNote('Next song has a full version, so it will play whole — no blend.');
        return;
      }
      cuedSources.current.set(nextKey, source);
      if (cuedSources.current.size > 4) cuedSources.current.delete(cuedSources.current.keys().next().value as string);
      const label = nextTrack ? `${nextTrack.title} — ${nextTrack.artist}` : nextKey;
      void localLibrary.ensure(source, label, false, true).then(() => {
        if (!live) return;
        const ready = localLibrary.src(source);
        if (ready) void mixer.current?.prepare({ key: nextKey, preview: ready });
        else {
          mixer.current?.cancel();
          setMixNote(localLibrary.status(source) === 'running' ? 'Downloading the next song so it can be blended in…' : 'Next song has a full version, so it will play whole — no blend.');
        }
      });
    };
    if (nextKnownId) {
      cueFull(sourceUrlFor(nextKnownId));
      return () => {
        live = false;
      };
    }
    if (!nextTrack) {
      cuePreview();
      return;
    }
    setMixNote('Checking the next song for a full version…');
    api
      .fullSong(nextTrack)
      .then((r) => {
        if (!live) return;
        if (r.id) cueFull(sourceUrlFor(r.id));
        else if (canLocal && nextTrack.url) cueFull(rescueSource({ links: [{ url: nextTrack.url }], shell: true }));
        else cuePreview();
      })
      .catch(() => cuePreview());
    return () => {
      live = false;
    };
    // libraryTick: a download finishing re-runs this so the song is cued once it is held.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mix, onDeck, nextKey, nextPreview, nextTrack, nextKnownId, repeatingOne, canLocal, libraryTick]);

  const toggle = () => {
    if (canLocal && localSource && localStatus === 'missing') {
      void localLibrary.retry(localSource, `${playing?.track.title ?? 'Song'} — ${playing?.track.artist ?? ''}`);
      return;
    }
    if (native) {
      if (!playing) return;
      engineSend({ op: paused ? 'play' : 'pause' });
      setPaused(!paused);
      return;
    }
    if (mode === 'full') {
      const p = yt.current;
      if (!p) return;
      if (p.getPlayerState() === 1) p.pauseVideo();
      else p.playVideo();
      return;
    }
    const a = audio.current;
    if (!a || !src) return;
    // A browser only lets an AudioContext run from a gesture, and this is one.
    resumeEngine();
    if (a.paused) void a.play().catch(() => setErr('This preview could not start.'));
    else a.pause();
  };

  const seek = (s: number) => {
    // A blend in flight is tied to the outgoing playhead; moving it would leave the two songs
    // overlapping on the wrong beats, so the blend is dropped and this song continues alone.
    mixer.current?.cancel();
    if (native) engineSend({ op: 'seek', positionMs: Math.round(Math.max(0, s) * 1000) });
    else if (mode === 'full') yt.current?.seekTo(s, true);
    else if (audio.current) audio.current.currentTime = s;
    meter.current.seeked(s);
    setCur(s);
    if (mediaNativeAvailable()) pushMediaState({ positionMs: Math.round(Math.max(0, s) * 1000) });
  };

  // A song that plays to its end counts as listened; then the next one starts. A second end of the
  // same playback instance is one replay; beyond that, loops teach nothing new and record nothing.
  /**
   * A song that played to its end counts as listened (first end) or replayed (second end).
   * [engineHeard] is what the Android engine heard of it, in seconds: this page may have been asleep
   * or opened part-way through, so its own meter can be short of what the listener heard.
   */
  const recordEnd = (engineHeard = 0) => {
    // The place is spent: this song finished, so reopening the app must not return to it.
    clearResume();
    savedAt.current = 0;
    const duration = dur > 0 ? Math.round(dur) : playing?.track.duration ?? null;
    const l = Math.max(meter.current.listened, engineHeard);
    const coverage = Math.max(meter.current.coverage, Math.min(engineHeard, duration ?? engineHeard));
    const medium = mode === 'full' || mode === 'local' ? 'full' : 'preview';
    if (playing && l >= COMPLETE_S && qualifiesCompletion(medium, coverage, duration)) {
      const meta: ListenTelemetry = {
        instance: instance.current,
        medium,
        duration,
        coverage,
      };
      const n = ++endsThisInstance.current;
      if (n === 1) onListen('complete', playing.track, l, meta);
      else if (n === 2) onListen('replay', playing.track, l, meta);
    }
  };
  onEndRef.current = (engineHeard?: number) => {
    recordEnd(engineHeard);
    if (repeatRef.current === 'one') {
      // Repeating this song means there is no next song to blend into.
      mixer.current?.cancel();
      // Play this song again. The next end of the same playback counts as a replay (see above), not a new listen.
      meter.current.seeked(0);
      ended.current = false;
      setCur(0);
      if (native) {
        // The engine has ended this song; play starts it again from the top.
        engineSend({ op: 'play' });
      } else if (mode === 'full') {
        yt.current?.seekTo(0, true);
        yt.current?.playVideo();
      } else if (audio.current) {
        audio.current.currentTime = 0;
        void audio.current.play().catch(() => setPaused(true));
      }
      return;
    }
    // If a blend ran, the next song is already playing on the other deck. Hand the deck over so
    // the load effect leaves it running instead of restarting it from zero.
    const blended = mixer.current?.finish() ?? null;
    if (blended) {
      promoted.current = blended.key;
      // Remember before onNext: the re-render that makes this song current happens immediately,
      // and it must already know not to look the song up or reload it.
      previewOnly.current.add(blended.key);
      if (previewOnly.current.size > 8) previewOnly.current.delete(previewOnly.current.values().next().value as string);
      ended.current = false;
      setDeck(blended.deck);
    }
    if (canNext) onNext();
    else if (blended) mixer.current?.cancel();
  };

  const next = () => {
    // The listener chose to move on: whatever was cued or blending is no longer what comes next.
    mixer.current?.cancel();
    const l = meter.current.listened;
    if (playing && hasSound && !ended.current && l >= SKIP_MIN_S && l < SKIP_MAX_S)
      onListen('skip', playing.track, l, {
        instance: instance.current,
        medium: mode === 'full' || mode === 'local' ? 'full' : 'preview',
        duration: dur > 0 ? Math.round(dur) : playing.track.duration ?? null,
        coverage: meter.current.coverage,
      });
    onNext();
  };

  const t = playing?.track;
  const transport = (
    <div className="transport" role="group" aria-label="Playback">
      <button
        className={classNames('tbtn', 'tbtn--mode', shuffle && 'is-on')}
        type="button"
        onClick={onShuffle}
        aria-pressed={shuffle}
        aria-label="Shuffle"
        title={shuffle ? 'Shuffle is on: songs play in a random order' : 'Shuffle is off'}
      >
        <ShuffleGlyph size={16} />
      </button>
      <button className="tbtn" type="button" onClick={onPrev} disabled={!canPrev} aria-label="Previous song">
        <Glyph name="previous" size={16} />
      </button>
      <button
        className="tbtn tbtn--main"
        type="button"
        onClick={toggle}
        disabled={mode === 'full' ? !ytReady : !src && !(canLocal && localSource && localStatus === 'missing')}
        aria-label={canLocal && localSource && localStatus === 'missing' ? 'Retry full-song download' : paused ? 'Play' : 'Pause'}
        title={hasSound ? undefined : localError ?? (lookingUp ? 'Finding the full song…' : 'Waiting for a local full song')}
      >
        <Glyph name={paused ? 'play' : 'pause'} size={18} />
      </button>
      <button className="tbtn" type="button" onClick={next} disabled={!canNext} aria-label="Next song">
        <Glyph name="next" size={16} />
      </button>
      <button
        className={classNames('tbtn', 'tbtn--mode', repeat !== 'off' && 'is-on')}
        type="button"
        onClick={onRepeat}
        aria-label={repeat === 'one' ? 'Repeat: this song' : repeat === 'all' ? 'Repeat: the whole list' : 'Repeat: off'}
        title={repeat === 'one' ? 'Repeating this song' : repeat === 'all' ? 'Repeating the whole list' : 'Repeat is off'}
      >
        <Glyph name={repeat === 'one' ? 'repeat-one' : 'repeat'} size={16} />
      </button>
    </div>
  );

  const total = dur || playing?.track.duration || (mode === 'preview' ? 30 : 0);
  /*
   * NP-ALWAYS-001: the bar belongs to the song, not to whether this app can play it. A strip with
   * no bar read as broken; a bar at 0:00 that cannot be dragged, with the reason in words under
   * it, reads as what it is.
   */
  const progress = playing ? (
    <div className="prog">
      <span className="prog__t">{fmtDuration(cur) || '0:00'}</span>
      <input
        className="prog__bar"
        type="range"
        min={0}
        max={total || 1}
        step={0.1}
        value={Math.min(cur, total || 1)}
        disabled={!hasSound || (mode === 'full' && !ytReady)}
        aria-label={mode === 'preview' ? 'Position in the preview' : 'Position in the song'}
        aria-valuetext={`${fmtDuration(cur) || '0:00'} of ${fmtDuration(total) || '0:00'}`}
        style={{ ['--pct' as string]: `${total ? (cur / total) * 100 : 0}%` }}
        onChange={(e) => seek(Number(e.target.value))}
      />
      <span className="prog__t">{fmtDuration(total || null)}</span>
    </div>
  ) : null;

  const volume = playing ? (
    <Volume
      value={vol.value}
      muted={isSilent(vol)}
      disabled={mode === 'embed' || mode === 'none'}
      disabledReason="SoundCloud’s player has its own volume control."
      onChange={(v) => setVol({ value: v, muted: false })}
      onToggleMute={() => setVol((x) => toggleMuteState(x, lastLevel.current))}
    />
  ) : null;

  // What the mixer is doing, in the listener's words — and it takes the *place* of the preview
  // note rather than stacking under it. Two grey lines under the artist made the strip forty
  // pixels taller and read as clutter; and while the mixer is on, a preview is playing *because*
  // of the mixer, so "no full version was found" would be the wrong explanation anyway.
  // No glyph: a 12px shuffle mark read as a stray "x" beside the sentence.
  // In the Android app the note follows from what the engine has been given, and a blend is what
  // the engine says it is doing; elsewhere the page's own mixer sets both.
  const nativeNote = !native || mix <= 0 ? null
    : repeatingOne ? 'Repeating this song — nothing to blend into.'
    : nextTrack && !nextReady ? 'Downloading the next song so it can be blended in…'
    : null;
  const note = native ? nativeNote : mixNote;
  const blending = native ? Boolean(playing && mix > 0 && engineBlend) : playing && mix > 0 && onDeck && Boolean(mixNote);

  const status = !playing ? null : err ? (
    <p className="np__note np__note--bad">
      <Glyph name="warning" size={12} /> {err}
    </p>
  ) : pending ? (
    <p className="np__note">
      {askingLocal ? 'Loading the full song…' : fetchingLocal ? 'Downloading the full song to the player…' : 'Finding the full song…'}
    </p>
  ) : mode === 'full' ? (
    <p className="np__note">
      {loading ? 'Loading the full song…' : localStatus === 'running' ? 'Full song in YouTube’s player while this app downloads it for the equaliser and mixer.' : 'Full song, played by YouTube’s own player.'}
    </p>
  ) : blending ? (
    <p className="np__note np__note--mix" aria-live="polite">{note}</p>
  ) : mode === 'local' && streaming ? (
    <p className="np__note">{loading ? 'Starting the full song from its source…' : localStatus === 'ready' ? 'Full song from its source — through the equaliser and mixer. Download finished.' : 'Full song, streaming from its source while it downloads — through the equaliser and mixer.'}</p>
  ) : mode === 'local' ? (
    <p className="np__note">{loading ? 'Loading the full song…' : 'Full song, downloaded — through the equaliser and mixer.'}</p>
  ) : src ? (
    <p className="np__note">
      {loading ? 'Loading the preview…' : badVideo ? '30-second preview from Deezer: YouTube won’t play the full song here.' : '30-second preview from Deezer: no full version was found.'}
    </p>
  ) : embed ? (
    <p className="np__note">Playing in the {PROVIDER_LABEL[embed.provider]} player. Airwave can’t see its progress or volume, so it records nothing about this listen.</p>
  ) : rescue === null && !canLocal ? (
    <p className="np__note">No player here for this song. Open it in its app.</p>
  ) : canLocal ? (
    <p className="np__note np__note--bad">
      <Glyph name="warning" size={12} /> {localSource ? `Could not load the full song${localError ? `: ${localError}` : '.'} Press play to retry.` : 'No downloadable full recording was found for this song.'}
    </p>
  ) : (
    <p className="np__note np__note--bad">
      <Glyph name="warning" size={12} /> This song could not be downloaded here. Open it in its app.
    </p>
  );

  const openLinks = playing && (
    <div className="np__open">
      {/* Each link shows its service's mark and name with ↗ after it — the arrow reads as "opens
          elsewhere" without a verb, where an 11px link glyph read as a stray "x". Two full "Open in …" pills did not fit the desktop
          bar's right column, and a shared "Open in" caption read as an orphaned word. The full
          label stays as the accessible name. */}
      {(playing.playback.open.length ? playing.playback.open : t?.url ? [{ provider: t.provider, label: `Open in ${PROVIDER_LABEL[t.provider] ?? t.provider}`, url: t.url }] : []).map((o) => (
        <a key={o.provider} className="openlink" href={o.url} target="_blank" rel="noreferrer noopener" aria-label={o.label}>
          <ProviderMark provider={markKey(o.provider)} size={13} /> {o.label.replace(/^Open in\s+/i, '')}<span className="openlink__out" aria-hidden="true">↗</span>
        </a>
      ))}
    </div>
  );

  const syncPlayback = () => queueMicrotask(() => {
    const active = (deckA.current && !deckA.current.paused) ? deckA.current : (deckB.current && !deckB.current.paused) ? deckB.current : null;
    const playingNow = Boolean(active);
    playbackActive(playingNow, playing?.track.title);
    // MEDIA-NATIVE-001: keep the native session's play/pause + playhead in step with the deck.
    if (mediaNativeAvailable()) {
      const el = active ?? deckA.current ?? deckB.current;
      pushMediaState({
        playing: playingNow,
        positionMs: Math.round(((el?.currentTime ?? cur) || 0) * 1000),
        durationMs: el && el.duration > 0 ? Math.round(el.duration * 1000) : (dur > 0 ? Math.round(dur * 1000) : -1),
      });
    }
  });
  useEffect(() => () => playbackActive(false), []);
  useEffect(() => {
    if (!native) return;
    return subscribeEngineState((st) => onEngineRef.current(st));
  }, [native]);
  // The engine is waiting for this song: hand it the download link as soon as the page learns it
  // (a lookup can find it after the song was chosen), and again once the file is held. The service
  // also watches for the file itself, because this page may be asleep when it lands.
  const heldNow = Boolean(src);
  useEffect(() => {
    if (!native || !playing || !localSource) return;
    const st = engineState();
    if (st?.id !== key || !st.waiting) return;
    engineSend({ op: 'load', song: engineSong(playing.track, heldNow, localSource), positionMs: st.positionMs, play: st.playWhenReady, rev: engineRev() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [native, key, localSource, heldNow]);
  // The engine's sound follows this app's controls: the EQ, the mixer, how much of each song plays
  // before it blends, and the volume.
  useEffect(() => {
    if (!native) return;
    const push = () => engineSend({ op: 'settings', eq: eqConfig(), mix: mixSlider(), playThrough: playThrough() });
    push();
    return subscribeEngine(push);
  }, [native]);
  useEffect(() => {
    if (native) engineSend({ op: 'settings', volume: isSilent(vol) ? 0 : vol.value });
  }, [native, vol]);
  // MEDIA-NATIVE-001: the lock screen, Bluetooth and Android Auto drive play/pause/seek through here.
  useEffect(() => {
    if (!mediaNativeAvailable()) return;
    const isPlayingNow = () => native ? !paused : mode === 'full' ? yt.current?.getPlayerState() === 1 : Boolean(audio.current && !audio.current.paused);
    setMediaHandlers({
      play: () => { if (!isPlayingNow()) toggle(); },
      pause: () => { if (isPlayingNow()) toggle(); },
      seek: (ms) => seek(Math.max(0, ms) / 1000),
    });
  });
  /**
   * RESUME-001. The OS can tear this page down without warning (Android recreates the Activity
   * under memory pressure, and closing the Windows window ends the page), so the listener's place
   * is written down as they listen rather than on the way out: an `unload` handler is not
   * guaranteed to run, and on Android it usually does not. Throttled to once every few seconds —
   * `timeupdate` fires about four times a second and this is only a place marker.
   *
   * Only a full local song is worth resuming: a 30-second preview has no place to return to.
   */
  const noteResume = (t: number, duration: number) => {
    if (mode !== 'local' || !playing) return;
    if (t - savedAt.current < 5 && savedAt.current <= t) return;
    savedAt.current = t;
    writeResume(playing.track, playing.playback, t, duration);
  };
  /**
   * What the engine reports, about the song this page has current. Position drives the progress
   * bar, the listen meter and the resume point exactly as the <audio> deck's timeupdate does on
   * Windows; an event is something the engine did itself (a song ended, a blend finished).
   */
  useEffect(() => {
    onEngineRef.current = (st) => {
      setEngineStreams(st.streaming && st.id ? st.id : null);
      const ev = st.event;
      if (ev && markEngineEvent(ev.seq)) {
        if (ev.from.id === key) {
          const heard = ev.from.heardMs / 1000;
          if (ev.cause === 'repeat') {
            // Repeat-one looped inside the engine: the next end of this playback is a replay.
            recordEnd(heard);
            meter.current.seeked(0);
          } else if (ev.cause === 'end' && !ev.advanced) {
            // Played out, and the engine waits for this page to choose what follows.
            ended.current = true;
            setPaused(true);
            onEndRef.current(heard);
          } else if (ev.advanced) {
            // The engine already moved on to the song this page cued: record this one, then follow.
            if (ev.cause === 'end' || ev.cause === 'blend') recordEnd(heard);
            if (st.id) onPickUpNext(st.id);
          }
        } else if (ev.advanced && st.id && st.id !== key) onPickUpNext(st.id);
      }
      if (!st.id || st.id !== key) return;
      const c = st.positionMs / 1000;
      const d = st.durationMs > 0 ? st.durationMs / 1000 : 0;
      // A song that played out shows Play, as the <audio> deck does; pressing it starts it again.
      setPaused(!st.playWhenReady || st.ended);
      setLoading(st.buffering);
      setErr(st.error);
      setCur(c);
      if (d > 0) setDur(d);
      meter.current.tick(c, st.playing);
      if (st.playing) noteResume(c, d);
      setEngineBlend(st.blending ?? null);
    };
  });
  return (
    <section className={classNames('np', docked ? 'np--docked' : 'np--panel', !playing && 'is-empty')} aria-label="Now playing">
      {/*
        Two permanent decks. They are never keyed or conditionally rendered, because a
        MediaElementAudioSourceNode can be created once per element for the page's lifetime: a
        remounted element would lose its place in the mixing graph and go silent.

        crossOrigin must be set here, in the markup, before any src is assigned. Routing a
        cross-origin element that did not opt in through Web Audio produces permanent silence, not
        an error. Deezer's preview CDN answers with Access-Control-Allow-Origin: *.

        Only the current deck drives the UI. The other one is either idle or mid-blend, and its
        time updates must not move the progress bar or the listen meter.
      */}
      {(['a', 'b'] as const).map((id) => (
        <audio
          key={id}
          ref={id === 'a' ? deckA : deckB}
          preload="none"
          crossOrigin="anonymous"
          data-deck={id}
          onPlay={() => { if (id === deck) setPaused(false); syncPlayback(); }}
          onPlaying={(e) => {
            if (id !== deck) return;
            setLoading(false);
            // STREAM-DL-001: once the stream sounds, it is this song's source to the end.
            if (streamSrc && (streamNow?.hls || e.currentTarget.src.endsWith(streamSrc)) && key && !streamNow?.started) setStreamOf({ key, url: streamSrc, started: true, failed: false, hls: streamNow?.hls });
          }}
          onPause={() => { if (id === deck) setPaused(true); syncPlayback(); }}
          onWaiting={() => id === deck && setLoading(true)}
          onLoadedMetadata={(e) => id === deck && setDur(e.currentTarget.duration || 0)}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            if (id !== deck) return;
            meter.current.tick(a.currentTime, !a.paused && !a.seeking);
            setCur(a.currentTime);
            noteResume(a.currentTime, a.duration || 0);
            // The blend has to begin before this song ends, so it is driven from the playhead.
            void mixer.current?.tick(mix, playThrough() / 100);
          }}
          onSeeked={(e) => id === deck && meter.current.seeked(e.currentTarget.currentTime)}
          onEnded={() => {
            if (id !== deck) return;
            ended.current = true;
            setPaused(true);
            syncPlayback();
            onEndRef.current();
          }}
          onError={(e) => {
            // STREAM-DL-001: a stream that fails gives way to the download, quietly; only a file
            // that fails is an error the listener needs to hear about.
            if (id === deck && streamSrc && (streamNow?.hls || e.currentTarget.src.endsWith(streamSrc)) && key) {
              // Only a progressive failure tries HLS. A fatal HLS error waits for the download.
              setStreamOf(streamNow?.hls || !localSource ? { key, url: null, started: false, failed: true } : { key, url: `/hls-info?u=${encodeURIComponent(localSource)}`, started: false, failed: false, hls: true });
              return;
            }
            if (id === deck && src) {
              setLoading(false);
              setErr(mode === 'local' ? 'This local full song could not play. Try another source.' : 'This preview could not play. Deezer may no longer offer it.');
            }
          }}
        />
      ))}
      {!playing ? (
        <div className="np__idle">
          <span className="np__idleart" aria-hidden="true">
            <Glyph name="note" size={docked ? 16 : 28} />
          </span>
          <span>Nothing playing. Press play on any song.</span>
        </div>
      ) : (
        <>
          <div className="np__main">
            {ytVideoId ? (
              <iframe
                key={ytVideoId}
                id="yt-frame"
                className="np__embed"
                src={youtubeEmbedUrl(ytVideoId)}
                title={`${t!.title} in the YouTube Music player`}
                allow="autoplay; encrypted-media"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : embed ? (
              <iframe
                key={embed.url}
                className="np__embed"
                src={embed.url}
                title={`${t!.title} in the ${PROVIDER_LABEL[embed.provider]} player`}
                allow="autoplay; encrypted-media"
                referrerPolicy="strict-origin-when-cross-origin"
                loading="lazy"
              />
            ) : (
              <Art src={t!.artwork} size={docked ? 48 : 196} />
            )}
            <div className="np__text">
              <span className="np__title">{t!.title}</span>
              {onOpenArtist && !docked ? <ArtistNames track={t!} onOpen={onOpenArtist} className="np__artist" /> : <span className="np__artist">{artistOf(t!)}</span>}
              {!docked && status}
              {/*
                The docked strip is deliberately compact, so it carries no note lines — the same
                reason `status` is hidden here. A blend still has to be announced, though, or a
                screen-reader listener gets two songs at once with no explanation. Measured on the
                phone-width app: a blend runs there with no visible sign of it at all, so the
                visible indicator for the strip is still an open design question.
              */}
              {docked && blending && (
                <span className="vh" aria-live="polite">
                  {note}
                </span>
              )}
            </div>
          </div>
          {docked ? (
            <div className="np__dockctl">
              {progress}
              {/* One control row: transport, volume, then the song's own actions. They were a third
                  row, which made the dock 200px tall and read as a separate toolbar. */}
              <div className="np__controls">
                {transport}
                {volume}
                <PlayerActions key={t!.key} {...actions} />
              </div>
            </div>
          ) : (
            <>
              {progress}
              {transport}
              {/* One right-hand cluster, as the dock has one control row: five loose siblings in a
                  grid with areas for four left like/dislike/download to auto-place into a stray
                  third row under the art. */}
              <div className="np__side">
                {volume}
                <PlayerActions key={t!.key} {...actions} />
                {openLinks}
              </div>
            </>
          )}
        </>
      )}
      {!docked && (
        <>
          <Wheel onStep={onWheel} onSelect={onSelect} onMenu={onMenu} onPrev={onPrev} onNext={next} onPlayPause={toggle} canPlay={hasSound} />
          {upNext.length > 0 && (
            <div className="upnext">
              <h3>{shuffle ? 'Still to play (shuffled)' : 'Up next'}</h3>
              <ol>
                {upNext.map((u) => (
                  <li key={u.key}>
                    <button type="button" className="upnext__row" onClick={() => onPickUpNext(u.key)}>
                      <Art src={u.artwork} size={30} />
                      <span className="upnext__text">
                        <span className="upnext__title">{u.title}</span>
                        <span className="upnext__artist">{u.artist}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}
