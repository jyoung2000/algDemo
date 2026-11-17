import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MetadataPoller, freshBroadcast, stationLocation, type RadioStation, type Broadcast } from './engine/radio';
import { favouriteStations, saveFavouriteStations, matchSongBroadcast, radioDirectory, radioSession, stationMetadata } from './engine/radio-client';
import { genreIdentity } from './engine/genre-identity';
import { GenreBubbleView } from './Results';
import { Glyph } from '@now-playing/aqua-ui/icons';
import './radio.css';
const countryName = (code: string) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code; } catch { return code; } };
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
/** Directory country/language words arrive lowercase ('french', 'united states'); show them as names. */
const capWords = (v: string) => v.split(/\s+/).map(cap).join(' ');
/** Codec names, bitrates and filler words a directory stuffs into tags; they are not what a station plays. */
const TAG_NOISE = /^(aac|aac\+?p?|mp3|ogg|vorbis|flac|opus|wma|hls|m3u8?|pls|https?|\d+(\s*k(bps)?)?|fm|am|dab\+?|radio|station|stations|streaming|stream|music|misc|various|unspecified|unknown|undefined)$/i;
/** RADIO-UI-004: an off-picker topic keeps a lively, deterministic tone instead of a flat grey. */
const TOPIC_TONES = ['#e1712d', '#2d9ee1', '#8e3a6f', '#442de1', '#1f9d55', '#d23b68', '#b8860b', '#0e8f8f', '#7a3be1', '#c2571a', '#3867d6', '#20bf6b'];
function topicTone(label: string): string { let h = 0; for (const ch of label.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return TOPIC_TONES[h % TOPIC_TONES.length]!; }
/** The music list's colour for a directory topic, however it is spelt. */
function stationBubbles(tags: string[]): { label: string; color: string; sub: boolean }[] {
  const seen = new Set<string>(); const out: { label: string; color: string; sub: boolean }[] = [];
  for (const raw of tags) {
    const word = raw.trim(); if (!word || TAG_NOISE.test(word)) continue;
    const id = genreIdentity(word);
    const label = id?.label ?? cap(word);
    const key = id?.key ?? `topic:${label.toLowerCase()}`;
    if (seen.has(key)) continue; seen.add(key);
    out.push({ label, color: id?.color ?? topicTone(label), sub: out.length > 0 });
    if (out.length === 3) break;
  }
  return out;
}
const GENRE_SECTIONS = ['jazz', 'classical', 'rock', 'pop', 'hip hop', 'r&b', 'electronic', 'house', 'techno', 'ambient', 'metal', 'country', 'latin', 'reggae', 'soul', 'blues', 'folk', 'news', 'talk', 'world'] as const;
const LANGUAGE_CHOICES = ['english', 'spanish', 'french', 'german', 'italian', 'portuguese', 'dutch', 'arabic', 'hindi', 'japanese', 'korean', 'chinese'] as const;
const genreTone = (word: string) => genreIdentity(word)?.color ?? topicTone(word);
function readStars(): RadioStation[] { try { return JSON.parse(localStorage.getItem('airwave:radio-stations') || '[]') as RadioStation[]; } catch { return []; } }
export function Radio({ onTune }: { onTune: (s: RadioStation) => void }) {
  const activeStation = useSyncExternalStore(radioSession.subscribe, () => radioSession.get().station);
  const [stations, setStations] = useState<RadioStation[]>([]), [countries, setCountries] = useState<{ name: string; code: string; count: number }[]>([]);
  const [query, setQuery] = useState(''), [country, setCountry] = useState(''), [language, setLanguage] = useState(''), [tag, setTag] = useState('');
  const [draft, setDraft] = useState(''), [menu, setMenu] = useState<'' | 'genre' | 'country' | 'language'>(''), [langDraft, setLangDraft] = useState(''), [stars, setStars] = useState(readStars), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [hasMore, setHasMore] = useState(true), [page, setPage] = useState(0);
  const [info, setInfo] = useState<Record<string, Broadcast>>({});
  const [match, setMatch] = useState<Record<string, { title: string; artwork?: string; artists?: string[] } | null>>({});
  const [refreshing, setRefreshing] = useState(false); const generation = useRef(0); const poller = useRef<MetadataPoller | null>(null);
  const matchingStars = stars.filter(s => (!query || s.name.toLowerCase().includes(query.toLowerCase())) && (!country || s.countryCode === country) && (!language || s.language.toLowerCase().includes(language.toLowerCase())) && (!tag || s.tags.includes(tag)));
  const shown = saved ? matchingStars : [...new Map([...matchingStars, ...stations].map(s => [s.id, s])).values()];
  useEffect(() => { let live = true; const read = () => { void favouriteStations().then(v => { if (live) setStars(v); }); }; read(); window.addEventListener('airwave-radio-favourites', read); return () => { live = false; window.removeEventListener('airwave-radio-favourites', read); }; }, []);
  useEffect(() => { let gone = false; void radioDirectory.countries().then(v => { if (!gone) setCountries(v.sort((a, b) => countryName(a.code).localeCompare(countryName(b.code)))); }).catch(() => {}); return () => { gone = true; }; }, []);
  const load = async (offset: number) => {
    const g = ++generation.current; setBusy(true); setError('');
    try { const rows = await radioDirectory.search({ query, country, language, tag, offset }); if (g !== generation.current) return; setStations(was => offset ? [...new Map([...was, ...rows].map(s => [s.id, s])).values()] : rows); setHasMore(rows.length === 24); setPage(offset / 24); }
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
  useEffect(() => { if (!saved) void load(0); return () => { generation.current++; }; }, [query, country, language, tag, saved]);
  const ids = shown.map(s => s.id).join('|');
  useEffect(() => {
    // Every loaded station is asked, not only the selected one. Network calls are bounded to three
    // at once, refresh once a minute, and stop when this page is hidden or left.
    const p = new MetadataPoller(s => stationMetadata(s), (id, b) => {
      setInfo(was => ({ ...was, [id]: b }));
      // Try for the real song record behind the broadcaster's text: cover art, canonical names.
      void matchSongBroadcast(b).then(t => { if (t) setMatch(was => ({ ...was, [id]: { title: t.title, artwork: t.artwork, artists: t.artists || (t.artist ? [t.artist] : []) } })); }).catch(() => {});
    }); poller.current = p; p.setStations(shown);
    let pending = 0;
    const tick = () => { if (document.visibilityState === 'hidden') return; pending++; setRefreshing(true); void Promise.resolve(p.tick()).finally(() => { if (--pending === 0) setRefreshing(false); }); };
    tick(); const timer = setInterval(tick, 60000); document.addEventListener('visibilitychange', tick);
    return () => { p.stop(); clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [ids]);
  const toggle = async (s: RadioStation) => { const next = stars.some(x => x.id === s.id) ? stars.filter(x => x.id !== s.id) : [...stars, s]; try { setStars(await saveFavouriteStations(next)); } catch { setError('The favourite station could not be saved. Try again.'); } };
  return <section className="card radio-page" aria-labelledby="radio-h">
    <header className="radio-page__header"><div><div className="eyebrow">LIVE AROUND THE WORLD</div><h1 id="radio-h">Radio</h1><p>Find a place. Hear what’s happening there.</p></div><button className="btn" type="button" disabled={busy} onClick={() => { if (!saved) void load(0); void poller.current?.tick(); }}>Refresh stations</button></header>
    <form className={`search__form radio-search${draft ? ' has-text' : ''}`} role="search" onSubmit={e => { e.preventDefault(); setQuery(draft.trim()); }}>
      <label className="sr" htmlFor="radio-q">Search radio stations worldwide</label>
      <span className="search__field">
        <span className="search__icon" aria-hidden="true">{busy || refreshing ? <svg className="radio-refresh__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" /></svg> : <Glyph name="search" size={16} />}</span>
        <input id="radio-q" className="field" type="search" inputMode="search" enterKeyHint="search" autoComplete="off" spellCheck={false} placeholder="Search stations worldwide" value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && draft) { e.preventDefault(); setDraft(''); } }} aria-describedby="radio-q-hint" />
        {draft && <button className="search__clear" type="button" aria-label="Clear station search" onClick={() => { setDraft(''); document.getElementById('radio-q')?.focus(); }}>
          <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>}
        <span className="radio-search__filters">
          <button type="button" className="radio-search__filter" aria-label="Genre filter" aria-haspopup="listbox" aria-expanded={menu === 'genre'} data-set={tag ? '' : undefined} style={tag ? { ['--tone' as string]: genreTone(tag) } : undefined}
            onClick={() => setMenu(m => m === 'genre' ? '' : 'genre')}>{tag && <span className="radio-search__dot" aria-hidden="true" />}{tag ? (genreIdentity(tag)?.label ?? cap(tag)) : 'Genre'}<span className="radio-search__caret" aria-hidden="true">▾</span></button>
          <button type="button" className="radio-search__filter" aria-label="Country filter" aria-haspopup="listbox" aria-expanded={menu === 'country'} data-set={country ? '' : undefined}
            onClick={() => setMenu(m => m === 'country' ? '' : 'country')}>{country ? countryName(country) : 'Country'}<span className="radio-search__caret" aria-hidden="true">▾</span></button>
          <button type="button" className="radio-search__filter" aria-label="Language filter" aria-haspopup="listbox" aria-expanded={menu === 'language'} data-set={language ? '' : undefined}
            onClick={() => { setLangDraft(language); setMenu(m => m === 'language' ? '' : 'language'); }}>{language ? cap(language) : 'Language'}<span className="radio-search__caret" aria-hidden="true">▾</span></button>
        </span>
        {menu === 'genre' && <div className="radio-search__menu radio-search__menu--genre" role="listbox" aria-label="Choose a genre">
          <button type="button" role="option" aria-selected={!tag} onClick={() => { setTag(''); setMenu(''); }}>All genres</button>
          {GENRE_SECTIONS.map(x => <button type="button" role="option" key={x} aria-selected={tag === x} onClick={() => { setTag(x); setMenu(''); }}>
            <span className="radio-search__dot" aria-hidden="true" style={{ ['--tone' as string]: genreTone(x) }} />{genreIdentity(x)?.label ?? cap(x)}</button>)}
        </div>}
        {menu === 'country' && <div className="radio-search__menu" role="listbox" aria-label="Choose a country">
          <button type="button" role="option" aria-selected={!country} onClick={() => { setCountry(''); setMenu(''); }}>Anywhere</button>
          {countries.map(c => <button type="button" role="option" key={c.code} aria-selected={country === c.code} onClick={() => { setCountry(c.code); setMenu(''); }}>{countryName(c.code)}<span className="radio-search__count">{c.count}</span></button>)}
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
    <p id="radio-q-hint" className="search__hint">Type a station’s name; results update as you type. Genre, country and language narrow the list from inside the bar.{refreshing && <span className="sr" role="status">Updating station information</span>}</p>
    <div className="radio-sections" role="group" aria-label="Station sections">
      <button type="button" className="btn" aria-pressed={!saved} onClick={() => setSaved(false)}>Worldwide</button>
      <button type="button" className="btn" aria-pressed={saved} onClick={() => setSaved(true)}>Starred stations ({stars.length})</button>
    </div>
    <p className="radio-note">Names and locations come from the community directory. Current song or programme comes from the broadcaster; some stations don’t publish it. “Unavailable” is not a guess. Radio uses continuous internet data.</p>
    {error && <p role="alert" className="notice">{error} <button type="button" className="linkbtn" onClick={() => void load(page * 24)}>Try again</button></p>}
    <div aria-busy={busy}>{busy && !shown.length ? <p role="status">Loading stations around the world…</p> : null}
      {!busy && !shown.length && !error && <p role="status">{saved ? 'Star a station to keep it here.' : 'No stations match these filters. Try another country, language or station name.'}</p>}
      <ul className="radio-stations" aria-label="Radio stations">{shown.map(s => { const b = info[s.id] ? freshBroadcast(info[s.id]!) : null, active = activeStation?.id === s.id; return <li key={s.id} className={`radio-station${active ? ' is-on' : ''}`}>
        <div className="radio-station__art">{(() => { const art = b?.artwork || match[s.id]?.artwork || s.image; return art ? <img src={art} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = 'none'; }} /> : <span aria-hidden="true">◉</span>; })()}</div>
        <div className="radio-station__body"><h2>{s.name}{stars.some(x => x.id === s.id) && <span className="radio-starred"> · Starred</span>}</h2><div className="radio-location">{stationLocation(s)}{s.language ? ` · ${capWords(s.language)}` : ''}</div>
          <div className={`radio-now radio-now--${b?.state || 'loading'}`}><span className="radio-now__label">{b?.state === 'stale' ? 'Last published' : b?.state === 'current' ? b.kind === 'song' ? 'On air' : 'Programme' : 'Now playing'}</span><span>{b?.title ? `${b.artist ? b.artist + ' — ' : ''}${b.title}` : b ? 'Programme information unavailable' : 'Checking broadcaster…'}</span></div>
          <div className="radio-station__details">{(() => { const tags = stationBubbles(s.tags); return <>
            {tags.length > 0 && <span className="radio-station__tags">{tags.map((g, i) => <GenreBubbleView key={i} bubble={g} />)}</span>}
            <span className="radio-station__meta">{[s.codec, s.bitrate ? `${s.bitrate} kbps` : ''].filter(Boolean).join(' · ')}{b && <time dateTime={new Date(b.checkedAt).toISOString()} title={b.detail || b.source}>{s.codec || s.bitrate ? ' · ' : ''}checked {new Date(b.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}</span>
          </>; })()}</div>
        </div>
        <div className="radio-station__actions"><button type="button" className="btn btn--primary" aria-label={`Play ${s.name}`} onClick={() => { radioSession.setStations(shown); onTune(s); }}>{active ? 'Playing' : 'Play'}</button><button type="button" className="iconbtn" aria-pressed={stars.some(x => x.id === s.id)} aria-label={`Star station ${s.name}`} onClick={() => void toggle(s)}>☆</button></div>
      </li>; })}</ul>
    </div>
    {!saved && hasMore && <button type="button" className="btn radio-more" disabled={busy} onClick={() => void load((page + 1) * 24)}>{busy ? 'Loading more…' : 'More stations'}</button>}
    <footer className="radio-note">Directory: Radio Browser. Listening starts from now; only the last five minutes heard during this session can be rewound. Station availability and metadata are controlled by broadcasters.</footer>
  </section>;
}
