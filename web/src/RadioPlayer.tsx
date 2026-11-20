import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, type PlaylistSummary } from './api';
import { favouriteStations, saveFavouriteStations, radioSession } from './engine/radio-client';
import { stationLocation, broadcastTimeline, radioClock as clock } from './engine/radio';
import { Art } from './Art';
import { Volume } from './Volume';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { ShuffleGlyph } from './icons';
import { engineSend } from './engine/native-engine';
import { genreBubbles } from './util';
import { GenreBubbleView } from './Results';
import { TagStrip } from './TagStrip';
import { classifyStation } from './engine/radio-genres';
import { radioArtistTarget, type RadioArtistTarget } from './engine/radio-artist';
import './radio.css';

/** RADIO-BEHIND-TRUE-001: this much older than the newest audio received, after a pause or rewind, is behind live. */
export const BEHIND_LIVE_S = 4;
export function RadioPlayer({ docked = false, onOpenArtist, onPlaySong, onDownloadSong }: { docked?: boolean; onOpenArtist?: (target: RadioArtistTarget) => void; onPlaySong?: (t: NonNullable<ReturnType<typeof radioSession.get>['track']>) => void; onDownloadSong?: (t: NonNullable<ReturnType<typeof radioSession.get>['track']>) => Promise<unknown> } = {}) {
  const r = useSyncExternalStore(radioSession.subscribe, radioSession.get); const [menu, setMenu] = useState(false), [lists, setLists] = useState<PlaylistSummary[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [volume, setVolume] = useState(1), [stationStar, setStationStar] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const lastVolume = useRef(1);
  const changeVolume = (next: number) => {
    const v = Math.max(0, Math.min(1, next));
    if (v > 0) lastVolume.current = v;
    setVolume(v);
    radioSession.volume(v); // Web Audio radio graph on Windows
    engineSend({ op: 'settings', volume: v }); // native playback, including radio on Android
  };
  const t = r.track, snap = r.snapshot, s = r.station;
  // Anchor the published item clock to the ring's sample clock once audio is arriving. Network
  // bursts must not make a paused playhead wobble, and no start is inferred if none was published.
  const audible = !!snap && snap.received > 0;
  const bufferOffset = useMemo(() => audible && snap && r.broadcast?.startedAt ? (Date.now() - r.broadcast.startedAt) / 1000 - snap.received : undefined, [snap?.id, r.broadcast?.startedAt, audible]);
  const [creatingList, setCreatingList] = useState(false), [newListName, setNewListName] = useState('');
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  useEffect(() => { setSeekPreview(null); }, [snap?.id, r.broadcast?.title]);
  useEffect(() => { setMenu(false); setCreatingList(false); setNewListName(''); setMessage(''); }, [s?.id, t?.key]);
  useEffect(() => { if (!s) return; let live = true; const update = () => { void favouriteStations().then(list => { if (live) setStationStar(list.some(x => x.id === s.id)); }); }; update(); window.addEventListener('airwave-radio-favourites', update); return () => { live = false; window.removeEventListener('airwave-radio-favourites', update); }; }, [s?.id]);
  if (!s) return null;
  const playlist = async (id: string) => { if (!t || busy) return; setBusy(true); try { await api.playlistEdit('add', { id, key: t.key, tracks: [t] }); setMessage(t.kind === 'radio-programme' ? 'Programme bookmark added. Playing it returns to the live station; this is not a recording.' : 'Song added to playlist.'); setMenu(false); } catch { setMessage('Could not add to playlist. Try again.'); } finally { setBusy(false); } };
  const newList = async () => { if (!t) return; const name = newListName.trim(); if (!name) return; setBusy(true); try { const v = await api.playlistEdit('create', { name, key: t.key, tracks: [t] }); setLists(v.lists); setMessage('Playlist created with this item.'); setMenu(false); } catch { setMessage('Could not create playlist.'); } finally { setBusy(false); } };
  const timeline = broadcastTimeline(r.broadcast, r.identified ? t : null, snap, Date.now(), bufferOffset, r.songStart);
  // RADIO-BEHIND-TRUE-001 (owner, 2026-11-19): "ensure the radio doesn't say behind live [when] it doesn't mean it".
  // A wall-clock estimate of the live edge ran ahead of a stream that arrives in bursts, so it read BEHIND LIVE with
  // nothing paused or rewound. Now only the listener's own pause or rewind puts them behind, and only while the
  // audio they hear is more than BEHIND_LIVE_S older than the newest audio received.
  const gap = snap ? Math.max(0, snap.received - snap.position) : 0;
  const behindLive = !!snap && !snap.paused && !!r.timeshifted && gap > BEHIND_LIVE_S;
  const atLive = !!snap && !snap.paused && !behindLive;
  const goLive = () => void radioSession.goLive().catch(e => setMessage(String(e.message)));
  const behind = timeline.behind;
  const artwork = (r.identified ? t?.artwork : null) || r.broadcast?.artwork || s.image;
  const artKind = r.identified && t?.artwork ? 'Song cover' : r.broadcast?.artwork ? 'Programme artwork' : 'Station artwork';
  const value = seekPreview ?? timeline.value;
  const commitSeek = (target: number) => {
    setSeekPreview(null);
    if (!snap || !Number.isFinite(target) || timeline.elapsed === null) return;
    const backwards = timeline.value - target;
    if (backwards < -0.05) { setMessage('Live radio cannot seek forward. Previous / Next change stations.'); return; }
    if (backwards > timeline.rewindable) setMessage('Only audio inside the retained buffer can be rewound.');
    if (backwards > 0) void radioSession.rewind(Math.min(backwards, timeline.rewindable)).catch(e => setMessage(String(e.message)));
  };
  return <aside className={`player np radio-player${docked ? ' np--docked' : ''}`} aria-label="Radio player">
    <button type="button" className="radio-player__close" aria-label="Stop radio" title="Stop listening and close the radio player" onClick={() => void radioSession.stop()}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
    <div className="radio-player__main"><figure className="radio-player__art"><Art src={artwork} size={64} alt={`${artKind}: ${t?.title || r.broadcast?.title || s.name}`} /></figure><div className="radio-player__identity">{behindLive ? <button type="button" className="radio-live radio-live--behind" title="Go back to the live broadcast" onClick={goLive}>● BEHIND LIVE</button> : <span className="radio-live">● {snap?.paused ? 'PAUSED' : 'LIVE RADIO'}</span>}<div className="radio-player__titleline"><strong title={t?.title || s.name}>{t && onPlaySong ? <button type="button" className="artistlink radio-player__song" aria-label={`Play the song ${t.title}`} onClick={() => onPlaySong(t)}>{t.title}</button> : t?.title || r.broadcast?.title || s.name}</strong><button type="button" className="iconbtn radio-player__starbtn" aria-pressed={stationStar} aria-label={stationStar ? `Unstar station ${s.name}` : `Star station ${s.name}`} title={stationStar ? 'Remove this station from your starred stations' : 'Star this station'} onClick={() => { void favouriteStations().then(list => saveFavouriteStations(stationStar ? list.filter(x => x.id !== s.id) : [...list.filter(x => x.id !== s.id), s])).then(() => setStationStar(!stationStar)).catch(() => setMessage('Station favourite could not be saved')); }}>{stationStar ? '★' : '☆'}</button></div><span>{(() => { // RADIO-ARTIST-001: an identified song opens its catalogue artists (the lead with its provider id);
        // the broadcaster's own text opens the cleaned primary artist, never "JACKSON 5, THE" as written.
        const names = (r.identified ? (t?.artists || [t?.artist]) : [r.broadcast?.artist]).filter((x): x is string => !!x);
        if (!names.length) return null;
        const targetOf = (name: string, i: number): RadioArtistTarget | null => r.identified && t ? (i === 0 ? radioArtistTarget(name, t, null) : { name }) : radioArtistTarget(name, null, null);
        return names.map((name, i) => { const target = targetOf(name, i); return <span key={name}>{i > 0 && ', '}{onOpenArtist && target
          ? <button type="button" className="artistlink radio-player__artist" aria-label={`Open the artist ${target.name}`} onClick={() => onOpenArtist(target)}>{name}</button>
          : name}</span>; });
      })()} · {s.name}</span><small>{stationLocation(s)}{r.broadcast?.state === 'stale' ? ' · last published metadata' : timeline.over ? ' · this song has ended; waiting for the station\'s next title' : ''}</small>
      {/* RADIO-GENRES-001: an identified song shows its own genres; a programme or unidentified song shows what the station plays. */}
      <TagStrip className="radio-player__tags" label="Genres">{(r.identified && r.characteristics ? genreBubbles(r.characteristics) : classifyStation({ tags: s.tags, name: s.name, language: s.language, countryCode: s.countryCode })).map((g, i) => <GenreBubbleView key={i} bubble={g} />)}</TagStrip>
    </div></div>
    <div className="radio-player__timeline">

      <div className="prog">
        <span className="prog__t radio-player__elapsed" title={timeline.clockSource === 'audio' ? 'Measured from broadcast audio' : timeline.elapsed !== null ? 'Broadcaster timing' : r.broadcast?.kind === 'song' ? 'Song start not measured' : 'Start time not published'}>{clock(timeline.elapsed)}</span>
        <input className="prog__bar" type="range" min={0} max={timeline.max} step={0.1} value={value} disabled={!snap || timeline.elapsed === null || timeline.rewindable <= 0}
          aria-label={timeline.elapsed !== null ? `Rewind current radio ${r.broadcast?.kind === 'song' ? 'track' : 'programme'}` : 'Track progress unavailable'}
          aria-valuetext={timeline.elapsed !== null ? `${clock(timeline.elapsed)} of ${clock(timeline.duration)}. Rewind only within retained audio.` : 'Item start has not been measured.'}
          style={{ ['--pct' as string]: `${Math.min(100, value / timeline.max * 100)}%` }}
          onChange={() => {}}
          onInput={e => { const target = Number(e.currentTarget.value); if (target > timeline.value + 0.05) { e.currentTarget.value = String(timeline.value); setSeekPreview(null); setMessage('Live radio cannot seek forward. Previous / Next change stations.'); } else setSeekPreview(Math.max(timeline.value - timeline.rewindable, target)); }}
          onPointerUp={e => commitSeek(Number(e.currentTarget.value))}
          onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) commitSeek(Number(e.currentTarget.value)); }}
          onPointerCancel={() => setSeekPreview(null)} />
        <span className="prog__t radio-player__duration" title={timeline.durationSource === 'catalogue' ? 'Catalogue length' : timeline.duration === null ? 'Duration not published' : 'Published duration'}>{clock(timeline.duration)}</span>
      </div>
      <div className="radio-player__buffer">{snap?.state === 'buffering' && <span>Connecting to broadcast…</span>}</div>
    </div>
    <div className="radio-player__controls">
    <div className="transport radio-player__transport" role="group" aria-label="Radio playback">
      <button type="button" className={`tbtn tbtn--mode${r.shuffle ? ' is-on' : ''}`} aria-pressed={!!r.shuffle} aria-label="Shuffle stations"
        title={r.shuffle ? 'Shuffle is on: Next tunes a random station' : 'Shuffle is off: Next follows the station list'}
        onClick={() => void radioSession.setShuffle(!r.shuffle)}><ShuffleGlyph size={16} /></button>
      <button type="button" className="tbtn" aria-label="Previous radio station" disabled={!radioSession.canSkip(-1)} onClick={() => void radioSession.skip(-1)}><Glyph name="previous" size={16} /></button>
      <button type="button" className="tbtn tbtn--main" aria-label={snap?.paused ? 'Resume radio' : 'Pause radio'} disabled={!snap} onClick={() => void radioSession.pause().catch(e => setMessage(String(e.message)))}><Glyph name={snap?.paused ? 'play' : 'pause'} size={18} /></button>
      <button type="button" className="tbtn" aria-label="Next radio station" disabled={!radioSession.canSkip(1)} title={r.shuffle ? 'Next random station (not skip forward in audio)' : 'Next station (not skip forward in audio)'} onClick={() => void radioSession.skip(1)}><Glyph name="next" size={16} /></button>
      <button type="button" className="tbtn tbtn--mode radio-player__rw" aria-label="Rewind radio 15 seconds" disabled={!snap || snap.position <= snap.oldest + 1} onClick={() => void radioSession.rewind().catch(e => setMessage(String(e.message)))}>↶15</button>
      {/* RADIO-GO-LIVE-001 (owner, 2026-11-19): one press to hear what the station is playing now. */}
      <button type="button" className={`tbtn tbtn--mode radio-player__live${atLive ? ' is-on' : ''}`} aria-label="Go live" aria-pressed={atLive} disabled={!snap}
        title={atLive ? 'You are listening live' : 'Jump to what the station is playing now'} onClick={goLive}>LIVE</button>
    </div>
    </div>
    <div className="radio-player__side">
      <Volume value={volume} muted={volume === 0} onChange={changeVolume} onToggleMute={() => changeVolume(volume === 0 ? lastVolume.current : 0)} />
      <div className="radio-player__actions"><button type="button" className="btn radio-player__playlist" aria-label="Add song to playlist" title="Add song to playlist" disabled={!t || !r.broadcast?.title} aria-expanded={menu} onClick={() => { setMenu(!menu); void api.playlists().then(v => setLists(v.lists)).catch(() => setMessage('Playlists could not be loaded')); }}><Glyph name="star" size={16} /><span className="radio-player__playlist-label">Add song to playlist</span></button><button type="button" className="iconbtn radio-player__download" aria-busy={downloading} aria-label={r.identified && t && onDownloadSong ? 'Download current song' : 'Download radio recording'} disabled={downloading || !snap || snap.received <= snap.oldest} title={r.identified && onDownloadSong ? 'Download the full catalogue song to the folder chosen in Settings' : 'Save the retained audio for this item so far — a recording excerpt, not a complete programme'} onClick={async () => {
        setDownloading(true); setMessage('');
        const sessionId = snap?.id;
        try {
          if (r.identified && t && onDownloadSong) await onDownloadSong(t);
          else { const v = await radioSession.downloadRecording(); if (radioSession.get().snapshot?.id === sessionId) setMessage(`Recording excerpt saved to ${v.saved_to}`); }
        } catch (e) { if (radioSession.get().snapshot?.id === sessionId) setMessage((e as Error).message || 'Download failed'); }
        finally { setDownloading(false); }
      }}><Glyph name="download" size={18} /></button></div>
    </div>
    <div className="radio-player__status" role="status">{r.error ? <>{r.error} <button type="button" className="linkbtn" onClick={() => void radioSession.start(s)}>Reconnect</button></> : message}{snap?.dropped && <span> · Older paused audio has left the retained buffer.</span>}</div>
    {menu && <div className="radio-playlists">{creatingList && <form className="radio-playlists__create" aria-label="Create a radio playlist" onSubmit={e => { e.preventDefault(); void newList(); }}><label>Playlist name<input aria-label="New playlist name" value={newListName} maxLength={80} required autoFocus onInput={e => setNewListName(e.currentTarget.value)} onChange={() => {}} /></label><button type="submit" className="btn" disabled={busy || !newListName.trim()}>Create playlist</button><button type="button" className="btn" onClick={() => setCreatingList(false)}>Cancel new playlist</button></form>}<strong>Add {t?.kind === 'radio-programme' ? 'live programme bookmark' : 'song'} to playlist</strong>{lists.map(l => <button type="button" className="btn" disabled={busy} key={l.id} onClick={() => void playlist(l.id)}>{l.name}</button>)}<button type="button" className="btn" disabled={busy} onClick={() => setCreatingList(true)}>New playlist</button><button type="button" className="btn" onClick={() => setMenu(false)}>Cancel</button></div>}
  </aside>;
}
