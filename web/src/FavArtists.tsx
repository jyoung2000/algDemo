/**
 * ARTIST-FAV-001 (owner, 2026-11-21): "let the user favorite and star artist to have their discovery algorithim and
 * find my next favorite button ... take these artist into account ... let the user see and edit their artist list in
 * the settings".
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, type ArtistSummary } from './api';
import { Art } from './Art';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { favArtistsStore } from './fav-artists-store';
import { ArtistHeartGlyph } from './icons';
import './fav-artists.css';

const useStarred = (name: string): boolean => useSyncExternalStore(favArtistsStore.subscribe, () => favArtistsStore.has(name));

/**
 * The star beside an artist page's Play button, and on an artist in the search results (`row`). Black and white until
 * tapped, then a blue disc with a filled white star (ARTIST-STAR-LOOK-001).
 */
export function ArtistStarButton({ artist, row = false }: { artist: { id: string; name: string; picture: string | null; fans?: number | null }; row?: boolean }) {
  const starred = useStarred(artist.name);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (starred) await favArtistsStore.remove(artist.name);
      else await favArtistsStore.add({ name: artist.name, pageId: artist.id, fans: artist.fans ?? null, picture: artist.picture });
    } catch { /* the star keeps its last known state */ } finally { setBusy(false); }
  };
  return (
    <button type="button" className={row ? 'iconbtn artist__star artist__star--row' : 'push artist__star'} aria-pressed={starred} disabled={busy}
      aria-label={starred ? `Unstar ${artist.name}` : `Star ${artist.name}: your discovery takes this artist into account`}
      title={starred ? `Starred: Find my next favorite takes ${artist.name} into account` : `Star ${artist.name}`}
      onClick={() => void toggle()}>
      <Glyph name={starred ? 'heart-filled' : 'heart'} size={16} />
    </button>
  );
}

/**
 * PLAYER-ARTIST-HEART-001 (owner, 2026-11-22): in the player, where the volume was, "a button and icon to heart the
 * current playing artist on the song and add them to your listening algorithim". One press stars every artist
 * credited on what is playing (the active algorithm's starred artists, which discovery takes into account); it shows
 * as on once all of them are starred, and a press then takes them off again.
 */
export function PlayingArtistHeart({ artists, variant = 'quiet' }: { artists: readonly string[]; variant?: 'quiet' | 'icon' }) {
  const names = artists.map((n) => n.trim()).filter(Boolean);
  const sig = names.join('\n');
  // A primitive, as useSyncExternalStore needs: true once every artist of the song is starred.
  const starred = useSyncExternalStore(favArtistsStore.subscribe, () => names.length > 0 && names.every((n) => favArtistsStore.has(n)));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [sig]);
  const toggle = async () => {
    if (busy || !names.length) return;
    setBusy(true);
    try {
      if (starred) for (const n of names) await favArtistsStore.remove(n);
      else for (const n of names) if (!favArtistsStore.has(n)) await favArtistsStore.add({ name: n });
    } catch { /* the heart keeps its last known state */ } finally { setBusy(false); }
  };
  const who = names.join(', ');
  const label = !names.length ? 'Star the artist: no artist is known for what is playing'
    : starred ? `Unstar ${who}`
    : `Star ${who}: your discovery takes ${names.length === 1 ? 'this artist' : 'these artists'} into account`;
  return (
    <button type="button" className={`${variant === 'icon' ? 'iconbtn' : 'quiet-control'} artist-heart`} aria-pressed={starred} disabled={busy || !names.length}
      aria-label={label} title={!names.length ? 'No artist known' : starred ? `Starred: Find my next favorite takes ${who} into account` : `Star ${who}`}
      onClick={() => void toggle()}>
      <span className="artist-heart__disc"><ArtistHeartGlyph size={17} on={starred} /></span>
    </button>
  );
}

/**
 * Every starred artist of the active algorithm, each with a remove button, and a field to add one by name. Shown in
 * Settings and on the Profile tab (ARTIST-FAV-ALGO-001: "ensure in the profile tab users can remove artist from there
 * artist list"); the two are the same list.
 */
export function FavArtistsSettings({ where = 'settings' }: { where?: 'settings' | 'profile' }) {
  const list = useSyncExternalStore(favArtistsStore.subscribe, favArtistsStore.get);
  const algName = useSyncExternalStore(favArtistsStore.subscribe, favArtistsStore.algorithmName);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = (s: string) => `${s}-${where}`;
  // ARTIST-ADD-SEARCH-001 (owner, 2026-11-22): "ensure the add artist ui and ux fits with the rest of the app and looks
  // like the other search boxes". The same search box as Discover and Radio; as you type it suggests real artists
  // (picture and fans), so the star carries the right artist and its size; Enter adds the exact match or the words.
  const [found, setFound] = useState<ArtistSummary[]>([]);
  useEffect(() => {
    const q = name.trim();
    if (q.length < 2) { setFound([]); return; }
    const c = new AbortController();
    const t = window.setTimeout(() => {
      Promise.resolve().then(() => api.searchArtists(q, c.signal)).then((r) => { if (!c.signal.aborted) setFound(r.artists.slice(0, 5)); }, () => undefined);
    }, 350);
    return () => { window.clearTimeout(t); c.abort(); };
  }, [name]);
  const addArtist = async (a: { name: string; pageId?: string | null; fans?: number | null; picture?: string | null }) => {
    setError(null);
    try { await favArtistsStore.add(a); setName(''); setFound([]); } catch { setError(`${a.name} could not be added. Try again.`); }
  };
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    const exact = found.find((a) => a.name.trim().toLowerCase() === n.toLowerCase());
    await addArtist(exact ? { name: exact.name, pageId: exact.id, fans: exact.fans ?? null, picture: exact.picture } : { name: n });
  };
  const body = (
    <>
      <p className="note">
        Artists you star (the star on an artist page or an artist in search, or added here) are starting points for
        Find my next favorite and your discovery: their songs, their related artists, and artists of a similar size.
        {algName ? <> They belong to the algorithm <strong>“{algName}”</strong>: each algorithm has its own list, and it
        is exported and imported with it.</> : null}
      </p>
      {list.length === 0 ? (
        <p className="note fav-artists__empty">No starred artists yet. Star one on its artist page, or add one below.</p>
      ) : (
        <ul className="fav-artists__list" aria-label="Your starred artists">
          {list.map((a) => (
            <li key={a.name} className="fav-artists__row">
              <Glyph name="heart-filled" size={14} className="fav-artists__mark" />
              <span className="fav-artists__name">{a.name}</span>
              <button type="button" className="btn fav-artists__remove" aria-label={`Remove ${a.name} from your artists`} title={`Remove ${a.name}`}
                onClick={() => void favArtistsStore.remove(a.name).catch(() => setError(`${a.name} could not be removed. Try again.`))}>
                <Glyph name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className={`search__form fav-artists__add${name ? ' has-text' : ''}`} role="search" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label className="sr" htmlFor={id('fav-artist-add')}>Add an artist to your artists</label>
        <span className="search__field">
          <span className="search__icon" aria-hidden="true"><Glyph name="search" size={16} /></span>
          <input id={id('fav-artist-add')} className="field" type="search" inputMode="search" enterKeyHint="done" value={name} maxLength={200}
            placeholder="Add an artist" autoComplete="off" spellCheck={false} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && name) { e.preventDefault(); setName(''); } }} />
          {name && <button className="search__clear" type="button" aria-label="Clear artist search" onClick={() => { setName(''); document.getElementById(id('fav-artist-add'))?.focus(); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>}
        </span>
      </form>
      {found.length > 0 && (
        <ul className="well tracks fav-artists__found" aria-label="Artists to add">
          {found.map((a) => {
            const on = list.some((x) => x.name.trim().toLowerCase() === a.name.trim().toLowerCase());
            return (
              <li key={a.id} className="track album-row">
                <span className="artist-pic"><Art src={a.picture} size={44} /></span>
                <span className="track__text">
                  <span className="track__title">{a.name}</span>
                  <span className="track__meta">Artist{a.detail ? ` \u00b7 ${a.detail}` : ''}</span>
                </span>
                <button type="button" className="iconbtn artist__star artist__star--row" aria-pressed={on} disabled={on}
                  aria-label={on ? `${a.name} is in your artists` : `Add ${a.name} to your artists`}
                  onClick={() => void addArtist({ name: a.name, pageId: a.id, fans: a.fans ?? null, picture: a.picture })}>
                  <Glyph name={on ? 'heart-filled' : 'heart'} size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="note" role="alert">{error}</p>}
    </>
  );
  return where === 'profile' ? (
    <section className="card fav-artists" aria-labelledby={id('fav-artists-h')}>
      <h2 id={id('fav-artists-h')}>Your artists</h2>
      {body}
    </section>
  ) : (
    <section className="discovery-settings fav-artists" aria-labelledby={id('fav-artists-h')}>
      <h3 id={id('fav-artists-h')}>Your artists</h3>
      {body}
    </section>
  );
}
