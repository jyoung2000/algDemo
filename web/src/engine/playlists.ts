/**
 * PLAYLISTS-001. Saved lists the listener makes and names.
 *
 * Every function here is pure: it takes the current lists and returns new ones, so the engine can
 * persist the result and the tests can reason about it without a store.
 *
 * Two rules the owner set:
 *  - a song may sit in several lists at once, and adding it twice changes nothing;
 *  - discovery must not top a saved list up until every song already in it has been played.
 */

export const PLAYLIST_NAME_MAX = 60;
export const PLAYLISTS_MAX = 50;
export const PLAYLIST_TRACKS_MAX = 500;
/** ALBUM-SAVE-001: saved albums have their own room, so they never crowd out the listener's lists. */
export const ALBUMS_MAX = 100;

export interface PlaylistEntry {
  key: string;
  added: number;
}

/** ALBUM-SAVE-001: the album a saved album came from (its songs are the list's entries). */
export interface AlbumRef {
  id: string;
  provider: string;
  artist: string;
  artwork: string | null;
  year: string | null;
  kind: string;
  url: string;
}

export interface Playlist {
  id: string;
  name: string;
  created: number;
  entries: PlaylistEntry[];
  /** Set on a saved album: it keeps the album's name and songs and is found again by the album's id. */
  album?: AlbumRef;
}

export const isAlbumList = (l: Pick<Playlist, 'album'>): boolean => Boolean(l.album);

/** Collapse the whitespace a text field invites, and keep the name short enough to render. */
export function normaliseName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLAYLIST_NAME_MAX);
}

/** Two lists called "Late night" and "late  night" are the same list to a person. */
function sameName(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** The listener's own list with this name; a saved album may share a name with a list. */
export function findByName(lists: Playlist[], name: string): Playlist | undefined {
  const wanted = normaliseName(name);
  return lists.find((l) => !l.album && sameName(l.name, wanted));
}

export class PlaylistError extends Error {}

/**
 * Make a list. Rejects a blank name, a name already taken, and the point where the listener has
 * more lists than the UI can sensibly show.
 */
export function createPlaylist(lists: Playlist[], name: unknown, now: number, id: string): Playlist[] {
  const clean = normaliseName(name);
  if (!clean) throw new PlaylistError('A list needs a name.');
  if (findByName(lists, clean)) throw new PlaylistError(`You already have a list called “${clean}”.`);
  if (lists.filter((l) => !l.album).length >= PLAYLISTS_MAX) throw new PlaylistError(`You can keep up to ${PLAYLISTS_MAX} lists.`);
  return [...lists, { id, name: clean, created: now, entries: [] }];
}

/**
 * ALBUM-SAVE-001: keep an album in Saved, its songs in album order. An album already saved (same album
 * id) is returned as it is, so pressing Save twice, or saving it from another screen, changes nothing.
 */
export function saveAlbum(lists: Playlist[], album: AlbumRef & { title: unknown }, keys: string[], now: number, id: string): Playlist[] {
  if (!album.id) throw new PlaylistError('Which album?');
  if (lists.some((l) => l.album?.id === album.id)) return lists;
  if (lists.filter((l) => l.album).length >= ALBUMS_MAX) throw new PlaylistError(`You can keep up to ${ALBUMS_MAX} albums.`);
  const { title, ...ref } = album;
  const entries = [...new Set(keys.filter(Boolean))].slice(0, PLAYLIST_TRACKS_MAX).map((key) => ({ key, added: now }));
  return [...lists, { id, name: normaliseName(title) || 'Album', created: now, entries, album: ref }];
}

export function renamePlaylist(lists: Playlist[], id: string, name: unknown): Playlist[] {
  const clean = normaliseName(name);
  if (!clean) throw new PlaylistError('A list needs a name.');
  const target = lists.find((l) => l.id === id);
  if (!target) throw new PlaylistError('That list is gone.');
  if (target.album) throw new PlaylistError('A saved album keeps the album\u2019s name.');
  const clash = findByName(lists, clean);
  if (clash && clash.id !== id) throw new PlaylistError(`You already have a list called “${clean}”.`);
  return lists.map((l) => (l.id === id ? { ...l, name: clean } : l));
}

export function deletePlaylist(lists: Playlist[], id: string): Playlist[] {
  return lists.filter((l) => l.id !== id);
}

/**
 * Put one song into every named list. Already-held songs are left alone, so this is safe to repeat. A
 * saved album holds the album's songs only, so it is never a target.
 */
export function addToPlaylists(lists: Playlist[], ids: string[], key: string, now: number): Playlist[] {
  const wanted = new Set(ids);
  if (!key) return lists;
  return lists.map((l) => {
    if (!wanted.has(l.id) || l.album) return l;
    if (l.entries.some((e) => e.key === key)) return l;
    if (l.entries.length >= PLAYLIST_TRACKS_MAX) return l;
    return { ...l, entries: [...l.entries, { key, added: now }] };
  });
}

/** Take one song out of the named lists; the ones it was never in are untouched. */
export function removeFromPlaylists(lists: Playlist[], ids: string[], key: string): Playlist[] {
  const wanted = new Set(ids);
  return lists.map((l) => (wanted.has(l.id) ? { ...l, entries: l.entries.filter((e) => e.key !== key) } : l));
}

/** Which lists hold this song — what the like menu ticks. */
export function playlistsHolding(lists: Playlist[], key: string): string[] {
  return lists.filter((l) => l.entries.some((e) => e.key === key)).map((l) => l.id);
}

/**
 * The owner's rule: a saved list is not a discovery queue. Nothing new is looked for until the
 * listener has actually heard everything already in it. An empty list has nothing to finish, so it
 * never asks for more either.
 */
export function playlistFullyPlayed(list: Playlist, played: ReadonlySet<string>): boolean {
  if (list.entries.length === 0) return false;
  return list.entries.every((e) => played.has(e.key));
}

/** How many songs in the list the listener has still not heard — what the UI explains. */
export function unplayedCount(list: Playlist, played: ReadonlySet<string>): number {
  return list.entries.reduce((n, e) => n + (played.has(e.key) ? 0 : 1), 0);
}

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A stored album record, or undefined when it is unusable (the list itself is still kept). */
function parseAlbumRef(raw: unknown): AlbumRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = text(r['id'], 80);
  if (!id) return undefined;
  return {
    id,
    provider: text(r['provider'], 20) ?? 'deezer',
    artist: text(r['artist'], 200) ?? '',
    artwork: text(r['artwork'], 500),
    year: text(r['year'], 10),
    kind: text(r['kind'], 20) ?? 'album',
    url: text(r['url'], 500) ?? '',
  };
}

/** Tolerant of whatever a long-lived store holds, so one bad row cannot empty the listener's lists. */
export function parsePlaylists(raw: unknown): Playlist[] {
  if (!Array.isArray(raw)) return [];
  const out: Playlist[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = String(r['id'] ?? '');
    const name = normaliseName(r['name']);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const entries: PlaylistEntry[] = [];
    const keys = new Set<string>();
    for (const e of Array.isArray(r['entries']) ? r['entries'] : []) {
      if (!e || typeof e !== 'object') continue;
      const key = String((e as Record<string, unknown>)['key'] ?? '');
      if (!key || keys.has(key)) continue;
      keys.add(key);
      entries.push({ key, added: Number((e as Record<string, unknown>)['added']) || 0 });
    }
    const album = 'album' in r ? parseAlbumRef(r['album']) : undefined;
    out.push(album ? { id, name, created: Number(r['created']) || 0, entries, album } : { id, name, created: Number(r['created']) || 0, entries });
  }
  return out;
}
