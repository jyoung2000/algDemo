/**
 * ARTIST-FAV-001 (owner, 2026-11-21): "let the user favorite and star artist to have their discovery algorithim and
 * find my next favorite button without any customize discovery options take these artist into account when
 * recommending music and related artist ... let the user see and edit their artist list in the settings".
 *
 * A starred artist joins every Find my next favorite run as a starting point of its own: its radio, its top songs,
 * its related artists and their top songs are asked for like a starting song's, its name counts for the artist
 * factor, and its size counts toward the size the list aims for (ARTIST-SIZE-001). A star is about the artist, not
 * a song, so it never trains the song feedback and is kept apart from the starting songs.
 *
 * ARTIST-FAV-ALGO-001 (owner, 2026-11-22): "the starred artist only apply to the current algorithim preset and are
 * imported and exported with the algorithim". The list is kept per algorithm id; only the active algorithm's list
 * is shown, edited and used, and an algorithm file carries its own list.
 */
import { fold } from './identity';

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface FavArtist {
  name: string;
  /** The artist's Deezer id when known; found by name at the next run when not. */
  deezerId: string | null;
  /** Deezer followers when known (ARTIST-SIZE-001). */
  fans: number | null;
  picture: string | null;
  /** The page the star was given on ("dz:123", "yt:UC..."), to open it again from Settings. */
  pageId: string | null;
  addedAt: number;
}

export const FAV_ARTISTS_KEY = 'favourite_artists';
export const FAV_ARTISTS_MAX = 200;
/** How many starred artists one run asks about, newest first, so a long list still answers quickly. */
export const FAV_PER_RUN = 6;

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function normaliseFav(raw: unknown, now = Date.now()): FavArtist | null {
  const o = (raw ?? {}) as Dict;
  const name = str(o['name'], 200);
  if (!name || !fold(name)) return null;
  const dz = str(o['deezerId'], 20) || (/^dz:(\d{1,15})$/.exec(str(o['pageId'], 40))?.[1] ?? '');
  const fans = typeof o['fans'] === 'number' || (typeof o['fans'] === 'string' && o['fans'].trim()) ? Number(o['fans']) : NaN; // an unknown size stays unknown, never 0
  const picture = str(o['picture'], 2000);
  return {
    name,
    deezerId: /^\d{1,15}$/.test(dz) ? dz : null,
    fans: Number.isFinite(fans) && fans >= 0 ? Math.round(fans) : null,
    picture: /^https:\/\//.test(picture) ? picture : null,
    pageId: str(o['pageId'], 200) || null,
    addedAt: Number.isFinite(Number(o['addedAt'])) && Number(o['addedAt']) > 0 ? Number(o['addedAt']) : now,
  };
}

/** One entry per artist (by folded name), newest star first, at most FAV_ARTISTS_MAX. */
export function normaliseFavs(list: unknown, now = Date.now()): FavArtist[] {
  const all = (Array.isArray(list) ? list : []).map((raw) => normaliseFav(raw, now)).filter((a): a is FavArtist => a !== null);
  const out: FavArtist[] = [];
  const seen = new Set<string>();
  for (const a of all.sort((x, y) => y.addedAt - x.addedAt)) {
    if (seen.has(fold(a.name))) continue; // the newest star of an artist wins
    seen.add(fold(a.name)); out.push(a);
  }
  return out.slice(0, FAV_ARTISTS_MAX);
}

export function addFav(list: readonly FavArtist[], a: FavArtist): FavArtist[] {
  return normaliseFavs([a, ...list.filter((x) => fold(x.name) !== fold(a.name))]);
}

export function removeFav(list: readonly FavArtist[], name: string): FavArtist[] {
  return list.filter((x) => fold(x.name) !== fold(name));
}

export const isFav = (list: readonly FavArtist[], name: string): boolean => list.some((x) => fold(x.name) === fold(name));

export const favSeedKey = (a: Pick<FavArtist, 'name'>): string => `fav-artist|${fold(a.name)}`;

/**
 * The starred artist as a starting point for the gather and scoring steps: a seed with no song of its own, named by
 * the artist, whose Deezer profile carries only the artist id. Its key never collides with a song's.
 */
export function favSeed(a: FavArtist, deezerId: string | null): { seed: Dict; profile: Dict } {
  const key = favSeedKey(a);
  return {
    seed: { key, id: key, provider: 'favourite-artist', platform_id: deezerId ?? '', title: a.name, artists: [a.name], tags: [], emphasis: 1, fav_artist: true },
    profile: { dz: deezerId ? { artist_ids: { deezer: deezerId } } : null, ytm_vid: null, dz_uncertain: [] },
  };
}

/** Starred artists per algorithm id (ARTIST-FAV-ALGO-001). */
export type FavByAlgorithm = Record<string, FavArtist[]>;
const ALG_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The stored value as lists per algorithm. A list stored before lists were per algorithm (a bare array) belongs to
 * the algorithm that was active when it is first read, so nobody's stars move to another preset or vanish.
 */
export function favMap(raw: unknown, activeId: string): FavByAlgorithm {
  if (Array.isArray(raw)) return { [activeId]: normaliseFavs(raw) };
  const out: FavByAlgorithm = {};
  if (raw && typeof raw === 'object') {
    for (const [id, list] of Object.entries(raw as Record<string, unknown>)) if (ALG_ID.test(id)) out[id] = normaliseFavs(list);
  }
  return out;
}

/** What an algorithm file carries for each starred artist: enough to find it again, nothing device-bound. */
export interface ExportedFav { name: string; deezerId: string | null; fans: number | null; pageId: string | null }
export const exportFavs = (list: readonly FavArtist[]): ExportedFav[] =>
  list.map((a) => ({ name: a.name, deezerId: a.deezerId, fans: a.fans, pageId: a.pageId }));

/** An algorithm file's artists, newest first as exported; throws an English message when they are not a list. */
export function importFavs(raw: unknown, now = Date.now()): FavArtist[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('The starred artists in this file must be a list.');
  if (raw.length > FAV_ARTISTS_MAX) throw new Error(`An algorithm file can carry at most ${FAV_ARTISTS_MAX} starred artists.`);
  // Keep the file's order: the first artist is the newest star.
  return normaliseFavs(raw.map((a, i) => ({ ...(a && typeof a === 'object' ? a : {}), addedAt: now - i })));
}
