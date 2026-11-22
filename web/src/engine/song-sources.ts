/**
 * RING-CLOSE-001: which link each song is being fetched from, as the player found it.
 *
 * A song pressed in a list is matched to its full recording by the player, not by the queue loader, so the list's own
 * row had no way to find that download and its ring stood still. The player writes the link here; the rows read it.
 */
type Listener = () => void;
const links = new Map<string, string>();
const listeners = new Set<Listener>();
const MAX = 400;
let busy: string | null = null;
let letGo: ReturnType<typeof setTimeout> | undefined;
/** How long a song stays marked as being fetched after the player lets go of it. */
export const FETCH_GRACE_MS = 600;

/**
 * ROW-DL-KEPT-001: the links songs were saved under by a Download press. Unlike the links above these are kept on the
 * device: a song found through another service has no link of its own, so without this a saved song lost its blue
 * Play button and got its Download icon back each time the app was reopened. Only the link is remembered here;
 * whether the file is still in the Music folder is always the shell's answer.
 */
export const SAVED_LINKS_KEY = 'jplay.saved-links';
export const SAVED_LINKS_MAX = 5000;
const store = (): Storage | null => { try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; } };
function readSaved(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const raw: unknown = JSON.parse(store()?.getItem(SAVED_LINKS_KEY) ?? '[]');
    if (Array.isArray(raw)) for (const e of raw) if (Array.isArray(e) && typeof e[0] === 'string' && e[0] && typeof e[1] === 'string' && e[1]) m.set(e[0], e[1]);
  } catch { /* a damaged record is no record */ }
  return m;
}
const saved = readSaved();

export const songSources = {
  get: (key: string): string | null => links.get(key) ?? saved.get(key) ?? null,
  /** The link a Download press saved this song under; remembered across restarts. */
  keep(key: string, url: string): void {
    if (!key || !url || saved.get(key) === url) return;
    saved.delete(key);
    saved.set(key, url);
    while (saved.size > SAVED_LINKS_MAX) saved.delete(saved.keys().next().value!);
    try { store()?.setItem(SAVED_LINKS_KEY, JSON.stringify([...saved])); } catch { /* no room: it still holds for this session */ }
    listeners.forEach((l) => l());
  },
  set(key: string, url: string): void {
    if (!key || !url || links.get(key) === url) return;
    links.delete(key);
    links.set(key, url);
    while (links.size > MAX) links.delete(links.keys().next().value!);
    listeners.forEach((l) => l());
  },
  /**
   * The one song the player is finding or fetching right now (null: none). A pressed song's row shows it has started
   * from the press, before any download exists to report a percent.
   */
  fetching(key: string | null): void {
    if (key !== null) {
      if (letGo) { clearTimeout(letGo); letGo = undefined; }
      if (busy === key) return;
      busy = key;
      listeners.forEach((l) => l());
      return;
    }
    // The player's own state changes hands (finding the song, asking for it, fetching it) with a gap of a few
    // milliseconds between; letting go at once restarted the row's outline each time.
    if (busy === null || letGo) return;
    const was = busy;
    letGo = setTimeout(() => {
      letGo = undefined;
      if (busy !== was) return;
      busy = null;
      listeners.forEach((l) => l());
    }, FETCH_GRACE_MS);
  },
  isFetching: (key: string): boolean => busy === key,
  anyFetching: (): boolean => busy !== null,
  subscribe(l: Listener): () => void { listeners.add(l); return () => listeners.delete(l); },
  /** Tests only. */
  reset(): void { links.clear(); saved.clear(); busy = null; if (letGo) { clearTimeout(letGo); letGo = undefined; } },
};
