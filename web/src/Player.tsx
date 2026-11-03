import { useEffect, useRef, useState } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, type Playback, type Track } from './api';
import { PREVIEW_ROUTE } from './engine/shape';
import { Art } from './Art';
import { Volume } from './Volume';
import { PlayerActions, type TrackActionProps } from './PlayerActions';
import { Wheel } from './Wheel';
import { loadYouTube, youtubeEmbedUrl, type YTPlayer } from './youtube';
import { attachElement, bus as audioBus, mixSlider, resumeEngine, setUnprocessable, subscribeEngine } from './audio-engine';
import { type DeckId } from './engine/audio-bus';
import { PreviewMixer } from './engine/preview-mixer';
import { ListenMeter, PROVIDER_LABEL, artistOf, classNames, fmtDuration, isSilent, markKey, qualifiesCompletion, toggleMuteState, type RepeatMode } from './util';

export interface Playing {
  track: Track;
  playback: Playback;
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
}

interface Props {
  playing: Playing | null;
  upNext: UpNext[];
  docked: boolean;
  canPrev: boolean;
  canNext: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
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
}

/** A listen this long, ended by the preview finishing, counts as a meaningful completion. */
const COMPLETE_S = 20;
/** A Next press after at least this much (but under SKIP_MAX_S) real listening counts as a skip. */
const SKIP_MIN_S = 2;
const SKIP_MAX_S = 12;

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

type Mode = 'full' | 'preview' | 'embed' | 'none';

/**
 * Now playing. The full song plays in YouTube's own embedded player, which Airwave drives through
 * YouTube's player API (play, pause, seek, volume, progress); the page never downloads that audio.
 * A song with no YouTube Music version falls back to its 30-second Deezer preview in an <audio>
 * element. SoundCloud songs play in SoundCloud's widget, whose progress and volume Airwave cannot reach.
 */
export function Player({ playing, upNext, docked, canPrev, canNext, shuffle, repeat, actions, onShuffle, onRepeat, onPrev, onNext, onListen, onWheel, onSelect, onMenu, onPickUpNext }: Props) {
  // Two decks, because a crossfade needs both songs audible at once: the outgoing song keeps
  // playing on its own element while the incoming one starts on the other. Both elements live for
  // the player's lifetime — a MediaElementAudioSourceNode can be made only once per element.
  const deckA = useRef<HTMLAudioElement>(null);
  const deckB = useRef<HTMLAudioElement>(null);
  const [deck, setDeck] = useState<DeckId>('a');
  /** Set when the mixer promotes a song that is ALREADY playing, so the load effect leaves it. */
  const promoted = useRef<string | null>(null);
  const [mixNote, setMixNote] = useState<string | null>(null);
  const [mix, setMix] = useState(mixSlider);
  useEffect(() => subscribeEngine(() => setMix(mixSlider())), []);
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
  const instance = useRef('');
  const endsThisInstance = useRef(0);
  const volRef = useRef(vol);
  volRef.current = vol;
  const lastLevel = useRef(vol.value);
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const onEndRef = useRef<() => void>(() => undefined);
  const key = playing?.track.key ?? null;

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
  const [found, setFound] = useState<{ key: string; id: string | null } | null>(null);
  const [badVideo, setBadVideo] = useState<string | null>(null);
  const previewSrc = playing?.playback.preview ?? null;
  // Songs the mixer blended into. They are already playing, as the preview they were blended as,
  // so they must not be looked up on YouTube: the lookup leaves `src` null while it runs, which
  // tore down the very deck the blend had just handed over, and a late video id would replace a
  // song mid-play with an iframe starting from zero.
  const previewOnly = useRef(new Set<string>());
  /**
   * With the mixer on, a song that has a preview plays as that preview even when a full YouTube
   * version exists.
   *
   * This is the whole feature working or not working. Measured on the real app: every song in the
   * list had a YouTube match, so all of them played in YouTube's iframe — which Airwave cannot
   * route, equalise or blend. Left that way the crossfader would be a control that silently does
   * nothing. Choosing the preview is what the Settings panel already tells the listener happens,
   * and it is the honest trade: 30 seconds a song, mixed, instead of full songs that cannot be.
   */
  const mixerNeedsPreview = mix > 0 && Boolean(previewSrc);
  const stayPreview = (key !== null && previewOnly.current.has(key)) || mixerNeedsPreview;
  const needsLookup = Boolean(playing && !knownId && !scEmbed) && !stayPreview;
  const lookedUp = found?.key === key;
  const lookingUp = needsLookup && !lookedUp;
  const candidate = stayPreview ? null : knownId ?? (lookedUp ? found.id : null);
  const videoId = candidate && candidate !== badVideo ? candidate : null;
  const src = !videoId && !lookingUp ? previewSrc : null;
  const embed = !videoId && !src && !lookingUp ? scEmbed : null;
  const mode: Mode = videoId ? 'full' : src ? 'preview' : embed ? 'embed' : 'none';
  const hasSound = mode === 'full' || mode === 'preview';

  useEffect(() => {
    if (!playing || !needsLookup) return;
    let live = true;
    api
      .fullSong(playing.track)
      .then((r) => live && setFound({ key: playing.track.key, id: r.id }))
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
  useEffect(() => {
    yt.current = null;
    setYtReady(false);
    if (!videoId) return;
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
  }, [videoId]);

  useEffect(() => {
    meter.current = new ListenMeter();
    ended.current = false;
    instance.current = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    endsThisInstance.current = 0;
    setCur(0);
    setDur(0);
    setErr(null);
    setPaused(true);
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
  useEffect(() => {
    if (mix <= 0) return;
    attachElement(deckA.current, 'a');
    attachElement(deckB.current, 'b');
    resumeEngine();
  }, [mix]);

  // A song playing inside YouTube's or SoundCloud's own player cannot be processed or blended.
  // Saying so is the difference between an honest control and one that looks broken.
  useEffect(() => {
    setUnprocessable(mode === 'full' || mode === 'embed' ? 'iframe-playback' : null);
  }, [mode]);

  // Cue the next song while this one still plays: an overlap needs both loaded and decoded.
  const nextKey = upNext[0]?.key ?? null;
  const nextPreview = upNext[0]?.preview ?? null;
  useEffect(() => {
    if (mix <= 0 || mode !== 'preview' || !nextKey) {
      mixer.current?.cancel();
      setMixNote(null);
      return;
    }
    void mixer.current?.prepare({ key: nextKey, preview: nextPreview });
  }, [mix, mode, nextKey, nextPreview]);

  const toggle = () => {
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
    if (mode === 'full') yt.current?.seekTo(s, true);
    else if (audio.current) audio.current.currentTime = s;
    meter.current.seeked(s);
    setCur(s);
  };

  // A song that plays to its end counts as listened; then the next one starts. A second end of the
  // same playback instance is one replay; beyond that, loops teach nothing new and record nothing.
  onEndRef.current = () => {
    const l = meter.current.listened;
    const coverage = meter.current.coverage;
    const duration = dur > 0 ? Math.round(dur) : playing?.track.duration ?? null;
    const medium = mode === 'full' ? 'full' : 'preview';
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
    if (repeatRef.current === 'one') {
      // Repeating this song means there is no next song to blend into.
      mixer.current?.cancel();
      // Play this song again. The next end of the same playback counts as a replay (see above), not a new listen.
      meter.current.seeked(0);
      ended.current = false;
      setCur(0);
      if (mode === 'full') {
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
        medium: mode === 'full' ? 'full' : 'preview',
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
        <Glyph name="shuffle" size={16} />
      </button>
      <button className="tbtn" type="button" onClick={onPrev} disabled={!canPrev} aria-label="Previous song">
        <Glyph name="previous" size={16} />
      </button>
      <button
        className="tbtn tbtn--main"
        type="button"
        onClick={toggle}
        disabled={mode === 'full' ? !ytReady : !src}
        aria-label={paused ? 'Play' : 'Pause'}
        title={hasSound ? undefined : lookingUp ? 'Finding the full song…' : 'This song plays in its own player'}
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
  const progress = hasSound ? (
    <div className="prog">
      <span className="prog__t">{fmtDuration(cur) || '0:00'}</span>
      <input
        className="prog__bar"
        type="range"
        min={0}
        max={total || 1}
        step={0.1}
        value={Math.min(cur, total || 1)}
        disabled={mode === 'full' && !ytReady}
        aria-label={mode === 'full' ? 'Position in the song' : 'Position in the preview'}
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

  // What the mixer is doing, in the listener's words. Only shown when they turned it on and the
  // current song is one it can actually reach, so it never contradicts the line above it.
  const mixLine =
    playing && mix > 0 && mode === 'preview' && mixNote ? (
      <p className="np__note np__note--mix" aria-live="polite">
        <Glyph name="shuffle" size={12} /> {mixNote}
      </p>
    ) : null;

  const status = !playing ? null : err ? (
    <p className="np__note np__note--bad">
      <Glyph name="warning" size={12} /> {err}
    </p>
  ) : lookingUp ? (
    <p className="np__note">Finding the full song…</p>
  ) : mode === 'full' ? (
    <p className="np__note">{loading ? 'Loading the full song…' : 'Full song, played by YouTube’s own player.'}</p>
  ) : src ? (
    <p className="np__note">
      {loading ? 'Loading the preview…' : badVideo ? '30-second preview from Deezer: YouTube won’t play the full song here.' : '30-second preview from Deezer: no full version was found.'}
    </p>
  ) : embed ? (
    <p className="np__note">Playing in the {PROVIDER_LABEL[embed.provider]} player. Airwave can’t see its progress or volume, so it records nothing about this listen.</p>
  ) : (
    <p className="np__note">No player here for this song. Open it in its app.</p>
  );

  const openLinks = playing && (
    <div className="np__open">
      {(playing.playback.open.length ? playing.playback.open : t?.url ? [{ provider: t.provider, label: `Open in ${PROVIDER_LABEL[t.provider] ?? t.provider}`, url: t.url }] : []).map((o) => (
        <a key={o.provider} className="openlink" href={o.url} target="_blank" rel="noreferrer noopener">
          <ProviderMark provider={markKey(o.provider)} size={13} /> {o.label}
        </a>
      ))}
    </div>
  );

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
          onPlay={() => id === deck && setPaused(false)}
          onPlaying={() => id === deck && setLoading(false)}
          onPause={() => id === deck && setPaused(true)}
          onWaiting={() => id === deck && setLoading(true)}
          onLoadedMetadata={(e) => id === deck && setDur(e.currentTarget.duration || 0)}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            if (id !== deck) return;
            meter.current.tick(a.currentTime, !a.paused && !a.seeking);
            setCur(a.currentTime);
            // The blend has to begin before this song ends, so it is driven from the playhead.
            void mixer.current?.tick(mix);
          }}
          onSeeked={(e) => id === deck && meter.current.seeked(e.currentTarget.currentTime)}
          onEnded={() => {
            if (id !== deck) return;
            ended.current = true;
            setPaused(true);
            onEndRef.current();
          }}
          onError={() => {
            if (id === deck && src) {
              setLoading(false);
              setErr('This preview could not play. Deezer may no longer offer it.');
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
            {videoId ? (
              <iframe
                key={videoId}
                id="yt-frame"
                className="np__embed"
                src={youtubeEmbedUrl(videoId)}
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
              <span className="np__artist">{artistOf(t!)}</span>
              {!docked && status}
              {!docked && mixLine}
              {/*
                The docked strip is deliberately compact, so it carries no note lines — the same
                reason `status` is hidden here. A blend still has to be announced, though, or a
                screen-reader listener gets two songs at once with no explanation. Measured on the
                phone-width app: a blend runs there with no visible sign of it at all, so the
                visible indicator for the strip is still an open design question.
              */}
              {docked && mixLine && (
                <span className="vh" aria-live="polite">
                  {mixNote}
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
              {volume}
              <PlayerActions key={t!.key} {...actions} />
              {openLinks}
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
