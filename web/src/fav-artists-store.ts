/**
 * ARTIST-FAV-001: the listener's starred artists, read once from the local API and shared by every star button and
 * the Settings list, so starring on an artist page shows at once in Settings and the other way round.
 */
import { api, type FavArtist } from './api';

type Listener = () => void;
const EMPTY: readonly FavArtist[] = Object.freeze([]);
let list: readonly FavArtist[] = EMPTY;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
const set = (next: readonly FavArtist[]) => { list = Object.freeze([...next]); loaded = true; emit(); };
const fold = (s: string) => s.trim().toLowerCase();

export const favArtistsStore = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    if (!loaded && !loading) loading = Promise.resolve().then(() => api.favArtists()).then((r) => set(r.artists), () => undefined).finally(() => { loading = null; });
    return () => listeners.delete(l);
  },
  get: (): readonly FavArtist[] => list,
  /** A primitive for useSyncExternalStore: whether this artist is starred. */
  has: (name: string): boolean => list.some((a) => fold(a.name) === fold(name)),
  isLoaded: (): boolean => loaded,
  async add(a: { name: string; pageId?: string | null; fans?: number | null; picture?: string | null }): Promise<void> {
    const r = await api.editFavArtists({ op: 'add', artist: { name: a.name.trim(), pageId: a.pageId ?? null, fans: a.fans ?? null, picture: a.picture ?? null } });
    set(r.artists);
  },
  async remove(name: string): Promise<void> {
    set((await api.editFavArtists({ op: 'remove', name })).artists);
  },
  /** Tests only. */
  reset(): void { list = EMPTY; loaded = false; loading = null; },
};
