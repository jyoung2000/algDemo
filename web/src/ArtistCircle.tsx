import type { ArtistTarget, Track } from './api';
import { CIRCLE_MAX, COLLAB_MIN_SONGS, collaboratorsOf, type SimilarArtist } from './engine/artist-circle';
import { fold } from './engine/identity';
import { PROVIDER_LABEL } from './util';

/**
 * ARTIST-CIRCLE-001 (owner, 2026-11-19): "add a section for frequent collaborators so users can see other artist a
 * person frequently collaborates with and a similar artist section that finds similar artist based on platform data".
 * Each name opens that artist's page.
 */
export function ArtistCircle({ name, songs, features, similar, waiting, onOpenArtist }: {
  name: string;
  songs: readonly Track[];
  features: readonly Track[];
  similar: readonly SimilarArtist[];
  /** Songs are still being found, so the collaborator count may grow. */
  waiting: boolean;
  onOpenArtist: (t: ArtistTarget) => void;
}) {
  const collabs = collaboratorsOf(name, [...songs, ...features]);
  const pics = new Map(similar.map((s) => [fold(s.name), s.picture] as const));
  return (
    <>
      <section className="artist-circle" aria-labelledby="artist-collab-h">
        <h3 id="artist-collab-h" className="albums__h">Frequent collaborators{collabs.length ? ` (${collabs.length})` : ''}</h3>
        {collabs.length > 0 ? (
          <>
            <p className="artist__hint">Artists credited with {name} on {COLLAB_MIN_SONGS} or more different songs listed here, most first.</p>
            <ul className="artist-circle__list" aria-label={`Frequent collaborators of ${name}`}>
              {collabs.map((c) => {
                const pic = pics.get(fold(c.name));
                return (
                  <li key={c.name}>
                    <button type="button" className="artist-circle__card" onClick={() => onOpenArtist({ name: c.name })}
                      title={`${c.songs} songs together: ${c.titles.slice(0, 4).join(', ')}${c.titles.length > 4 ? '\u2026' : ''}`}
                      aria-label={`Open ${c.name}, ${c.songs} songs together`}>
                      {pic ? <img className="artist-circle__pic" src={pic} alt="" /> : <span className="artist-circle__pic artist-circle__pic--none" aria-hidden="true">{c.name.slice(0, 1)}</span>}
                      <span className="artist-circle__name">{c.name}</span>
                      <span className="artist-circle__meta">{c.songs} songs together</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="state" role="status">{waiting ? `Looking through ${name}\u2019s songs for collaborators\u2026` : `No artist shares ${COLLAB_MIN_SONGS} or more songs with ${name} in what was found.`}</p>
        )}
      </section>
      <section className="artist-circle" aria-labelledby="artist-similar-h">
        <h3 id="artist-similar-h" className="albums__h">Similar artists{similar.length ? ` (${similar.length})` : ''}</h3>
        {similar.length > 0 ? (
          <>
            <p className="artist__hint">From Deezer’s related artists and YouTube Music’s “Fans might also like”.</p>
            <ul className="artist-circle__list" aria-label={`Artists similar to ${name}`}>
              {similar.slice(0, CIRCLE_MAX).map((s) => (
                <li key={s.id}>
                  <button type="button" className="artist-circle__card" onClick={() => onOpenArtist({ id: s.id, name: s.name })} aria-label={`Open ${s.name}`}>
                    {s.picture ? <img className="artist-circle__pic" src={s.picture} alt="" /> : <span className="artist-circle__pic artist-circle__pic--none" aria-hidden="true">{s.name.slice(0, 1)}</span>}
                    <span className="artist-circle__name">{s.name}</span>
                    <span className="artist-circle__meta">{s.from.map((p) => PROVIDER_LABEL[p] ?? p).join(' \u00B7 ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="state" role="status">Neither Deezer nor YouTube Music listed similar artists for {name}.</p>
        )}
      </section>
    </>
  );
}
