/**
 * Hip-hop subgenres per artist, remembered. Deezer labels a rap song's album only "Rap/Hip Hop", so a
 * song's own tags name the family and nothing finer. The artist's MusicBrainz tags name the kind, but a
 * play saved earlier keeps the tags it had when it was saved. This map is what the taste is read
 * through: whatever a song's tags lack, its artist's remembered subgenres fill in, so the card names
 * the kind of hip-hop for the whole history, not just for songs found after the lookup was added.
 */
import type { Tag } from './genres';
import { fold } from './identity';
import { needsSub, subsFromArtist } from './infer';
import type { Http, Meter } from './net';
import type { Dict } from './shape';
import type { Store } from './store';

export const ARTIST_SUBS_KEY = 'artist_subs';
/** An artist with no hip-hop subgenre tags is asked again after this long (new votes arrive slowly). */
const RETRY_EMPTY_S = 14 * 24 * 3600;
const MAX_ARTISTS = 600;

export interface ArtistSubs {
  at: number;
  tags: Tag[];
}
export type ArtistSubsMap = Record<string, ArtistSubs>;

export const artistName = (track: Dict | null | undefined, fallback?: string): string =>
  String(((track?.['artists'] as string[] | undefined) ?? [])[0] ?? track?.['artist'] ?? fallback ?? '').trim();

/** The track with its artist's remembered subgenres added when its own tags only name the family. */
export function withArtistSubs<T extends Dict>(track: T, map: ArtistSubsMap | undefined, fallbackArtist?: string): T {
  const tags = (track?.['tags'] as Tag[] | undefined) ?? [];
  if (!map || !needsSub(tags)) return track;
  const subs = map[fold(artistName(track, fallbackArtist))]?.tags;
  return subs?.length ? { ...track, tags: [...tags, ...subs] } : track;
}

/** Ask MusicBrainz about one artist (cached a month by the caller's store) and remember the answer. */
/** MusicBrainz answers 403 to any client without a descriptive User-Agent (its API rules). */
export const MUSICBRAINZ_UA = 'AirwaveDiscovery/0.2 ( https://github.com/jyoung2000/algDemo )';

export async function lookupArtistSubs(
  store: Store,
  http: Http,
  artist: string,
  opt: { meter?: Meter; token?: Parameters<Http['getJson']>[1]['token'] },
  cache: <T>(key: string, fn: () => Promise<T>) => Promise<T>,
  now: number,
): Promise<Tag[]> {
  const k = fold(artist);
  const url = `https://musicbrainz.org/ws/2/artist?query=${encodeURIComponent(`artist:"${artist.replace(/"/g, ' ')}"`)}&fmt=json&limit=1`;
  const body = await cache<Dict>(`mb:artist:${k}`, () =>
    http.getJson<Dict>(url, { maxBytes: 100_000, ...(opt.meter ? { meter: opt.meter } : {}), category: 'metadata', headers: { 'user-agent': MUSICBRAINZ_UA, accept: 'application/json' }, ...(opt.token ? { token: opt.token } : {}) }),
  );
  const tags = subsFromArtist(body, artist);
  await remember(store, k, tags, now);
  return tags;
}

export async function remember(store: Store, k: string, tags: Tag[], now: number): Promise<void> {
  const map = store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {};
  map[k] = { at: now, tags };
  const keys = Object.keys(map);
  if (keys.length > MAX_ARTISTS) for (const old of keys.sort((a, b) => map[a]!.at - map[b]!.at).slice(0, keys.length - MAX_ARTISTS)) delete map[old];
  await store.put(ARTIST_SUBS_KEY, map);
}

/**
 * Artists in the history whose songs name a family but nothing finer, with no remembered answer yet
 * (or an old empty one), most-played first. Every family, not only hip-hop (TAGS-MULTI-001).
 */
export function artistsToAsk(rows: { artist?: string | null; track: Dict | null }[], map: ArtistSubsMap | undefined, now: number): string[] {
  const count = new Map<string, { name: string; n: number }>();
  for (const r of rows) {
    const t = r.track ?? {};
    if (!needsSub((t['tags'] as Tag[] | undefined) ?? [])) continue;
    const name = artistName(t, r.artist ?? undefined);
    const k = fold(name);
    if (!k || name.length > 80) continue;
    const known = map?.[k];
    if (known && (known.tags.length || now - known.at < RETRY_EMPTY_S)) continue;
    const e = count.get(k) ?? { name, n: 0 };
    e.n += 1;
    count.set(k, e);
  }
  return [...count.values()].sort((a, b) => b.n - a.n).map((e) => e.name);
}
