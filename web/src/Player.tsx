import { useEffect, useRef, useState } from 'react';
import { Glyph, ProviderMark } from '@now-playing/aqua-ui/icons';
import { api, type Playback, type Track } from './api';
import { Art } from './Art';
import { Volume } from './Volume';
import { Wheel } from './Wheel';
import { loadYouTube, youtubeEmbedUrl, type YTPlayer } from './youtube';
import { ListenMeter, PROVIDER_LABEL, artistOf, classNames, fmtDuration, markKey } from './util';

export interface Playing {
  track: Track;
  playback: Playback;
}

export interface UpNext {
  key: string;
  title: string;
  artist: string;
  artwork?: string | null;
}

interface Props {
  playing: Playing | null;
  upNext: UpNext[];
  docked: boolean;
  canPrev: boolean;
  canNext: boolean;
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
export function Player({ playing, upNext, docked, canPrev, canNext, onPrev, onNext, onListen, onWheel, onSelect, onMenu, onPickUpNext }: Props) {
  const audio = useRef<HTMLAudioElement>(null);
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
  const onEndRef = useRef<() => void>(() => undefined);
  const key = playing?.track.key ?? null;

  // Which source plays. A song with no YouTube video yet is looked up once; only a confident match is used.
  const knownId = knownVideoId(playing);
  const scEmbed = playing?.playback.embed?.provider === 'soundcloud' ? playing.playback.embed : null;
  const [found, setFound] = useState<{ key: string; id: string | null } | null>(null);
  const [badVideo, setBadVideo] = useState<string | null>(null);
  const needsLookup = Boolean(playing && !knownId && !scEmbed);
  const lookedUp = found?.key === key;
  const lookingUp = needsLookup && !lookedUp;
  const candidate = knownId ?? (lookedUp ? found.id : null);
  const videoId = candidate && candidate !== badVideo ? candidate : null;
  const previewSrc = playing?.playback.preview ?? null;
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
    const a = audio.current;
    if (a) {
      a.volume = vol.value;
      a.muted = vol.muted;
    }
    const p = yt.current;
    if (p && ytReady) {
      p.setVolume(Math.round(vol.value * 100));
      if (vol.muted) p.mute();
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
      setLoading(true);
      a.src = src;
      a.play().catch(() => {
        // Autoplay can be refused; the user presses play. Not an error and not a skip.
        setLoading(false);
        setPaused(true);
      });
    } else {
      a.pause();
      a.removeAttribute('src');
      a.load();
      setPaused(true);
    }
  }, [key, src]);

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
    if (a.paused) void a.play().catch(() => setErr('This preview could not start.'));
    else a.pause();
  };

  const seek = (s: number) => {
    if (mode === 'full') yt.current?.seekTo(s, true);
    else if (audio.current) audio.current.currentTime = s;
    meter.current.seeked(s);
    setCur(s);
  };

  // A song that plays to its end counts as listened; then the next one starts. A second end of the
  // same playback instance is one replay; beyond that, loops teach nothing new and record nothing.
  onEndRef.current = () => {
    const l = meter.current.listened;
    if (playing && l >= COMPLETE_S) {
      const meta: ListenTelemetry = {
        instance: instance.current,
        medium: mode === 'full' ? 'full' : 'preview',
        duration: dur > 0 ? Math.round(dur) : playing.track.duration ?? null,
      };
      const n = ++endsThisInstance.current;
      if (n === 1) onListen('complete', playing.track, l, meta);
      else if (n === 2) onListen('replay', playing.track, l, meta);
    }
    if (canNext) onNext();
  };

  const next = () => {
    const l = meter.current.listened;
    if (playing && hasSound && !ended.current && l >= SKIP_MIN_S && l < SKIP_MAX_S)
      onListen('skip', playing.track, l, {
        instance: instance.current,
        medium: mode === 'full' ? 'full' : 'preview',
        duration: dur > 0 ? Math.round(dur) : playing.track.duration ?? null,
      });
    onNext();
  };

  const t = playing?.track;
  const transport = (
    <div className="transport" role="group" aria-label="Playback">
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
      muted={vol.muted}
      disabled={mode === 'embed' || mode === 'none'}
      disabledReason="SoundCloud’s player has its own volume control."
      onChange={(v) => setVol({ value: v, muted: false })}
      onToggleMute={() => setVol((x) => ({ ...x, muted: !x.muted }))}
    />
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
      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPaused(false)}
        onPlaying={() => setLoading(false)}
        onPause={() => setPaused(true)}
        onWaiting={() => setLoading(true)}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          meter.current.tick(a.currentTime, !a.paused && !a.seeking);
          setCur(a.currentTime);
        }}
        onSeeked={(e) => meter.current.seeked(e.currentTarget.currentTime)}
        onEnded={() => {
          ended.current = true;
          setPaused(true);
          onEndRef.current();
        }}
        onError={() => {
          if (src) {
            setLoading(false);
            setErr('This preview could not play. Deezer may no longer offer it.');
          }
        }}
      />
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
            </div>
          </div>
          {docked ? (
            <div className="np__dockctl">
              {transport}
              {progress}
              {volume}
            </div>
          ) : (
            <>
              {progress}
              {transport}
              {volume}
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
              <h3>Up next</h3>
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
