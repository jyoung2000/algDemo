/**
 * ARTIST-FAV-001: the listener's starred artists, read once from the local API and shared by every star button, the
 * Profile list and the Settings list, so starring anywhere shows everywhere at once.
 * ARTIST-FAV-ALGO-001: the list is the active algorithm's; it is read again whenever the active algorithm changes.
 */
import { api, type FavArtist, type FavArtistsView } from './api';

type Listener = () => void;
const EMPTY: readonly FavArtist[] = Object.freeze([]);
let list: readonly FavArtist[] = EMPTY;
let algorithm: { id: string; name: string } | null = null;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
const take = (v: FavArtistsView) => { list = Object.freeze([...v.artists]); algorithm = v.algorithm ?? algorithm; loaded = true; emit(); };
const fold = (s: string) => s.trim().toLowerCase();
const load = (): Promise<void> => {
  if (!loading) loading = Promise.resolve().then(() => api.favArtists()).then(take, () => undefined).finally(() => { loading = null; });
  return loading;
};

export const favArtistsStore = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    if (!loaded) void load();
    return () => listeners.delete(l);
  },
  get: (): readonly FavArtist[] => list,
  /** The algorithm the list belongs to (a primitive, for useSyncExternalStore). */
  algorithmName: (): string => algorithm?.name ?? '',
  algorithmId: (): string => algorithm?.id ?? '',
  /** A primitive for useSyncExternalStore: whether this artist is starred. */
  has: (name: string): boolean => list.some((a) => fold(a.name) === fold(name)),
  isLoaded: (): boolean => loaded,
  /** Reads the list again (the active algorithm changed). */
  reload: (): Promise<void> => { loaded = false; return load(); },
  async add(a: { name: string; pageId?: string | null; fans?: number | null; picture?: string | null }): Promise<void> {
    take(await api.editFavArtists({ op: 'add', artist: { name: a.name.trim(), pageId: a.pageId ?? null, fans: a.fans ?? null, picture: a.picture ?? null } }));
  },
  async remove(name: string): Promise<void> {
    take(await api.editFavArtists({ op: 'remove', name }));
  },
  /** Replaces the active algorithm's whole list (an imported or copied algorithm's artists). */
  async setAll(artists: readonly FavArtist[]): Promise<void> {
    take(await api.editFavArtists({ op: 'set', artists: [...artists] }));
  },
  /** Tests only. */
  reset(): void { list = EMPTY; algorithm = null; loaded = false; loading = null; },
};
