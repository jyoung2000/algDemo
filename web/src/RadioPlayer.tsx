import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, newEventId, type PlaylistSummary } from './api';
import { favouriteStations, saveFavouriteStations, radioSession } from './engine/radio-client';
import { stationLocation, broadcastTimeline, liveEdgeTracker, radioClock as clock } from './engine/radio';
import { Art } from './Art';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { ShuffleGlyph } from './icons';
import { engineSend } from './engine/native-engine';
import { genreBubbles } from './util';
import { GenreBubbleView } from './Results';
import './radio.css';
export function RadioPlayer({ docked = false, onOpenArtist }: { docked?: boolean; onOpenArtist?: (target: { name: string }) => void } = {}) {
  const r = useSyncExternalStore(radioSession.subscribe, radioSession.get); const [star, setStar] = useState(false), [menu, setMenu] = useState(false), [lists, setLists] = useState<PlaylistSummary[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [volume, setVolume] = useState(0.8), [stationStar, setStationStar] = useState(false);
  const t = r.track, snap = r.snapshot, s = r.station;
  // Anchor the published item clock to the ring's sample clock once audio is arriving. Network
  // bursts must not make a paused playhead wobble, and no start is inferred if none was published.
  const audible = !!snap && snap.received > 0;
  const bufferOffset = useMemo(() => audible && snap && r.broadcast?.startedAt ? (Date.now() - r.broadcast.startedAt) / 1000 - snap.received : undefined, [snap?.id, r.broadcast?.startedAt, audible]);
  const [creatingList, setCreatingList] = useState(false), [newListName, setNewListName] = useState('');
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  useEffect(() => { setSeekPreview(null); }, [snap?.id, r.broadcast?.title]);
  useEffect(() => { let live = true; setStar(false); setMenu(false); setCreatingList(false); setNewListName(''); setMessage(''); if (t) void api.feedbackState().then(v => { if (live) setStar(!!v.state[t.key]?.like); }).catch(() => {}); return () => { live = false; }; }, [t?.key]);
  useEffect(() => { if (!s) return; let live = true; const update = () => { void favouriteStations().then(list => { if (live) setStationStar(list.some(x => x.id === s.id)); }); }; update(); window.addEventListener('airwave-radio-favourites', update); return () => { live = false; window.removeEventListener('airwave-radio-favourites', update); }; }, [s?.id]);
  if (!s) return null;
  const toggleStar = async () => { if (!t || busy) return; setBusy(true); try { await api.feedback(star ? 'unlike' : 'like', t, { event_id: newEventId('radio-star', t.key), origin: 'radio' }); setStar(!star); setMessage(star ? 'Star removed' : t.kind === 'radio-programme' ? 'Programme bookmark starred. It links to the live station, not a recording.' : 'Song starred and added to your music taste.'); } catch { setMessage('Could not save your star. Try again.'); } finally { setBusy(false); } };
  const playlist = async (id: string) => { if (!t || busy) return; setBusy(true); try { await api.playlistEdit('add', { id, key: t.key, tracks: [t] }); setMessage(t.kind === 'radio-programme' ? 'Programme bookmark added. Playing it returns to the live station; this is not a recording.' : 'Song added to playlist.'); setMenu(false); } catch { setMessage('Could not add to playlist. Try again.'); } finally { setBusy(false); } };
  const newList = async () => { if (!t) return; const name = newListName.trim(); if (!name) return; setBusy(true); try { const v = await api.playlistEdit('create', { name, key: t.key, tracks: [t] }); setLists(v.lists); setMessage('Playlist created with this item.'); setMenu(false); } catch { setMessage('Could not create playlist.'); } finally { setBusy(false); } };
  const timeline = broadcastTimeline(r.broadcast, r.identified ? t : null, snap, Date.now(), bufferOffset);
  // RADIO-UI-003: one steady behind-live clock, not the bursty received-position difference.
  const edgeOf = useRef(liveEdgeTracker());
  const behindShown = snap ? Math.max(0, edgeOf.current(snap.id, snap.received, Date.now() / 1000) - snap.position) : 0;
  const behind = timeline.behind;
  const artwork = (r.identified ? t?.artwork : null) || r.broadcast?.artwork || s.image;
  const artKind = r.identified && t?.artwork ? 'Song cover' : r.broadcast?.artwork ? 'Programme artwork' : 'Station artwork';
  const value = seekPreview ?? timeline.value;
  const commitSeek = (target: number) => {
    setSeekPreview(null);
    if (!snap || !Number.isFinite(target)) return;
    const backwards = timeline.value - target;
    if (backwards < -0.05) { setMessage('Live radio cannot seek forward. Previous / Next change stations.'); return; }
    if (backwards > timeline.rewindable) setMessage('Only audio inside the retained five-minute buffer can be rewound.');
    if (backwards > 0) void radioSession.rewind(Math.min(backwards, timeline.rewindable)).catch(e => setMessage(String(e.message)));
  };
  return <aside className={`player np radio-player${docked ? ' np--docked' : ''}`} aria-label="Radio player">
    <button type="button" className="radio-player__close" aria-label="Stop radio" title="Stop listening and close the radio player" onClick={() => void radioSession.stop()}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </button>
    <div className="radio-player__main"><figure className="radio-player__art"><Art src={artwork} size={64} alt={`${artKind}: ${t?.title || r.broadcast?.title || s.name}`} /><figcaption>{artKind}</figcaption></figure><div className="radio-player__identity"><span className="radio-live">● {snap?.paused ? 'PAUSED' : behindShown > 4 ? 'BEHIND LIVE' : 'LIVE RADIO'}</span><strong title={t?.title || s.name}>{t?.title || r.broadcast?.title || s.name}</strong><span>{(() => { const names = (r.identified ? (t?.artists || [t?.artist]) : [r.broadcast?.artist]).filter((x): x is string => !!x);
        if (!names.length) return 'Live programme';
        return names.map((name, i) => <span key={name}>{i > 0 && ', '}{onOpenArtist
          ? <button type="button" className="artistlink radio-player__artist" aria-label={`Open the artist ${name}`} onClick={() => onOpenArtist({ name })}>{name}</button>
          : name}</span>);
      })()} · {s.name}</span><small>{stationLocation(s)}{r.broadcast?.state === 'stale' ? ' · last published metadata' : ''}</small>
      {r.characteristics && <div className="radio-player__tags">{genreBubbles(r.characteristics).map((g, i) => <GenreBubbleView key={i} bubble={g} />)}</div>}
    </div></div>
    <div className="radio-player__timeline">
      <div className="radio-player__time-label"><span title="Based on the broadcaster’s published clock and your rewind position. Unpublished transmission delay may apply.">{timeline.elapsed !== null ? 'Broadcaster timing' : 'Start time not published'}</span><span>{timeline.durationSource === 'catalogue' ? 'Catalogue length · broadcast edit may differ' : timeline.duration === null ? 'Duration not published' : 'Published duration'}</span></div>
      <div className="prog">
        <span className="prog__t radio-player__elapsed">{clock(timeline.elapsed)}</span>
        <input className="prog__bar" type="range" min={0} max={timeline.max} step={0.1} value={value} disabled={!snap || timeline.rewindable <= 0}
          aria-label={timeline.elapsed !== null ? `Position in the ${r.broadcast?.kind === 'song' ? 'song' : 'programme'}` : 'Rewind buffered radio'}
          aria-valuetext={timeline.elapsed !== null ? `${clock(timeline.elapsed)} of ${clock(timeline.duration)}. Rewind only.` : `${clock(timeline.rewindable)} available to rewind. Item start is not published.`}
          style={{ ['--pct' as string]: `${Math.min(100, value / timeline.max * 100)}%` }}
          onChange={() => {}}
          onInput={e => { const target = Number(e.currentTarget.value); if (target > timeline.value + 0.05) { e.currentTarget.value = String(timeline.value); setSeekPreview(null); setMessage('Live radio cannot seek forward. Previous / Next change stations.'); } else setSeekPreview(Math.max(timeline.value - timeline.rewindable, target)); }}
          onPointerUp={e => commitSeek(Number(e.currentTarget.value))}
          onKeyUp={e => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) commitSeek(Number(e.currentTarget.value)); }}
          onPointerCancel={() => setSeekPreview(null)} />
        <span className="prog__t radio-player__duration">{clock(timeline.duration)}</span>
      </div>
      <div className="radio-player__buffer">{snap?.state === 'buffering' && <span>Connecting to broadcast…</span>}<small>Pause retains 5 minutes. Drag the playhead backwards only; Previous / Next switch stations.</small></div>
    </div>
    <div className="transport radio-player__transport" role="group" aria-label="Radio playback">
      <button type="button" className={`tbtn tbtn--mode${r.shuffle ? ' is-on' : ''}`} aria-pressed={!!r.shuffle} aria-label="Shuffle stations"
        title={r.shuffle ? 'Shuffle is on: Next tunes a random station' : 'Shuffle is off: Next follows the station list'}
        onClick={() => void radioSession.setShuffle(!r.shuffle)}><ShuffleGlyph size={16} /></button>
      <button type="button" className="tbtn" aria-label="Previous radio station" disabled={!radioSession.canSkip(-1)} onClick={() => void radioSession.skip(-1)}><Glyph name="previous" size={16} /></button>
      <button type="button" className="tbtn tbtn--main" aria-label={snap?.paused ? 'Resume radio' : 'Pause radio'} disabled={!snap} onClick={() => void radioSession.pause().catch(e => setMessage(String(e.message)))}><Glyph name={snap?.paused ? 'play' : 'pause'} size={18} /></button>
      <button type="button" className="tbtn" aria-label="Next radio station" disabled={!radioSession.canSkip(1)} title={r.shuffle ? 'Next random station (not skip forward in audio)' : 'Next station (not skip forward in audio)'} onClick={() => void radioSession.skip(1)}><Glyph name="next" size={16} /></button>
      <button type="button" className="tbtn tbtn--mode radio-player__rw" aria-label="Rewind radio 15 seconds" disabled={!snap || snap.position <= snap.oldest + 1} onClick={() => void radioSession.rewind().catch(e => setMessage(String(e.message)))}>↶15</button>
    </div>
    <div className="radio-player__actions"><button type="button" className="btn" aria-pressed={stationStar} onClick={() => { void favouriteStations().then(list => saveFavouriteStations(stationStar ? list.filter(x => x.id !== s.id) : [...list.filter(x => x.id !== s.id), s])).then(() => setStationStar(!stationStar)).catch(() => setMessage('Station favourite could not be saved')); }}>{stationStar ? 'Unstar station' : 'Star station'}</button><button type="button" className="iconbtn" disabled={!t || !r.broadcast?.title || busy} aria-label={star ? 'Unstar current radio item' : 'Star current radio item'} aria-pressed={star} onClick={() => void toggleStar()}>{star ? '★' : '☆'}</button><button type="button" className="btn" disabled={!t || !r.broadcast?.title} aria-expanded={menu} onClick={() => { setMenu(!menu); void api.playlists().then(v => setLists(v.lists)).catch(() => setMessage('Playlists could not be loaded')); }}>Add to playlist</button><label className="radio-volume">Volume<input type="range" min="0" max="1" step="0.01" value={volume} onChange={e => { const v = Number(e.target.value); setVolume(v); radioSession.volume(v); engineSend({ op: 'settings', volume: v }); }} /></label></div>
    <div className="radio-player__status" role="status">{r.error ? <>{r.error} <button type="button" className="linkbtn" onClick={() => void radioSession.start(s)}>Reconnect</button></> : r.identifying ? 'Identifying this audio…' : message || r.analysis}{snap?.dropped && <span> · Older paused audio has left the five-minute buffer.</span>}</div>
    {menu && <div className="radio-playlists">{creatingList && <form className="radio-playlists__create" aria-label="Create a radio playlist" onSubmit={e => { e.preventDefault(); void newList(); }}><label>Playlist name<input aria-label="New playlist name" value={newListName} maxLength={80} required autoFocus onInput={e => setNewListName(e.currentTarget.value)} onChange={() => {}} /></label><button type="submit" className="btn" disabled={busy || !newListName.trim()}>Create playlist</button><button type="button" className="btn" onClick={() => setCreatingList(false)}>Cancel new playlist</button></form>}<strong>Add {t?.kind === 'radio-programme' ? 'live programme bookmark' : 'song'} to playlist</strong>{lists.map(l => <button type="button" className="btn" disabled={busy} key={l.id} onClick={() => void playlist(l.id)}>{l.name}</button>)}<button type="button" className="btn" disabled={busy} onClick={() => setCreatingList(true)}>New playlist</button><button type="button" className="btn" onClick={() => setMenu(false)}>Cancel</button></div>}
  </aside>;
}
