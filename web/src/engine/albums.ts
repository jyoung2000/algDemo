/**
 * Albums: search, open, and the album a song sits on (ALBUM-SEARCH-001, ALBUM-OPEN-001), plus the key
 * album taste is counted under (ALBUM-TASTE-001).
 *
 * Deezer answers first (its album songs carry ids, genres and the album id the rest of the engine
 * already reads); Apple's iTunes catalogue fills in what Deezer lacks. Both are keyless and already on
 * every shell's host allowlist. Album songs are ordinary tracks: the player finds the full song for
 * them exactly as it does for a search result, so an album plays whole, never as previews.
 */
import type { CancelToken, Http, Meter } from './net';
import { BudgetExceeded } from './net';
import { cached, DZ, ProviderError, type Deezer } from './deezer';
import { parseItunes } from './apple';
import { fold } from './identity';
import { ALBUM_SUFFIX, albumKeyOf, cleanAlbumTitle, isBodyOfWork, type AlbumOf } from './album-key';
import type { Track } from './track';
import type { Store } from './store';

// Untyped JSON from Deezer and iTunes, read field by field as the other provider adapters do.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

export type AlbumKind = 'album' | 'ep' | 'mixtape' | 'compilation' | 'single';
export const ALBUM_KIND_LABEL: Record<AlbumKind, string> = { album: 'Album', ep: 'EP', mixtape: 'Mixtape', compilation: 'Compilation', single: 'Single' };

export interface AlbumSummary {
  /** `dz:<deezer id>` or `ap:<itunes collection id>`. */
  id: string;
  provider: 'deezer' | 'apple';
  title: string;
  artist: string;
  artwork: string | null;
  year: string | null;
  kind: AlbumKind;
  count: number | null;
  url: string;
}

export interface AlbumView extends AlbumSummary {
  tracks: Track[];
  /** Seconds, of the songs listed. */
  duration: number | null;
  genres: string[];
}

export interface AlbumSearch {
  albums: AlbumSummary[];
  sources: Record<string, { state: 'ok' | 'failed' | 'budget'; count?: number; detail?: string; ms: number }>;
}

const SUFFIX = ALBUM_SUFFIX;
const MIXTAPE = /\bmix\s?tape\b/i;

export { albumKeyOf, cleanAlbumTitle, isBodyOfWork };

export function albumKind(recordType: string | null | undefined, title: string, count: number | null | undefined): AlbumKind {
  const suffix = SUFFIX.exec(title)?.[1]?.toLowerCase();
  if (suffix === 'single') return 'single';
  if (suffix === 'ep') return 'ep';
  const rt = String(recordType ?? '').toLowerCase();
  if (rt === 'single' || count === 1) return 'single';
  if (rt === 'compile' || rt === 'compilation') return 'compilation';
  if (MIXTAPE.test(title)) return 'mixtape';
  if (rt === 'ep') return 'ep';
  return 'album';
}

function primaryArtist(t: AlbumOf): string {
  return String(t.artists?.[0] ?? t.artist ?? '').split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/i)[0] ?? '';
}

const year = (d: unknown): string | null => (typeof d === 'string' && /^\d{4}/.test(d) ? d.slice(0, 4) : null);
const appleArt = (u: unknown): string | null => (typeof u === 'string' && u ? u.replace('100x100bb', '600x600bb') : null);

export function parseDeezerAlbums(resp: Json): AlbumSummary[] {
  return ((resp['data'] as Json[] | undefined) ?? [])
    .filter((x) => x && x['id'] && x['title'] && (x['type'] ?? 'album') === 'album')
    .map((x) => {
      const title = String(x['title']);
      const count = typeof x['nb_tracks'] === 'number' ? x['nb_tracks'] : null;
      return {
        id: `dz:${x['id']}`, provider: 'deezer' as const, title, artist: String(x['artist']?.['name'] ?? ''),
        artwork: x['cover_medium'] ?? null, year: year(x['release_date']), kind: albumKind(x['record_type'], title, count), count,
        url: String(x['link'] ?? `https://www.deezer.com/album/${x['id']}`),
      };
    });
}

function appleSummary(x: Json): AlbumSummary {
  const raw = String(x['collectionName']);
  const count = typeof x['trackCount'] === 'number' ? x['trackCount'] : null;
  return {
    id: `ap:${x['collectionId']}`, provider: 'apple', title: cleanAlbumTitle(raw), artist: String(x['artistName'] ?? ''),
    artwork: appleArt(x['artworkUrl100']), year: year(x['releaseDate']),
    kind: x['collectionType'] === 'Compilation' ? 'compilation' : albumKind(null, raw, count), count,
    url: String(x['collectionViewUrl'] ?? ''),
  };
}

export function parseItunesAlbums(resp: Json): AlbumSummary[] {
  return ((resp['results'] as Json[] | undefined) ?? [])
    .filter((x) => x['wrapperType'] === 'collection' && x['collectionId'] && x['collectionName'])
    .map(appleSummary);
}

const sameAlbum = (a: AlbumSummary) => `${fold(a.artist)}|${fold(cleanAlbumTitle(a.title))}`;

/** Deezer's albums first, then Apple's that Deezer lacks; singles after every longer body of work. */
export function mergeAlbums(dz: AlbumSummary[], ap: AlbumSummary[]): AlbumSummary[] {
  const byKey = new Map<string, AlbumSummary>();
  for (const a of [...dz, ...ap]) {
    const k = sameAlbum(a);
    const had = byKey.get(k);
    if (!had) byKey.set(k, { ...a });
    else {
      had.year ??= a.year;
      had.artwork ??= a.artwork;
      had.count ??= a.count;
    }
  }
  const all = [...byKey.values()];
  return [...all.filter((a) => a.kind !== 'single'), ...all.filter((a) => a.kind === 'single')];
}

const DAY = 86400;

export class Albums {
  constructor(private readonly http: Http, private readonly dz: Deezer, private readonly store?: Store) {}

  private async get(url: string, c: Ctx, category: 'metadata' | 'search', maxBytes: number): Promise<Json> {
    const o: Parameters<Http['getJson']>[1] = { category, maxBytes };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    const d = await this.http.getJson<Json>(url, o);
    if (d && typeof d === 'object' && d['error']) throw new ProviderError(`Deezer: ${d['error']['type']}: ${d['error']['message']}`);
    return d;
  }

  private searchDeezer(q: string, limit: number, c: Ctx): Promise<AlbumSummary[]> {
    return cached(this.store, `dz:albsearch:${fold(q)}:${limit}`, 'search', 15 * 60, async () =>
      parseDeezerAlbums(await this.get(`${DZ}/search/album?q=${encodeURIComponent(q)}&limit=${limit}`, c, 'metadata', 800_000)),
    );
  }

  private searchApple(q: string, limit: number, c: Ctx): Promise<AlbumSummary[]> {
    return cached(this.store, `ap:albsearch:${q.trim().toLowerCase()}:${limit}`, 'search', 15 * 60, async () =>
      parseItunesAlbums(await this.get(`https://itunes.apple.com/search?term=${encodeURIComponent(q.trim())}&entity=album&limit=${limit}`, c, 'search', 400_000)),
    );
  }

  async search(q: string, limit = 12, c: Ctx = {}): Promise<AlbumSearch> {
    const sources: AlbumSearch['sources'] = {};
    const ask = async (name: string, fn: () => Promise<AlbumSummary[]>) => {
      const t = performance.now();
      try {
        const r = await fn();
        sources[name] = { state: 'ok', count: r.length, ms: Math.trunc(performance.now() - t) };
        return r;
      } catch (e) {
        const spent = e instanceof BudgetExceeded && c.meter !== undefined && c.meter.daily - c.meter.total <= 0;
        sources[name] = { state: spent ? 'budget' : 'failed', detail: String((e as Error).message).slice(0, 120), ms: Math.trunc(performance.now() - t) };
        return [];
      }
    };
    const [dz, ap] = await Promise.all([ask('deezer', () => this.searchDeezer(q, limit, c)), ask('apple', () => this.searchApple(q, limit, c))]);
    return { albums: mergeAlbums(dz, ap).slice(0, limit), sources };
  }

  /** The whole album, its songs in album order. Songs no service can play are left out. */
  open(id: string, c: Ctx = {}): Promise<AlbumView> {
    const m = /^(dz|ap):(\d{1,15})$/.exec(id);
    if (!m) return Promise.reject(new ProviderError('That is not an album this app can open.'));
    return m[1] === 'dz' ? this.openDeezer(m[2]!, c) : this.openApple(m[2]!, c);
  }

  private openDeezer(aid: string, c: Ctx): Promise<AlbumView> {
    return cached(this.store, `dz:albumview:${aid}`, 'album', 7 * DAY, async () => {
      const d = await this.get(`${DZ}/album/${aid}`, c, 'metadata', 1_500_000);
      let rows = ((d['tracks']?.['data'] as Json[] | undefined) ?? []);
      if (typeof d['nb_tracks'] === 'number' && d['nb_tracks'] > rows.length) {
        const more = await this.get(`${DZ}/album/${aid}/tracks?limit=300`, c, 'metadata', 1_500_000);
        rows = (more['data'] as Json[] | undefined) ?? rows;
      }
      const alb = { id: d['id'], title: d['title'], cover_medium: d['cover_medium'], release_date: d['release_date'], genres: d['genres'] };
      const tracks = rows.filter((x) => x['readable'] ?? true).map((x) => this.dz.toTrack(x, alb));
      const title = String(d['title'] ?? '');
      const count = typeof d['nb_tracks'] === 'number' ? d['nb_tracks'] : tracks.length;
      return {
        id: `dz:${aid}`, provider: 'deezer', title, artist: String(d['artist']?.['name'] ?? tracks[0]?.artists[0] ?? ''),
        artwork: d['cover_medium'] ?? null, year: year(d['release_date']), kind: albumKind(d['record_type'], title, count), count,
        url: String(d['link'] ?? `https://www.deezer.com/album/${aid}`),
        tracks, duration: sumDuration(tracks), genres: (((d['genres']?.['data'] as Json[] | undefined) ?? []).map((g) => String(g['name'] ?? '')).filter(Boolean)),
      };
    });
  }

  private openApple(cid: string, c: Ctx): Promise<AlbumView> {
    return cached(this.store, `ap:albumview:${cid}`, 'album', 7 * DAY, async () => {
      const d = await this.get(`https://itunes.apple.com/lookup?id=${cid}&entity=song&limit=200`, c, 'search', 800_000);
      const results = (d['results'] as Json[] | undefined) ?? [];
      const head = results.find((x) => x['wrapperType'] === 'collection');
      if (!head) throw new ProviderError('Apple Music has no album with that id.');
      const songs = results
        .filter((x) => x['wrapperType'] === 'track')
        .sort((a, b) => (Number(a['discNumber'] ?? 1) - Number(b['discNumber'] ?? 1)) || (Number(a['trackNumber'] ?? 0) - Number(b['trackNumber'] ?? 0)));
      const tracks = parseItunes({ results: songs }).map((t) => ({ ...t, album: cleanAlbumTitle(String(t.album ?? head['collectionName'])) }));
      const s = appleSummary(head);
      return { ...s, count: s.count ?? tracks.length, tracks, duration: sumDuration(tracks), genres: head['primaryGenreName'] ? [String(head['primaryGenreName'])] : [] };
    });
  }

  /**
   * The album a song sits on. A Deezer song names its album id; anything else is searched by its album
   * title and primary artist, and only an album with that exact title (and artist) is opened: no
   * album is better than the wrong album.
   */
  async openFor(t: AlbumOf & { album_id?: unknown; provider?: string }, c: Ctx = {}): Promise<AlbumView | null> {
    const aid = typeof t.album_id === 'string' || typeof t.album_id === 'number' ? String(t.album_id) : '';
    if (/^\d{1,15}$/.test(aid)) return this.open(`dz:${aid}`, c);
    const album = cleanAlbumTitle(String(t.album ?? ''));
    const artist = primaryArtist(t);
    if (!album || !artist) return null;
    const want = fold(album);
    const who = fold(artist);
    const pick = (list: AlbumSummary[]) => {
      const byArtist = list.filter((a) => fold(a.artist) === who || fold(a.artist).includes(who) || who.includes(fold(a.artist)));
      return byArtist.find((a) => fold(cleanAlbumTitle(a.title)) === want) ?? null;
    };
    const q = `${artist} ${album}`;
    const dz = pick(await this.searchDeezer(q, 10, c).catch(() => []));
    if (dz) return this.open(dz.id, c);
    const ap = pick(await this.searchApple(q, 10, c).catch(() => []));
    return ap ? this.open(ap.id, c) : null;
  }
}

function sumDuration(tracks: Track[]): number | null {
  let s = 0;
  for (const t of tracks) {
    if (typeof t.duration !== 'number') return null;
    s += t.duration;
  }
  return Math.round(s);
}
