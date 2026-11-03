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

export interface PlaylistEntry {
  key: string;
  added: number;
}

export interface Playlist {
  id: string;
  name: string;
  created: number;
  entries: PlaylistEntry[];
}

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

export function findByName(lists: Playlist[], name: string): Playlist | undefined {
  const wanted = normaliseName(name);
  return lists.find((l) => sameName(l.name, wanted));
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
  if (lists.length >= PLAYLISTS_MAX) throw new PlaylistError(`You can keep up to ${PLAYLISTS_MAX} lists.`);
  return [...lists, { id, name: clean, created: now, entries: [] }];
}

export function renamePlaylist(lists: Playlist[], id: string, name: unknown): Playlist[] {
  const clean = normaliseName(name);
  if (!clean) throw new PlaylistError('A list needs a name.');
  const target = lists.find((l) => l.id === id);
  if (!target) throw new PlaylistError('That list is gone.');
  const clash = findByName(lists, clean);
  if (clash && clash.id !== id) throw new PlaylistError(`You already have a list called “${clean}”.`);
  return lists.map((l) => (l.id === id ? { ...l, name: clean } : l));
}

export function deletePlaylist(lists: Playlist[], id: string): Playlist[] {
  return lists.filter((l) => l.id !== id);
}

/** Put one song into every named list. Already-held songs are left alone, so this is safe to repeat. */
export function addToPlaylists(lists: Playlist[], ids: string[], key: string, now: number): Playlist[] {
  const wanted = new Set(ids);
  if (!key) return lists;
  return lists.map((l) => {
    if (!wanted.has(l.id)) return l;
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
    out.push({ id, name, created: Number(r['created']) || 0, entries });
  }
  return out;
}
