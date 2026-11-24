import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { STATION_LETTERS, STATION_NUMBERS, compareStations, stationMatchesInitial, stationMatchesQuery, MetadataPoller, BackgroundRetry, freshBroadcast, stationLocation, type RadioStation, type Broadcast } from './engine/radio';
import { favouriteStations, saveFavouriteStations, matchSongBroadcast, radioDirectory, radioSession, stationMetadata, radioGeocode, shareRadioPlaces } from './engine/radio-client';
import { readPlaces, savePlaces, stationInPlace, PLACES_MAX, type RadioPlace } from './engine/radio-places';
import type { Track } from './api';
import { genreIdentity } from './engine/genre-identity';
import { GenreBubbleView } from './Results';
import { TagStrip } from './TagStrip';
import { type StationFacts, type StationGenre } from './engine/radio-genres';
import { radioTagBubbles } from './engine/display-tags';
import { SkeletonList, Develop } from './Skeleton';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { RadioRefreshGlyph } from './RadioGlyphs';
import { radioArtistTarget, type RadioArtistTarget } from './engine/radio-artist';
import { Marquee } from './Marquee';
import { radioPlayingNow } from './engine/radio-playing-client';
import { playingMatches, type PlayingStation } from './engine/radio-tunein';
import { askStationsPlaying, heardPlaying, stationsToAsk } from './engine/radio-playing-local';
import { fold } from './engine/identity';
import { PlayDisc } from './RowPlay';
import { ROW_COVER } from './row-cover';
import './radio.css';
import './song-row.css';
const countryName = (code: string) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; } };
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
/** Directory country/language words arrive lowercase ('french', 'united states'); show them as names. */
const capWords = (v: string) => v.split(/\s+/).map(cap).join(' ');
/** RADIO-UI-004: an off-picker topic keeps a lively, deterministic tone instead of a flat grey. */
const TOPIC_TONES = ['#e1712d', '#2d9ee1', '#8e3a6f', '#442de1', '#1f9d55', '#d23b68', '#b8860b', '#0e8f8f', '#7a3be1', '#c2571a', '#3867d6', '#20bf6b'];
function topicTone(label: string): string { let h = 0; for (const ch of label.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TOPIC_TONES[h % TOPIC_TONES.length]!; }
export type StationBubble = StationGenre;
/**
 * TAGS-ALWAYS-001 / RADIO-GENRES-001 (owner, 2026-11-19): every station and programme shows a main genre
 * or programming format and a subgenre. The directory's own words first (any language, sorted by what
 * the station mostly plays); with none, the station's name, then the song it is playing now, each marked
 * as an estimate; with nothing at all, a plain "Genre not listed" rather than an invented genre.
 */
export function stationGenreBubbles(tags: string[], name: string, more: Partial<Omit<StationFacts, 'tags' | 'name'>> = {}): StationBubble[] {
  return radioTagBubbles({ tags, name, ...more }) as StationBubble[];
}
const GENRE_SECTIONS = ['jazz', 'classical', 'rock', 'pop', 'hip hop', 'r&b', 'electronic', 'house', 'techno', 'ambient', 'metal', 'country', 'latin', 'reggae', 'soul', 'blues', 'folk', 'news', 'talk', 'world'] as const;
const LANGUAGE_CHOICES = ['english', 'spanish', 'french', 'german', 'italian', 'portuguese', 'dutch', 'arabic', 'hindi', 'japanese', 'korean', 'chinese'] as const;
const genreTone = (word: string) => genreIdentity(word)?.color ?? topicTone(word);
/** RADIO-LIVE-001: a live tick re-asks any station whose answer is older than this (ticks are 20 s apart). */
const RADIO_LIVE_MAX_AGE = 15000;
/** RADIO-AZ-ALL-001: directory pages a lone initial may walk through by itself before it asks the listener to go on. */
const AUTO_PAGES = 24;
function readStars(): RadioStation[] { try { return JSON.parse(localStorage.getItem('airwave:radio-stations') || '[]') as RadioStation[]; } catch { return []; } }
export function Radio({ onTune, onOpenArtist, onPlaySong }: { onTune: (s: RadioStation) => void; onOpenArtist?: (t: RadioArtistTarget) => void; onPlaySong?: (t: Track) => void }) {
  const activeStation = useSyncExternalStore(radioSession.subscribe, () => radioSession.get().station);
  // TAGS-SAME-001: the playing station's row uses the same live state as the radio player.
  const liveIdentified = useSyncExternalStore(radioSession.subscribe, () => radioSession.get().identified);
  const liveCharacteristics = useSyncExternalStore(radioSession.subscribe, () => radioSession.get().characteristics ?? null);
  const live = { identified: liveIdentified, characteristics: liveCharacteristics };
  // RADIO-PLAYING-NOW-002: the song the player shows for the station on now (a string, so equal answers do not re-render).
  const liveSongKey = useSyncExternalStore(radioSession.subscribe, () => { const v = radioSession.get(), b = v.broadcast, t = v.identified && v.track?.provider !== 'radio' ? v.track : null; return JSON.stringify([b?.state, b?.kind, b?.artist, b?.title, b?.checkedAt, t?.title, t?.artist, t?.artists]); });
  const [stations, setStations] = useState<RadioStation[]>([]), [countries, setCountries] = useState<{ name: string; code: string; count: number }[]>([]);
  const [letter, setLetter] = useState(''), [numericMode, setNumericMode] = useState(false);
  const indexRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (indexRef.current) indexRef.current.scrollLeft = 0; }, [numericMode]);
  const [query, setQuery] = useState(''), [country, setCountry] = useState(''), [language, setLanguage] = useState(''), [tag, setTag] = useState('');
  const [draft, setDraft] = useState(''), [menu, setMenu] = useState<'' | 'genre' | 'country' | 'language'>(''), [langDraft, setLangDraft] = useState(''), [stars, setStars] = useState(readStars), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [hasMore, setHasMore] = useState(true), [nextOffset, setNextOffset] = useState<number | null>(0);
  // RADIO-PLACES-001: the listener's saved places, and which are chosen; both survive closing the app.
  const [places, setPlacesState] = useState<RadioPlace[]>(readPlaces), [placeDraft, setPlaceDraft] = useState(''), [placeNote, setPlaceNote] = useState(''), [placeBusy, setPlaceBusy] = useState(false);
  const setPlaces = (next: RadioPlace[]) => setPlacesState(savePlaces(next));
  // CAR-RADIO-FILTERS-001: Android Auto offers the same saved places as location presets.
  const placesKey = places.map(p => p.id).join('|');
  useEffect(() => { void shareRadioPlaces(places); }, [placesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = places.filter(p => p.selected);
  const chosenKey = chosen.map(p => p.id).join('|');
  const addPlace = async () => {
    const text = placeDraft.trim(); if (!text || placeBusy) return;
    setPlaceBusy(true); setPlaceNote('');
    try {
      const p = await radioGeocode(text);
      if (!p) { setPlaceNote(`No place found for “${text}”. Try a city, an address or a region.`); return; }
      const rest = places.filter(x => x.id !== p.id);
      if (rest.length >= PLACES_MAX) { setPlaceNote(`You can keep up to ${PLACES_MAX} places. Remove one first.`); return; }
      setCountry(''); setPlaces([...rest, { ...p, selected: true }]); setPlaceDraft('');
    } catch { setPlaceNote('The place could not be looked up. Check the connection and try again.'); }
    finally { setPlaceBusy(false); }
  };
  const [info, setInfo] = useState<Record<string, Broadcast>>({});
  const [match, setMatch] = useState<Record<string, Track>>({});
  // RADIO-ART-003: artwork URLs that errored in the DOM; never rendered again, so the art chain
  // falls through to the next source while the background retry looks for a replacement.
  const [badArt, setBadArt] = useState<Record<string, true>>({});
  const [refreshing, setRefreshing] = useState(false); const generation = useRef(0), lastRequested = useRef(0); const poller = useRef<MetadataPoller | null>(null);
  const retrier = useRef<BackgroundRetry | null>(null); const infoRef = useRef(info); const shownRef = useRef<RadioStation[]>([]);
  const browseRef = useRef<RadioStation[]>([]), starsRef = useRef<RadioStation[]>(stars);
  // RADIO-PLAYING-NOW-001 (owner, 2026-11-20): "search by artist name or song name the radio tab to find any station
  // playing that artist or song currently". The stations whose song on air names the search are listed first, and
  // only while it is still on air: a row whose live answer moves on to another song leaves the group.
  const [playing, setPlaying] = useState<{ query: string; rows: PlayingStation[]; done: boolean } | null>(null);
  // RADIO-PLAYING-NOW-002 (owner, 2026-11-21): the station being listened to is checked against the search with the
  // same song its player shows (stream title, feed or fingerprint), and stays in the group only while that song is on.
  const session = radioSession.get(), sessionTrack = session.identified && session.track && session.track.provider !== 'radio' ? session.track : null;
  void liveSongKey;
  const activeNow = activeStation && query && !saved ? heardPlaying(query, { station: activeStation, broadcast: session.broadcast, track: sessionTrack }) : null;
  const liveBroadcast = activeStation ? activeNow?.broadcast ?? (session.broadcast && freshBroadcast(session.broadcast).state === 'current' ? session.broadcast : null) : null;
  // A found station whose own feed names no song keeps showing the song it was found by (TuneIn's answer).
  const foundSaid = new Map<string, Broadcast>();
  const onAir = !saved && query ? [...(activeNow ? [activeNow.station] : []), ...(playing && playing.query === query ? playing.rows.filter(r => r.station.id !== activeStation?.id).filter(r => {
    const b = info[r.station.id] ? freshBroadcast(info[r.station.id]!) : null;
    const songNow = !!b && b.state === 'current' && b.kind === 'song' && !!b.artist;
    if (!songNow) foundSaid.set(r.station.id, r.broadcast);
    return !songNow || playingMatches({ artist: b!.artist!, title: b!.title }, query);
  }).map(r => r.station) : [])] : [];
  const onAirIds = new Set(onAir.map(s => s.id));
  const matchingStars = stars.filter(s => stationMatchesInitial(s.name, letter) && stationMatchesQuery(s.name, query) && (chosen.length ? chosen.some(p => stationInPlace(s, p)) : !country || s.countryCode === country) && (!language || s.language.toLowerCase().includes(language.toLowerCase())) && (!tag || s.tags.includes(tag)));
  const listed = (saved ? matchingStars : [...new Map([...matchingStars, ...stations].map(s => [s.id, s])).values()]).filter(s => stationMatchesInitial(s.name, letter) && stationMatchesQuery(s.name, query));
  if (letter) listed.sort(compareStations); // RADIO-AZ-ALL-001: one worldwide order, accents and case folded, id breaks ties
  const shown = onAir.length ? [...onAir, ...listed.filter(s => !onAirIds.has(s.id))] : listed;
  useEffect(() => { let live = true; const read = () => { void favouriteStations().then(v => { if (live) setStars(v); }); }; read(); window.addEventListener('airwave-radio-favourites', read); return () => { live = false; window.removeEventListener('airwave-radio-favourites', read); }; }, []);
  useEffect(() => { let gone = false; void radioDirectory.countries().then(v => { if (!gone) setCountries(v.sort((a, b) => countryName(a.code).localeCompare(countryName(b.code)))); }).catch(() => {}); return () => { gone = true; }; }, []);
  const load = async (offset: number, steps = 0) => {
    const g = ++generation.current; lastRequested.current = offset; setBusy(true); setError('');
    try { const result = await radioDirectory.page({ query, country: chosen.length ? '' : country, language, tag, letter, offset, places: chosen.length ? chosen : undefined }); if (g !== generation.current) return; const rows = result.stations; if (!query && !letter && !offset) browseRef.current = rows; /* RADIO-PLAYING-NOW-002: the stations for the listener's places */ setStations(was => offset ? [...new Map([...was, ...rows].map(s => [s.id, s])).values()] : rows); setHasMore(result.nextOffset !== null); setNextOffset(result.nextOffset); if (!offset) window.scrollTo?.({ top: 0 }); /* RADIO-TOP-001: a fresh directory page presents from the top; More stations keeps the reader's place */
      // RADIO-AZ-ALL-001: an initial whose stations sit deeper in the directory keeps looking by itself; the listener
      // never faces an empty list with a "More stations" button under it.
      if (!rows.length && result.nextOffset !== null && steps < AUTO_PAGES) return await load(result.nextOffset, steps + 1); }
    catch (e) { if (g === generation.current) setError(e instanceof Error ? e.message : 'Station directory unavailable. Try again.'); }
    finally { if (g === generation.current) setBusy(false); }
  };
  // The discover rule: results follow the typing. Enter is not required; a short pause is enough.
  useEffect(() => { const t = setTimeout(() => setQuery(draft.trim()), 350); return () => clearTimeout(t); }, [draft]);
  // A filter menu closes like any popover: choosing, Escape, or clicking elsewhere.
  useEffect(() => {
    if (!menu) return;
    const away = (e: MouseEvent) => { if (!(e.target instanceof Node) || !document.querySelector('.radio-search')?.contains(e.target)) setMenu(''); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(''); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [menu]);
  useEffect(() => { if (!saved) void load(0); return () => { generation.current++; }; }, [query, country, language, tag, letter, saved, chosenKey]);
  // Asked as the search settles and again every minute while it stays, so the list follows what is on air.
  useEffect(() => {
    setPlaying(null); if (saved || !query) return;
    let gone = false;
    // RADIO-PLAYING-NOW-002: TuneIn knows only the stations that report songs to it, so the starred stations and the
    // stations listed for the listener's places are asked too, a few at a time; each found station shows as it answers.
    let round = 0;
    const ask = () => {
      const mine = ++round, heard: PlayingStation[] = []; let tunein: PlayingStation[] | null = null, local = false;
      const stale = () => gone || mine !== round;
      const publish = () => {
        if (stale()) return;
        const ids = new Set<string>(), names = new Set<string>(), rows: PlayingStation[] = [];
        for (const r of [...heard, ...(tunein ?? [])]) { const n = fold(r.station.name); if (ids.has(r.station.id) || (n && names.has(n))) continue; ids.add(r.station.id); if (n) names.add(n); rows.push(r); }
        setInfo(was => { const next = { ...was }; for (const r of rows) next[r.station.id] = r.broadcast; return next; });
        setPlaying({ query, rows, done: tunein !== null && local });
      };
      const active = radioSession.get().station;
      const toAsk = stationsToAsk([starsRef.current, browseRef.current], 24).filter(s => s.id !== active?.id && fold(s.name) !== fold(active?.name ?? ''));
      // The answer is given within about 10 s; a station answering later still joins the list when it does.
      const deadline = setTimeout(() => { if (!local) { local = true; publish(); } }, 10000);
      void askStationsPlaying(query, toAsk, s => stationMetadata(s, false, 30000), row => { heard.push(row); publish(); }, { gone: stale, concurrency: 6, timeoutMs: 8000 }).finally(() => { clearTimeout(deadline); local = true; publish(); });
      void radioPlayingNow.search(query).then(rows => { tunein = rows; }, () => { tunein = []; }).finally(publish);
    };
    ask(); const timer = setInterval(ask, 60000);
    return () => { gone = true; clearInterval(timer); };
  }, [query, saved]);
  const ids = shown.map(s => s.id).join('|');
  /** RADIO-LIVE-001: the rows on screen (with a margin), as the browser reports them; null until it has. */
  const onScreen = useRef<Set<string> | null>(null);
  useEffect(() => {
    // Every listed station is asked, or once the browser reports which rows are on screen, those
    // rows (a row scrolled into view is asked at once). At most three requests at a time; a station
    // already being asked is never asked twice (stationMetadata shares the request in flight); a
    // tick never overlaps the last. Every 20 seconds while this tab is open and the document is
    // visible; hidden or left, it stops. Rows update in place: the last answer stays on screen.
    const p = new MetadataPoller(s => stationMetadata(s, false, RADIO_LIVE_MAX_AGE), (id, b) => {
      setInfo(was => ({ ...was, [id]: b }));
      // Try for the real song record behind the broadcaster's text: cover art, canonical names.
      void matchSongBroadcast(b).then(t => { if (t) setMatch(was => was[id] === t ? was : { ...was, [id]: t }); }).catch(() => {});
    }); poller.current = p;
    const polled = () => { const seen = onScreen.current; return seen ? shown.filter(s => seen.has(s.id)) : shown; };
    // The poller is told only when the set changes: a new set ends the round in flight, so a tick
    // skipped because a round is still out must not hand it the same set again.
    let lastSet = '';
    const place = () => { const list = polled(), key = list.map(s => s.id).join('|'); if (key !== lastSet) { lastSet = key; p.setStations(list); } };
    place();
    let pending = 0;
    const tick = () => { if (document.visibilityState === 'hidden') return; place(); pending++; setRefreshing(true); void Promise.resolve(p.tick()).finally(() => { if (--pending === 0) setRefreshing(false); }); };
    let io: IntersectionObserver | null = null, soon: ReturnType<typeof setTimeout> | null = null;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(entries => {
        const seen = new Set(onScreen.current ?? []);
        let added = false;
        for (const e of entries) { const id = (e.target as HTMLElement).dataset.stationId; if (!id) continue; if (e.isIntersecting) { added ||= !seen.has(id); seen.add(id); } else seen.delete(id); }
        onScreen.current = seen;
        // A row that came into view is asked soon (answers under 15 seconds old are reused).
        if (added && !soon) soon = setTimeout(() => { soon = null; tick(); }, 400);
      }, { rootMargin: '200px 0px' });
      for (const el of document.querySelectorAll<HTMLElement>('.radio-stations > .radio-station[data-station-id]')) io.observe(el);
    }
    tick(); const timer = setInterval(tick, 20000); document.addEventListener('visibilitychange', tick);
    return () => { p.stop(); clearInterval(timer); if (soon) clearTimeout(soon); io?.disconnect(); onScreen.current = null; document.removeEventListener('visibilitychange', tick); };
  }, [ids]);
  useEffect(() => { infoRef.current = info; shownRef.current = shown; starsRef.current = stars; });
  /** Row art preference: broadcaster artwork → matched song cover → station logo; a URL that failed to load is skipped. */
  const rowArt = (s: RadioStation): string => {
    const b = info[s.id] ? freshBroadcast(info[s.id]!) : null;
    for (const url of [b?.artwork, match[s.id]?.artwork, s.image]) if (url && !badArt[url]) return url;
    return '';
  };
  // RADIO-ART-003: passive re-pull. One retrier for the page re-asks the broadcaster (failed
  // probes) or the song catalogue (missing covers, forced past the negative cache) in the
  // background — fast first retry, bounded backoff, and a stop after a few attempts.
  useEffect(() => {
    const r = new BackgroundRetry(id => {
      const s = shownRef.current.find(x => x.id === id), raw = infoRef.current[id];
      const apply = (nb: Broadcast | null, t: Track | null) => { if (nb) setInfo(was => ({ ...was, [id]: nb })); if (t) setMatch(was => ({ ...was, [id]: t })); };
      if (s && (!raw || raw.state === 'failed' || raw.state === 'unavailable')) void stationMetadata(s, true).then(async nb => apply(nb, await matchSongBroadcast(nb, { force: true }))).catch(() => {});
      else if (raw) void matchSongBroadcast(freshBroadcast(raw), { force: true }).then(t => apply(null, t)).catch(() => {});
    });
    retrier.current = r;
    return () => { r.stop(); retrier.current = null; };
  }, []);
  // After every render, rows still showing a gap are asked again; rows whose data arrived settle.
  useEffect(() => {
    for (const s of shown) {
      const raw = info[s.id]; if (!raw) continue;
      const b = freshBroadcast(raw);
      const missing = b.state === 'failed' || (b.kind === 'song' && b.state === 'current' && !rowArt(s));
      if (missing) retrier.current?.ask(s.id); else retrier.current?.settle(s.id);
    }
  });
  /** RADIO-ART-002: a manual refresh re-asks the catalogue across platforms for covers still missing. */
  const refreshArt = () => {
    for (const s of shown) {
      const raw = info[s.id]; if (!raw) continue;
      const b = freshBroadcast(raw);
      if (b.kind === 'song' && b.state === 'current' && !(b.artwork || match[s.id]?.artwork)) void matchSongBroadcast(b, { force: true }).then(t => { if (t) setMatch(was => ({ ...was, [s.id]: t })); }).catch(() => {});
    }
  };
  const toggle = async (s: RadioStation) => { const next = stars.some(x => x.id === s.id) ? stars.filter(x => x.id !== s.id) : [...stars, s]; try { setStars(await saveFavouriteStations(next)); } catch { setError('The favourite station could not be saved. Try again.'); } };
  return <section className="card radio-page" aria-labelledby="radio-h">
    <header className="radio-page__header"><div><div className="eyebrow">LIVE AROUND THE WORLD</div><h1 id="radio-h" className="radio-page__title">Radio{/* RADIO-REFRESH-ICON-001 (owner, 2026-11-22): "the refresh stations button should just be a spining arrow icon thats inline with the label". It turns while the stations are being read again. */}<button className="iconbtn radio-page__refresh" type="button" aria-label="Refresh stations" title="Refresh stations" aria-busy={busy || refreshing} disabled={busy} onClick={() => { if (!saved) void load(0); void poller.current?.tick(); refreshArt(); }}><RadioRefreshGlyph size={16} className={busy || refreshing ? 'radio-refresh__icon' : 'radio-refresh__still'} /></button></h1><p>Find a place. Hear what’s happening there.</p></div></header>
    <form className={`search__form radio-search${draft ? ' has-text' : ''}`} role="search" onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); }}>
      <label className="sr" htmlFor="radio-q">Search radio stations worldwide, or the artist or song on air now</label>
      <span className="search__field">
        <span className="search__icon" aria-hidden="true">{busy || refreshing ? <RadioRefreshGlyph size={16} /> : <Glyph name="search" size={16} />}</span>
        <input id="radio-q" className="field" type="search" inputMode="search" enterKeyHint="search" autoComplete="off" spellCheck={false} placeholder="Search stations, artists or songs" value={draft}
          onChange={e => { const value = e.target.value; setDraft(value); if (value.trim()) { setLetter(''); setNumericMode(/^\d/.test(value.trim())); } }}
          onKeyDown={e => { if (e.key === 'Escape' && draft) { e.preventDefault(); setDraft(''); } }} />
        {draft && <button className="search__clear" type="button" aria-label="Clear station search" onClick={() => { setDraft(''); document.getElementById('radio-q')?.focus(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>}
        <span className="radio-search__filters">
          <button type="button" className="radio-search__filter" aria-label="Genre filter" aria-haspopup="listbox" aria-expanded={menu === 'genre'} data-set={tag ? '' : undefined} style={tag ? { ['--tone' as string]: genreTone(tag) } : undefined}
            onClick={() => setMenu(m => m === 'genre' ? '' : 'genre')}>{tag && <span className="radio-search__dot" aria-hidden="true" />}{tag ? (genreIdentity(tag)?.label ?? cap(tag)) : 'Genre'}<span className="radio-search__caret" aria-hidden="true">▾</span></button>
          <button type="button" className="radio-search__filter" aria-label="Location filter" aria-haspopup="listbox" aria-expanded={menu === 'country'} data-set={country || chosen.length ? '' : undefined}
            onClick={() => { setPlaceNote(''); setMenu(m => m === 'country' ? '' : 'country'); }}>{chosen.length ? `${chosen[0]!.label.split(',')[0]}${chosen.length > 1 ? ` +${chosen.length - 1}` : ''}` : country ? countryName(country) : 'Location'}<span className="radio-search__caret" aria-hidden="true">▾</span></button>
          <button type="button" className="radio-search__filter" aria-label="Language filter" aria-haspopup="listbox" aria-expanded={menu === 'language'} data-set={language ? '' : undefined}
            onClick={() => { setLangDraft(language); setMenu(m => m === 'language' ? '' : 'language'); }}>{language ? cap(language) : 'Language'}<span className="radio-search__caret" aria-hidden="true">▾</span></button>
        </span>
        {menu === 'genre' && <div className="radio-search__menu radio-search__menu--genre" role="listbox" aria-label="Choose a genre">
          <button type="button" role="option" aria-selected={!tag} onClick={() => { setTag(''); setMenu(''); }}>All genres</button>
          {GENRE_SECTIONS.map(x => <button type="button" role="option" key={x} aria-selected={tag === x} onClick={() => { setTag(x); setMenu(''); }}>
            <span className="radio-search__dot" aria-hidden="true" style={{ ['--tone' as string]: genreTone(x) }} />{genreIdentity(x)?.label ?? cap(x)}</button>)}
        </div>}
        {menu === 'country' && <div className="radio-search__menu radio-search__menu--places" role="listbox" aria-label="Choose a location">
          <button type="button" role="option" aria-selected={!country && !chosen.length} onClick={() => { setCountry(''); if (chosen.length) setPlaces(places.map(p => ({ ...p, selected: false }))); setMenu(''); }}>Anywhere</button>
          {/* RADIO-PLACES-001: type a city, address or region, save it, and choose any number of saved places. */}
          <div className="radio-search__lang radio-places__add">
            <input aria-label="Add a place" value={placeDraft} placeholder="City, address or region" autoComplete="off" spellCheck={false} disabled={placeBusy}
              onChange={e => { setPlaceDraft(e.target.value); setPlaceNote(''); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void addPlace(); } }} />
            <button type="button" aria-label="Save place" disabled={placeBusy || !placeDraft.trim()} onClick={() => void addPlace()}>{placeBusy ? 'Finding…' : 'Save'}</button>
          </div>
          {placeNote && <p className="radio-places__note" role="status">{placeNote}</p>}
          {places.length > 0 && <div className="radio-places" role="group" aria-label="Your places">
            {places.map(p => <div className="radio-places__row" key={p.id}>
              <label><input type="checkbox" checked={p.selected} onChange={() => { setCountry(''); setPlaces(places.map(x => x.id === p.id ? { ...x, selected: !x.selected } : x)); }} /><span className="radio-places__label">{p.label}</span></label>
              <button type="button" className="radio-places__remove" aria-label={`Remove ${p.label}`} title="Remove this place" onClick={() => setPlaces(places.filter(x => x.id !== p.id))}>×</button>
            </div>)}
          </div>}
          {countries.length > 0 && <div className="radio-places__heading" aria-hidden="true">Countries</div>}
          {countries.map(c => <button type="button" role="option" key={c.code} aria-selected={country === c.code} onClick={() => { setCountry(c.code); if (chosen.length) setPlaces(places.map(p => ({ ...p, selected: false }))); setMenu(''); }}>{countryName(c.code)}<span className="radio-search__count">{c.count}</span></button>)}
        </div>}
        {menu === 'language' && <div className="radio-search__menu" role="listbox" aria-label="Choose a language">
          <div className="radio-search__lang">
            <input aria-label="Language" value={langDraft} placeholder="Any language" onChange={e => setLangDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setLanguage(langDraft.trim().toLowerCase()); setMenu(''); } }} />
            <button type="button" aria-label="Apply language" onClick={() => { setLanguage(langDraft.trim().toLowerCase()); setMenu(''); }}>Apply</button>
          </div>
          <button type="button" role="option" aria-selected={!language} onClick={() => { setLanguage(''); setMenu(''); }}>Any language</button>
          {LANGUAGE_CHOICES.map(x => <button type="button" role="option" key={x} aria-selected={language === x} onClick={() => { setLanguage(x); setMenu(''); }}>{cap(x)}</button>)}
        </div>}
      </span>
    </form>
    <div className="radio-sections" role="group" aria-label="Station sections">
      <button type="button" className="btn" aria-pressed={!saved} onClick={() => setSaved(false)}>All stations</button>
      <button type="button" className="btn" aria-pressed={saved} onClick={() => setSaved(true)}>Starred stations ({stars.length})</button>
    </div>
    <div className={`radio-alphabet${numericMode ? ' radio-alphabet--numbers' : ''}`} ref={indexRef} role="group" aria-label={numericMode ? 'Station numbers' : 'Station alphabet'}>
      {(numericMode ? STATION_NUMBERS : STATION_LETTERS).map(initial => <button key={initial || 'all'} type="button" className="radio-alphabet__letter" aria-pressed={letter === initial}
        aria-label={initial === '#' ? 'Stations in other scripts and symbols' : initial ? `Stations beginning with ${initial}` : 'All station initials'}
        onClick={() => setLetter(initial)}>{initial || 'All'}</button>)}
      <button type="button" className="radio-alphabet__letter radio-alphabet__mode" aria-label={numericMode ? 'Show alphabet index' : 'Show number index'} onClick={() => { setLetter(''); setNumericMode(v => !v); }}>{numericMode ? 'ABC' : '0–9'}</button>
    </div>
    {error && <p role="alert" className="notice">{error} <button type="button" className="linkbtn" onClick={() => void load(lastRequested.current)}>Try again</button></p>}
    <div aria-busy={busy}>{busy && !shown.length ? <SkeletonList rows={6} label="Loading stations around the world…" art={ROW_COVER} /> : null}
      {!busy && !shown.length && !error && <p role="status">{saved ? stars.length ? 'No starred stations match these filters.' : 'Star a station to keep it here.' : hasMore ? 'No matches in this batch. More stations continues looking.' : 'No stations match these filters. Try another country, language or station name.'}</p>}
      {!saved && query && (activeNow || playing?.query === query) && <p className="radio-playing-note" role="status">{onAir.length ? `${onAir.length} station${onAir.length === 1 ? ' is' : 's are'} playing “${query}” right now` : playing?.done ? `No station is playing “${query}” right now` : `Checking which stations are playing “${query}” now…`}</p>}
      <ul className="radio-stations" aria-label="Radio stations">{shown.map(s => { const active = activeStation?.id === s.id, said = foundSaid.get(s.id), b = active && liveBroadcast ? freshBroadcast(liveBroadcast) : said ? freshBroadcast(said) : info[s.id] ? freshBroadcast(info[s.id]!) : null; const tags = radioTagBubbles(s, active ? live : undefined), starred = stars.some(x => x.id === s.id), artist = b?.artist ? radioArtistTarget(b.artist, match[s.id], b) : null; const play = () => { radioSession.setStations(shown); onTune(s); }; return <li key={s.id} data-station-id={s.id} className={`radio-station${active ? ' is-on' : ''}${onAirIds.has(s.id) ? ' radio-station--playing' : ''}`} onDoubleClick={e => { if (!(e.target instanceof Element) || e.target.closest('button, a, input, select, textarea, label, [role=button]')) return; window.getSelection?.()?.removeAllRanges(); play(); }}><Develop>
        <div className="radio-station__art">{(() => { const art = rowArt(s); return art ? <img src={art} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBadArt(was => ({ ...was, [art]: true }))} /> : <span aria-hidden="true">◉</span>; })()}</div>
        <div className="radio-station__body">
          {/* ROW-UNIFY-001 (owner, 2026-11-19): the station row reads like every song row: the cover, then the
              name, location, now playing and tags, then one row of buttons (Play, Star) under the text.
              Cut-off text scrolls (MARQUEE-001). RADIO-DBLCLICK-001: double-clicking the row plays it too. */}
          <div className="radio-station__info"><h2><Marquee className="radio-station__name" title={s.name}>{s.name}</Marquee></h2>
          <div className="radio-location" title={`${stationLocation(s)}${s.language ? ` · ${capWords(s.language)}` : ''}`}><Marquee>{stationLocation(s)}{s.language ? ` · ${capWords(s.language)}` : ''}</Marquee></div>
          <div className={`radio-now radio-now--${b?.state || 'loading'}`}><span className="radio-now__label">{b?.state === 'stale' ? 'Last published' : b?.state === 'current' ? b.kind === 'song' ? 'On air' : 'Programme' : 'Now playing'}</span><span className="radio-now__text" title={b?.title ? `${b.artist ? `${b.artist} — ` : ''}${b.title}` : undefined}><Marquee>{b?.title ? <>
            {b.artist && (onOpenArtist && artist ? <button type="button" className="artistlink radio-now__link" aria-label={`Open the artist ${artist.name}`} onClick={() => onOpenArtist(artist)}>{b.artist}</button> : b.artist)}{b.artist ? ' — ' : ''}
            {onPlaySong && match[s.id] ? <button type="button" className="artistlink radio-now__link" aria-label={`Play the song ${b.title}`} onClick={() => onPlaySong(match[s.id]!)}>{b.title}</button> : b.title}
          </> : b ? 'Programme information unavailable' : 'Checking broadcaster…'}</Marquee></span></div>
          {tags.length > 0 && <TagStrip className="radio-station__tags" label="Station genres" title={tags.map(g => g.label).join(', ')}>{tags.map((g, i) => <GenreBubbleView key={i} bubble={g} />)}</TagStrip>}</div>
          <div className="radio-station__actions song-actions">
            <PlayDisc className={`radio-station__play${active ? ' is-on' : ''}`} ready playing={active} label={`Play ${s.name}`} title={active ? 'This station is playing' : 'Play this station live'} onPlay={play} />
            <button type="button" className="iconbtn radio-station__star" aria-pressed={starred} aria-label={`Star station ${s.name}`} title={starred ? 'Starred station' : 'Star this station'} onClick={() => void toggle(s)}><Glyph name={starred ? 'heart-filled' : 'heart'} size={16} /></button>
          </div>
          <div className="radio-station__details">
            <span className="radio-station__meta">{[s.codec, s.bitrate ? `${s.bitrate} kbps` : ''].filter(Boolean).join(' · ')}{b && <time dateTime={new Date(b.checkedAt).toISOString()} title={b.detail || b.source}>{s.codec || s.bitrate ? ' · ' : ''}checked {new Date(b.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</span>
          </div>
        </div>
        </Develop></li>; })}</ul>
    </div>
    {!saved && hasMore && <button type="button" className="btn radio-more" disabled={busy} onClick={() => void load(nextOffset ?? 0)}>{busy ? 'Loading more…' : 'More stations'}</button>}
    <footer className="radio-note">Directory: Radio Browser and iHeart; songs on air now: the stations themselves and TuneIn. Listening starts from now; only the last ten minutes retained during this session can be rewound. Station availability and metadata are controlled by broadcasters.</footer>
  </section>;
}
