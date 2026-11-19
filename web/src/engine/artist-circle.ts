/**
 * ARTIST-CIRCLE-001 (owner, 2026-11-19): an artist page shows who the artist frequently works with, and similar
 * artists "based on platform data".
 *
 * - Frequent collaborators are counted from the credits the page already holds: every artist named on the artist's
 *   own songs and on the songs they feature on. One count per different song (a remix or the same song from a second
 *   service is the same song), and "frequent" means at least COLLAB_MIN_SONGS songs together.
 * - Similar artists are what the services themselves say: Deezer's related artists and YouTube Music's "Fans might
 *   also like" shelf, taking turns so neither buries the other, one row per artist.
 */
import type { ArtistSummary } from './artists';
import { fold, parseTitle } from './identity';

export const COLLAB_MIN_SONGS = 2;
/** How many of each the page lists. */
export const CIRCLE_MAX = 12;

/** Credits that are not a person or group to collaborate with. */
const NOT_AN_ARTIST = /^(various artists?|unknown artist|va|anonymous|traditional)$/i;

export interface Collaborator {
  name: string;
  /** Different songs the two are both credited on. */
  songs: number;
  /** Those songs' titles, as first seen, so the page can say which. */
  titles: string[];
}

type Credited = { title: string; artists?: readonly string[] | null; artist?: string | null };

const songKey = (t: Credited) => parseTitle(t.title).core || fold(t.title);

export function collaboratorsOf(who: string, tracks: readonly Credited[], opts: { min?: number; max?: number } = {}): Collaborator[] {
  const self = fold(who);
  const min = opts.min ?? COLLAB_MIN_SONGS;
  const by = new Map<string, { name: string; keys: Set<string>; titles: string[]; first: number }>();
  let order = 0;
  for (const t of tracks) {
    const names = (t.artists?.length ? t.artists : [t.artist ?? '']).map((n) => String(n ?? '').trim()).filter(Boolean);
    // Only songs the artist is on: a stray row that does not credit them says nothing about their circle.
    if (!names.some((n) => fold(n) === self)) continue;
    const key = songKey(t);
    for (const n of names) {
      const f = fold(n);
      if (!f || f === self || NOT_AN_ARTIST.test(n)) continue;
      let e = by.get(f);
      if (!e) by.set(f, (e = { name: n, keys: new Set(), titles: [], first: order++ }));
      if (e.keys.has(key)) continue;
      e.keys.add(key);
      e.titles.push(t.title);
    }
  }
  return [...by.values()]
    .filter((e) => e.keys.size >= min)
    .sort((a, b) => b.keys.size - a.keys.size || a.first - b.first)
    .slice(0, opts.max ?? CIRCLE_MAX)
    .map((e) => ({ name: e.name, songs: e.keys.size, titles: e.titles }));
}

export type SimilarArtist = ArtistSummary & { from: ('deezer' | 'ytmusic')[] };

/** Deezer's related artists and YouTube Music's "Fans might also like", in turns, one row per artist. */
export function mergeSimilar(who: string, deezer: readonly ArtistSummary[], ytmusic: readonly ArtistSummary[], max = CIRCLE_MAX): SimilarArtist[] {
  const self = fold(who);
  const out: SimilarArtist[] = [];
  const at = new Map<string, SimilarArtist>();
  const add = (a: ArtistSummary | undefined) => {
    if (!a) return;
    const f = fold(a.name);
    if (!f || f === self) return;
    const had = at.get(f);
    if (had) {
      if (!had.from.includes(a.provider)) had.from.push(a.provider);
      if (!had.picture && a.picture) had.picture = a.picture;
      if (!had.detail && a.detail) had.detail = a.detail;
      if (!had.alt && a.id !== had.id) had.alt = a.id;
      return;
    }
    const row: SimilarArtist = { ...a, from: [a.provider] };
    at.set(f, row);
    out.push(row);
  };
  for (let i = 0; i < Math.max(deezer.length, ytmusic.length); i++) {
    add(deezer[i]);
    add(ytmusic[i]);
  }
  return out.slice(0, max);
}
