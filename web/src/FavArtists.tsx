/**
 * ARTIST-FAV-001 (owner, 2026-11-21): "let the user favorite and star artist to have their discovery algorithim and
 * find my next favorite button ... take these artist into account ... let the user see and edit their artist list in
 * the settings".
 */
import { useState, useSyncExternalStore } from 'react';
import { Glyph } from '@now-playing/aqua-ui/icons';
import { favArtistsStore } from './fav-artists-store';
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
      <Glyph name={starred ? 'star-filled' : 'star'} size={16} />
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
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setError(null);
    try { await favArtistsStore.add({ name: n }); setName(''); } catch { setError(`${n} could not be added. Try again.`); }
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
              <Glyph name="star-filled" size={14} className="fav-artists__mark" />
              <span className="fav-artists__name">{a.name}</span>
              <button type="button" className="btn fav-artists__remove" aria-label={`Remove ${a.name} from your artists`} title={`Remove ${a.name}`}
                onClick={() => void favArtistsStore.remove(a.name).catch(() => setError(`${a.name} could not be removed. Try again.`))}>
                <Glyph name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="fav-artists__add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label htmlFor={id('fav-artist-add')} className="fav-artists__label">Add an artist</label>
        <input id={id('fav-artist-add')} className="field" type="text" value={name} maxLength={200} placeholder="Artist name"
          autoComplete="off" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn fav-artists__submit" disabled={!name.trim()}>Add</button>
      </form>
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
