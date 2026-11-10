/**
 * Albums: search, open, and the album a song sits on (ALBUM-SEARCH-001, ALBUM-OPEN-001), plus the key
 * album taste is counted under (ALBUM-TASTE-001).
 *
 * Deezer answers first (its album songs carry ids, genres and the album id the rest of the engine
 * already reads); Apple's iTunes catalogue fills in what Deezer lacks. Both are keyless and already on
 * every shell's host allowlist. Album songs are ordinary tracks: the player finds the full song for
 * them exactly as it does for a search result, so an album plays whole, never as previews.
 *
 * ALBUM-SEARCH-002: YouTube Music and SoundCloud are asked too, at the same time. Their albums open
 * as their own songs (a YouTube Music album page, a SoundCloud set), which those services play in
 * full. SoundCloud sets from someone other than the artist come after every official album, and a
 * fan's copy of an album already found is not offered again.
 */
import type { CancelToken, Http, Meter } from './net';
import { BudgetExceeded } from './net';
import { cached, DZ, ProviderError, type Deezer } from './deezer';
import { parseItunes } from './apple';
import { fold } from './identity';
import { parseSongFlat, YT_ALBUM, type YouTubeMusic } from './ytmusic';
import type { SoundCloud } from './soundcloud';
import { ALBUM_SUFFIX, albumKeyOf, cleanAlbumTitle, isBodyOfWork, namesAlbum, type AlbumOf } from './album-key';
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
  /** `dz:<deezer id>`, `ap:<itunes collection id>`, `yt:<MPREb_ page id>` or `sc:<set id>`. */
  id: string;
  provider: 'deezer' | 'apple' | 'ytmusic' | 'soundcloud';
  title: string;
  artist: string;
  artwork: string | null;
  year: string | null;
  kind: AlbumKind;
  count: number | null;
  url: string;
  /** False for a SoundCloud set uploaded by someone other than the artist. */
  official?: boolean;
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
const official = (a: AlbumSummary) => a.official !== false;

/**
 * Each service's albums in the order given (Deezer, Apple, YouTube Music, SoundCloud), one row per
 * album: a later copy only fills a year, cover or count the first lacked. Official albums first, then
 * SoundCloud sets by someone else (minus copies of an album already found), then singles.
 */
export function mergeAlbums(...lists: AlbumSummary[][]): AlbumSummary[] {
  const byKey = new Map<string, AlbumSummary>();
  const all = lists.flat();
  const titles = new Set(all.filter(official).map((a) => fold(cleanAlbumTitle(a.title))));
  for (const a of [...all.filter(official), ...all.filter((x) => !official(x))]) {
    const k = sameAlbum(a);
    const had = byKey.get(k);
    if (!had) {
      if (!official(a) && titles.has(fold(cleanAlbumTitle(a.title)))) continue;
      byKey.set(k, { ...a });
    } else {
      had.year ??= a.year;
      had.artwork ??= a.artwork;
      had.count ??= a.count;
    }
  }
  // Official albums were added first, so they stay ahead of fan uploads.
  const kept = [...byKey.values()];
  return [...kept.filter((a) => a.kind !== 'single'), ...kept.filter((a) => a.kind === 'single')];
}

const words = (s: string) => fold(s).split(' ').filter((w) => w.length >= 2 || /\d/.test(w));

/**
 * ALBUM-SEARCH-002: the album the words name first. Each service matches loosely in its own way, so
 * the merged list is ordered by how much of the query an album's title and artist hold, with a bonus
 * when the words name the album and another when they name its artist (the artist's own other albums
 * beat a stranger's album of the same name); ties keep the services' own order. Fan uploads still
 * follow every official album, and singles come last.
 */
export function rankAlbums(query: string, list: AlbumSummary[]): AlbumSummary[] {
  const q = words(query);
  const fq = fold(query);
  const score = (a: AlbumSummary) => {
    if (!q.length) return 0;
    const hay = new Set(words(`${a.artist} ${a.title}`));
    const artist = fold(a.artist);
    return q.filter((w) => hay.has(w)).length / q.length + (namesAlbum(query, a.title) ? 1 : 0) + (artist.length >= 2 && fq.includes(artist) ? 1 : 0);
  };
  const group = (a: AlbumSummary) => (a.kind === 'single' ? 2 : official(a) ? 0 : 1);
  // An album that shares no word with the search is noise from a loose match; it is not offered.
  return list
    .map((a, i) => ({ a, i, g: group(a), s: score(a) }))
    .filter((x) => !q.length || x.s > 0)
    .sort((x, y) => x.g - y.g || y.s - x.s || x.i - y.i)
    .map((x) => x.a);
}

// ---- YouTube Music albums (ALBUM-SEARCH-002) -------------------------------------------------------

const ytNav = (o: unknown, path: (string | number)[]): Json | undefined =>
  path.reduce<Json | undefined>((a, k) => (a === null || a === undefined ? undefined : (a as Json)[k as string]), o as Json);
const runsText = (runs: Json[] | undefined) => (runs ?? []).map((r) => String(r['text'] ?? '')).join('');
const DOT = ' \u2022 ';
const bigArt = (u: string | undefined) => (u ? u.replace(/=w\d+-h\d+/, '=w544-h544') : null);
const lastThumb = (o: Json | undefined): string | undefined => {
  const t = ytNav(o, ['musicThumbnailRenderer', 'thumbnail', 'thumbnails']) as unknown as Json[] | undefined;
  return t?.length ? String(t[t.length - 1]!['url']) : undefined;
};
const ytKind = (type: string, title: string, count: number | null): AlbumKind =>
  albumKind(/^single$/i.test(type) ? 'single' : /^ep$/i.test(type) ? 'ep' : 'album', title, count);

/** The albums tab of a YouTube Music search: "Album • Ken Carson • 2023" under each title. */
export function parseYtAlbumSearch(resp: Json): AlbumSummary[] {
  const sections = (ytNav(resp, ['contents', 'tabbedSearchResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents']) as unknown as Json[] | undefined) ?? [];
  const out: AlbumSummary[] = [];
  for (const s of sections) {
    for (const row of ((s['musicShelfRenderer']?.['contents'] as Json[] | undefined) ?? [])) {
      const li = row['musicResponsiveListItemRenderer'];
      const id = String(ytNav(li, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ?? '');
      if (!YT_ALBUM.test(id)) continue;
      const cols = (li['flexColumns'] as Json[] | undefined) ?? [];
      const text = (i: number) => (ytNav(cols[i], ['musicResponsiveListItemFlexColumnRenderer', 'text', 'runs']) as unknown as Json[] | undefined) ?? [];
      const title = runsText(text(0)).trim();
      const parts = runsText(text(1)).split(DOT).map((p) => p.trim()).filter(Boolean);
      if (!title || parts.length < 2) continue;
      const type = parts[0]!;
      const yr = /^\d{4}$/.test(parts[parts.length - 1]!) ? parts[parts.length - 1]! : null;
      const artist = parts.slice(1, yr ? -1 : undefined).join(', ');
      if (!artist) continue;
      out.push({
        id: `yt:${id}`, provider: 'ytmusic', title, artist, artwork: bigArt(lastThumb(li['thumbnail'])), year: yr,
        kind: ytKind(type, title, null), count: null, url: `https://music.youtube.com/browse/${id}`,
      });
    }
  }
  return out;
}

/** A YouTube Music album page: its header, and its songs in album order as full YouTube Music songs. */
export function parseYtAlbum(resp: Json, id: string, yt: YouTubeMusic): AlbumView {
  const two = ytNav(resp, ['contents', 'twoColumnBrowseResultsRenderer']);
  const head = ytNav(two, ['tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents', 0, 'musicResponsiveHeaderRenderer']);
  if (!head) throw new ProviderError('YouTube Music has no album with that id.');
  const title = runsText(head['title']?.['runs']).trim();
  const artist = runsText(head['straplineTextOne']?.['runs']).trim();
  const sub = runsText(head['subtitle']?.['runs']).split(DOT).map((p) => p.trim());
  const yr = sub.find((p) => /^\d{4}$/.test(p)) ?? null;
  const songs = /(\d+)\s+songs?/.exec(runsText(head['secondSubtitle']?.['runs']));
  const artwork = bigArt(lastThumb(head['thumbnail']));
  const shelf = ytNav(two, ['secondaryContents', 'sectionListRenderer', 'contents', 0, 'musicShelfRenderer', 'contents']) as unknown as Json[] | undefined;
  const tracks: Track[] = [];
  for (const row of shelf ?? []) {
    const li = row['musicResponsiveListItemRenderer'];
    if (!li) continue;
    const item = parseSongFlat(li);
    const videoId = item?.videoId ?? ytNav(li, ['playlistItemData', 'videoId']);
    if (!item && typeof videoId !== 'string') continue;
    const base = item ?? { videoId: String(videoId), title: runsText(ytNav(li, ['flexColumns', 0, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs']) as unknown as Json[]), artists: [], album: null, duration_seconds: null, year: null, thumbnails: [], videoType: '', isExplicit: null };
    const t = yt.toTrack({
      ...base, videoId: String(videoId), artists: base.artists.length ? base.artists : [{ name: artist, id: null }],
      album: { name: title, id }, year: base.year ?? yr, videoType: base.videoType || 'MUSIC_VIDEO_TYPE_ATV',
    }, 'song');
    tracks.push({ ...t, artwork: artwork ?? t.artwork });
  }
  const count = songs ? Number(songs[1]) : tracks.length;
  const type = sub[0] ?? 'Album';
  return {
    id: `yt:${id}`, provider: 'ytmusic', title, artist, artwork, year: yr, kind: ytKind(type, title, count), count,
    url: `https://music.youtube.com/browse/${id}`, tracks, duration: sumDuration(tracks), genres: [],
  };
}

// ---- SoundCloud albums (ALBUM-SEARCH-002) ----------------------------------------------------------

const UPLOAD_TITLE = /^(.{1,60}?)\s*[-\u2013\u2014]\s+(.+)$/;

/** The artist more than half of a set's listed songs name (an account often goes by another name). */
function leadArtist(tracks: Json[] | undefined): string | null {
  const names = (tracks ?? []).filter((t) => t?.['title']).map((t) => String(t['publisher_metadata']?.['artist'] ?? '').trim()).filter(Boolean);
  const tally = new Map<string, number>();
  for (const n of names) tally.set(n, (tally.get(n) ?? 0) + 1);
  const [best, n] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return best && n * 2 > names.length ? best : null;
}

function scSummary(x: Json): AlbumSummary {
  const verified = x['user']?.['verified'] === true;
  let title = String(x['title'] ?? '').trim();
  let artist = leadArtist(x['tracks']) ?? String(x['user']?.['username'] ?? '').trim();
  // A fan's upload is usually titled "Artist - Album": name the artist, not the uploader.
  const m = UPLOAD_TITLE.exec(title);
  if (!verified && m) {
    artist = m[1]!.trim();
    title = m[2]!.trim();
  }
  const count = typeof x['track_count'] === 'number' ? x['track_count'] : null;
  const setType = String(x['set_type'] ?? '').toLowerCase();
  return {
    id: `sc:${x['id']}`, provider: 'soundcloud', title, artist,
    artwork: typeof x['artwork_url'] === 'string' ? x['artwork_url'].replace(/-large\.(jpg|png)$/, '-t500x500.$1') : (x['user']?.['avatar_url'] ?? null),
    year: year(x['release_date']) ?? year(x['published_at']) ?? year(x['created_at']),
    kind: albumKind(setType === 'compilation' ? 'compile' : setType || 'album', title, count), count,
    url: String(x['permalink_url'] ?? ''), official: verified,
  };
}

/** SoundCloud's album search: sets marked album, EP, single or compilation that hold songs. */
export function parseScAlbums(resp: Json): AlbumSummary[] {
  return ((resp['collection'] as Json[] | undefined) ?? [])
    .filter((x) => x && x['kind'] === 'playlist' && x['id'] && x['title'] && (x['track_count'] ?? 0) > 0)
    .map(scSummary);
}

const SC_IDS_PER_CALL = 50;

const DAY = 86400;

export class Albums {
  constructor(
    private readonly http: Http,
    private readonly dz: Deezer,
    private readonly store?: Store,
    private readonly yt?: YouTubeMusic,
    private readonly sc?: SoundCloud,
  ) {}

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

  private searchYt(q: string, c: Ctx): Promise<AlbumSummary[]> {
    const yt = this.yt;
    if (!yt) return Promise.reject(new ProviderError('YouTube Music is not available here.'));
    return cached(this.store, `yt:albsearch:${fold(q)}`, 'search', 15 * 60, async () => parseYtAlbumSearch(await yt.albumSearch(q, c)));
  }

  private searchSc(q: string, limit: number, c: Ctx): Promise<AlbumSummary[]> {
    const sc = this.sc;
    if (!sc) return Promise.reject(new ProviderError('SoundCloud is not available here.'));
    return cached(this.store, `sc:albsearch:${fold(q)}:${limit}`, 'search', 15 * 60, async () =>
      parseScAlbums(await sc.api(`/search/albums?q=${encodeURIComponent(q)}&limit=${limit}&offset=0`, c)),
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
    const [dz, ap, yt, sc] = await Promise.all([
      ask('deezer', () => this.searchDeezer(q, limit, c)),
      ask('apple', () => this.searchApple(q, limit, c)),
      ask('ytmusic', () => this.searchYt(q, c)),
      ask('soundcloud', () => this.searchSc(q, limit, c)),
    ]);
    return { albums: rankAlbums(q, mergeAlbums(dz, ap, yt, sc)).slice(0, limit), sources };
  }

  /** The whole album, its songs in album order. Songs no service can play are left out. */
  open(id: string, c: Ctx = {}): Promise<AlbumView> {
    const yt = /^yt:(.+)$/.exec(id);
    if (yt && YT_ALBUM.test(yt[1]!)) return this.openYt(yt[1]!, c);
    const m = /^(dz|ap|sc):(\d{1,15})$/.exec(id);
    if (!m) return Promise.reject(new ProviderError('That is not an album this app can open.'));
    if (m[1] === 'sc') return this.openSc(m[2]!, c);
    return m[1] === 'dz' ? this.openDeezer(m[2]!, c) : this.openApple(m[2]!, c);
  }

  private openYt(bid: string, c: Ctx): Promise<AlbumView> {
    const yt = this.yt;
    if (!yt) return Promise.reject(new ProviderError('YouTube Music is not available here.'));
    return cached(this.store, `yt:albumview:${bid}`, 'album', 7 * DAY, async () => parseYtAlbum(await yt.albumPage(bid, c), bid, yt));
  }

  /** A SoundCloud set lists its first songs in full and the rest by id only; those are fetched by id. */
  private openSc(sid: string, c: Ctx): Promise<AlbumView> {
    const sc = this.sc;
    if (!sc) return Promise.reject(new ProviderError('SoundCloud is not available here.'));
    return cached(this.store, `sc:albumview:${sid}`, 'album', 7 * DAY, async () => {
      const d = await sc.api(`/playlists/${sid}?representation=full`, c);
      if (!d || d['kind'] !== 'playlist') throw new ProviderError('SoundCloud has no album with that id.');
      const rows = ((d['tracks'] as Json[] | undefined) ?? []).filter((t) => t && t['id']);
      const missing = rows.filter((t) => !t['title']).map((t) => String(t['id']));
      const full = new Map<string, Json>(rows.filter((t) => t['title']).map((t) => [String(t['id']), t]));
      for (let i = 0; i < missing.length; i += SC_IDS_PER_CALL) {
        const batch = missing.slice(i, i + SC_IDS_PER_CALL);
        const got = await sc.api(`/tracks?ids=${encodeURIComponent(batch.join(','))}`, c);
        for (const t of (Array.isArray(got) ? got : []) as Json[]) if (t?.['id']) full.set(String(t['id']), t);
      }
      const s = scSummary(d);
      // Songs the uploader made previews-only (SNIP) cannot be played whole here, so they are left out.
      const tracks = rows
        .map((r) => full.get(String(r['id'])))
        .filter((t): t is Json => !!t && t['policy'] !== 'SNIP' && t['policy'] !== 'BLOCK')
        .map((t) => ({ ...sc.toTrack(t), album: s.title, album_id: s.id }) as Track);
      return { ...s, count: s.count ?? tracks.length, tracks, duration: sumDuration(tracks), genres: d['genre'] ? [String(d['genre'])] : [] };
    });
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
    // ALBUM-SEARCH-002: a YouTube Music or SoundCloud album song names the album it came from.
    if (/^(yt|sc):/.test(aid)) return this.open(aid, c);
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
    if (ap) return this.open(ap.id, c);
    const yt = this.yt ? pick(await this.searchYt(q, c).catch(() => [])) : null;
    if (yt) return this.open(yt.id, c);
    const sc = this.sc ? pick((await this.searchSc(q, 10, c).catch(() => [])).filter(official)) : null;
    return sc ? this.open(sc.id, c) : null;
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
