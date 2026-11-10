/**
 * Artist pages (ARTIST-PAGE-001). Owner: "can we add artist pages where we can see all of an artist
 * songs and albums".
 *
 * An artist is read from two services at once and merged:
 *   - Deezer: the artist, their 100 most played songs (features included) and their whole
 *     discography (albums, EPs, singles), page after page;
 *   - YouTube Music: the artist page (picture, audience, albums, singles & EPs). Its songs list is
 *     read only for an artist Deezer does not have: it runs about 40 KB a song as sent (4.0 MB for
 *     100 songs on 2026-11-10), against about 20 KB for a whole Deezer album.
 * The page opens on the most played songs; `everySong` then opens every album and single and adds
 * each song not already listed, so the list holds everything the artist has released.
 * The other service's page is found by the artist's exact name only, so a different artist whose name
 * merely resembles it is never borrowed. Songs are ordinary tracks: they play in full exactly as a
 * search result does. Albums open through engine/albums.ts.
 */
import type { CancelToken, Http, Meter } from './net';
import { cached, DZ, ProviderError, type Deezer } from './deezer';
import { fold } from './identity';
import { albumKind, mergeAlbums, parseDeezerAlbums, type Albums, type AlbumSummary } from './albums';
import { parseDuration, YT_ALBUM, type YouTubeMusic, type YtItem } from './ytmusic';
import type { Track } from './track';
import type { Store } from './store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

export const YT_ARTIST = /^UC[A-Za-z0-9_-]{22}$/;
const YT_LIST = /^VL[A-Za-z0-9_-]{10,80}$/;
const DZ_ID = /^\d{1,15}$/;
/** Pages of the YouTube Music songs list (about 100 songs each) and of Deezer's discography. */
const SONG_PAGES = 8;
const ALBUM_PAGES = 4;
/** Albums opened at once by `everySong`. */
const ALBUM_READS = 4;

export interface ArtistSummary {
  /** `dz:<deezer id>` or `yt:<UC channel id>`. */
  id: string;
  provider: 'deezer' | 'ytmusic';
  name: string;
  picture: string | null;
  /** "112,807 fans" or "4.47M monthly audience". */
  detail: string | null;
  url: string;
  /** The same artist's id on the other service, when found. */
  alt?: string;
}

export interface ArtistView {
  id: string;
  name: string;
  picture: string | null;
  detail: string | null;
  /** The most played songs, once each (Deezer's, or YouTube Music's list when Deezer lacks the artist). */
  songs: Track[];
  /** Albums, EPs, mixtapes and compilations, newest first. */
  albums: AlbumSummary[];
  /** Singles, newest first. */
  singles: AlbumSummary[];
  links: { deezer?: string; ytmusic?: string };
  sources: Record<string, { state: 'ok' | 'none' | 'failed'; count?: number; detail?: string }>;
}

export type ArtistTarget = { id?: string; name?: string };

export interface ArtistSongs {
  /** The most played songs first, then every other song on their albums and singles, newest first. */
  songs: Track[];
  /** Album and single pages read, and how many of them could not be read. */
  opened: number;
  failed: number;
}

// ---- reading ------------------------------------------------------------------------------------

const nav = (o: unknown, path: (string | number)[]): Json | undefined =>
  path.reduce<Json | undefined>((a, k) => (a === null || a === undefined ? undefined : (a as Json)[k as string]), o as Json);
const runs = (r: Json | undefined): Json[] => ((r?.['runs'] as Json[] | undefined) ?? []);
const text = (r: Json | undefined) => runs(r).map((x) => String(x['text'] ?? '')).join('').trim();
const lastThumb = (o: Json | undefined): string | null => {
  const t = (nav(o, ['musicThumbnailRenderer', 'thumbnail', 'thumbnails']) as unknown as Json[] | undefined) ?? [];
  return t.length ? String(t[t.length - 1]!['url']) : null;
};
const browseId = (r: Json | undefined): string => String(nav(r, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ?? '');

export function parseDeezerArtists(resp: Json): ArtistSummary[] {
  return ((resp['data'] as Json[] | undefined) ?? [])
    .filter((x) => x && x['id'] && x['name'])
    .map((x) => ({
      id: `dz:${x['id']}`, provider: 'deezer' as const, name: String(x['name']),
      picture: (x['picture_xl'] ?? x['picture_big'] ?? x['picture_medium'] ?? null) as string | null,
      detail: typeof x['nb_fan'] === 'number' ? `${x['nb_fan'].toLocaleString('en-US')} fans` : null,
      url: String(x['link'] ?? `https://www.deezer.com/artist/${x['id']}`),
    }));
}

/** The artists tab of a YouTube Music search: "Ken Carson" / "Artist • 4.47M monthly audience". */
export function parseYtArtistSearch(resp: Json): ArtistSummary[] {
  const sections = (nav(resp, ['contents', 'tabbedSearchResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents']) as unknown as Json[] | undefined) ?? [];
  const out: ArtistSummary[] = [];
  for (const s of sections) {
    for (const row of ((s['musicShelfRenderer']?.['contents'] as Json[] | undefined) ?? [])) {
      const li = row['musicResponsiveListItemRenderer'];
      const id = browseId(li);
      if (!YT_ARTIST.test(id)) continue;
      const cols = (li['flexColumns'] as Json[] | undefined) ?? [];
      const name = text(nav(cols[0], ['musicResponsiveListItemFlexColumnRenderer', 'text']));
      const sub = text(nav(cols[1], ['musicResponsiveListItemFlexColumnRenderer', 'text'])).split(' \u2022 ').map((p) => p.trim());
      if (!name) continue;
      out.push({ id: `yt:${id}`, provider: 'ytmusic', name, picture: lastThumb(li['thumbnail']), detail: sub.find((p) => /\d/.test(p)) ?? null, url: `https://music.youtube.com/channel/${id}` });
    }
  }
  return out;
}

export interface YtArtistPage {
  name: string;
  picture: string | null;
  detail: string | null;
  /** The browse id of the artist's full songs list. */
  songsList: string | null;
  albums: AlbumSummary[];
  singles: AlbumSummary[];
}

/** A YouTube Music artist page: header, the link to every song, and the album pages it shows. */
export function parseYtArtistPage(resp: Json): YtArtistPage {
  const head = nav(resp, ['header', 'musicImmersiveHeaderRenderer']) ?? nav(resp, ['header', 'musicVisualHeaderRenderer']);
  if (!head) throw new ProviderError('YouTube Music has no artist with that id.');
  const name = text(head['title']);
  const sections = (nav(resp, ['contents', 'singleColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents']) as unknown as Json[] | undefined) ?? [];
  let songsList: string | null = null;
  const albums: AlbumSummary[] = [];
  const singles: AlbumSummary[] = [];
  for (const s of sections) {
    const shelf = s['musicShelfRenderer'];
    if (shelf && !songsList) {
      const id = String(nav(shelf, ['title', 'runs', 0, 'navigationEndpoint', 'browseEndpoint', 'browseId']) ?? nav(shelf, ['bottomEndpoint', 'browseEndpoint', 'browseId']) ?? '');
      if (YT_LIST.test(id)) songsList = id;
    }
    for (const it of ((s['musicCarouselShelfRenderer']?.['contents'] as Json[] | undefined) ?? [])) {
      const x = it['musicTwoRowItemRenderer'];
      const id = browseId(x);
      if (!x || !YT_ALBUM.test(id)) continue;
      const title = text(x['title']);
      const parts = text(x['subtitle']).split(' \u2022 ').map((p) => p.trim());
      const yr = parts.find((p) => /^\d{4}$/.test(p)) ?? null;
      const type = /^single$/i.test(parts[0] ?? '') ? 'single' : /^ep$/i.test(parts[0] ?? '') ? 'ep' : 'album';
      const a: AlbumSummary = {
        id: `yt:${id}`, provider: 'ytmusic', title, artist: name, artwork: lastThumb(x['thumbnailRenderer']), year: yr,
        kind: albumKind(type, title, null), count: null, url: `https://music.youtube.com/browse/${id}`,
      };
      (a.kind === 'single' ? singles : albums).push(a);
    }
  }
  return { name, picture: lastThumb(head['thumbnail']), detail: text(head['monthlyListenerCount']) || null, songsList, albums, singles };
}

/** Rows of the artist's songs list (first page or a continuation) as full YouTube Music songs. */
export function parseYtSongRows(resp: Json, yt: YouTubeMusic): { tracks: Track[]; next: string | null } {
  const rows =
    (nav(resp, ['contents', 'twoColumnBrowseResultsRenderer', 'secondaryContents', 'sectionListRenderer', 'contents', 0, 'musicPlaylistShelfRenderer', 'contents']) as unknown as Json[] | undefined) ??
    (nav(resp, ['onResponseReceivedActions', 0, 'appendContinuationItemsAction', 'continuationItems']) as unknown as Json[] | undefined) ??
    [];
  const tracks: Track[] = [];
  let next: string | null = null;
  for (const row of rows) {
    const token = nav(row, ['continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token']);
    if (typeof token === 'string') next = token;
    const li = row['musicResponsiveListItemRenderer'];
    if (!li) continue;
    const videoId = nav(li, ['playlistItemData', 'videoId']) ?? nav(li, ['overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'videoId']);
    if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    const cols = ((li['flexColumns'] as Json[] | undefined) ?? []).map((c) => runs(nav(c, ['musicResponsiveListItemFlexColumnRenderer', 'text'])));
    const linked = cols.slice(1).flat();
    const artists = linked.filter((r) => YT_ARTIST.test(String(nav(r, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ?? ''))).map((r) => ({ name: String(r['text']), id: String(nav(r, ['navigationEndpoint', 'browseEndpoint', 'browseId'])) }));
    const albumRun = linked.find((r) => YT_ALBUM.test(String(nav(r, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ?? '')));
    const item: YtItem = {
      videoId,
      title: (cols[0] ?? []).map((r) => String(r['text'] ?? '')).join(''),
      artists: artists.length ? artists : (cols[1] ?? []).filter((_, i) => i % 2 === 0).map((r) => ({ name: String(r['text']), id: null })),
      album: albumRun ? { name: String(albumRun['text']), id: String(nav(albumRun, ['navigationEndpoint', 'browseEndpoint', 'browseId'])) } : null,
      duration_seconds: parseDuration(text(nav(li, ['fixedColumns', 0, 'musicResponsiveListItemFixedColumnRenderer', 'text']))),
      year: null,
      thumbnails: (nav(li, ['thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails']) as unknown as { url: string }[] | undefined) ?? [],
      videoType: String(nav(li, ['overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'watchEndpointMusicSupportedConfigs', 'watchEndpointMusicConfig', 'musicVideoType']) ?? 'MUSIC_VIDEO_TYPE_ATV'),
      isExplicit: nav(li, ['badges', 0, 'musicInlineBadgeRenderer']) !== undefined,
    };
    if (item.title) tracks.push(yt.toTrack(item));
  }
  return { tracks, next };
}

/** The artist a song row's button opens: the song's own artist id, and its first artist's name. */
export function artistTargetOf(t: { artists?: string[] | null; artist?: string | null; provider?: string; artist_ids?: Record<string, string> | null }): ArtistTarget | null {
  const name = String(t.artists?.[0] ?? t.artist ?? '').trim();
  if (!name || /^unknown artist$/i.test(name)) return null;
  const ids = t.artist_ids ?? {};
  if (ids['deezer'] && DZ_ID.test(ids['deezer'])) return { id: `dz:${ids['deezer']}`, name };
  if (ids['ytmusic'] && YT_ARTIST.test(ids['ytmusic'])) return { id: `yt:${ids['ytmusic']}`, name };
  return { name };
}

const newestFirst = (list: AlbumSummary[]) =>
  list.map((a, i) => ({ a, i })).sort((x, y) => Number(y.a.year ?? 0) - Number(x.a.year ?? 0) || x.i - y.i).map((x) => x.a);

// ---- the service ----------------------------------------------------------------------------------

export class Artists {
  constructor(
    private readonly http: Http,
    private readonly dz: Deezer,
    private readonly yt?: YouTubeMusic,
    private readonly store?: Store,
    private readonly albums?: Albums,
  ) {}

  private async dzGet(path: string, c: Ctx): Promise<Json> {
    const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 2_000_000 };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    const d = await this.http.getJson<Json>(DZ + path, o);
    if (d && typeof d === 'object' && d['error']) throw new ProviderError(`Deezer: ${d['error']['type']}: ${d['error']['message']}`);
    return d;
  }

  private searchDz(q: string, c: Ctx): Promise<ArtistSummary[]> {
    return cached(this.store, `dz:artsearch:${fold(q)}`, 'search', 15 * 60, async () => parseDeezerArtists(await this.dzGet(`/search/artist?q=${encodeURIComponent(q)}&limit=6`, c)));
  }

  private searchYt(q: string, c: Ctx): Promise<ArtistSummary[]> {
    const yt = this.yt;
    if (!yt) return Promise.reject(new ProviderError('YouTube Music is not available here.'));
    return cached(this.store, `yt:artsearch:${fold(q)}`, 'search', 15 * 60, async () => parseYtArtistSearch(await yt.artistSearch(q, c)));
  }

  /** Both services, one row per artist (by name), the artist the words name first. */
  async search(q: string, limit = 6, c: Ctx = {}): Promise<ArtistSummary[]> {
    const [dz, yt] = await Promise.all([this.searchDz(q, c).catch(() => []), this.searchYt(q, c).catch(() => [])]);
    const byName = new Map<string, ArtistSummary>();
    for (const a of [...dz, ...yt]) {
      const k = fold(a.name);
      const had = byName.get(k);
      if (!had) byName.set(k, { ...a });
      // Two Deezer artists can share a name; only the other service's page is the same artist.
      else if (had.provider !== a.provider) {
        had.alt ??= a.id;
        had.picture ??= a.picture;
      }
    }
    const fq = fold(q);
    const rank = (a: ArtistSummary) => (fold(a.name) === fq ? 0 : fq.includes(fold(a.name)) ? 1 : 2);
    return [...byName.values()].map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a).slice(0, limit);
  }

  async open(target: ArtistTarget, c: Ctx = {}): Promise<ArtistView> {
    const id = String(target.id ?? '');
    const name = String(target.name ?? '').trim();
    let dzId: string | null = null;
    let ytId: string | null = null;
    if (id) {
      const m = /^(dz|yt):(.+)$/.exec(id);
      if (m?.[1] === 'dz' && DZ_ID.test(m[2]!)) dzId = m[2]!;
      else if (m?.[1] === 'yt' && YT_ARTIST.test(m[2]!)) ytId = m[2]!;
      else throw new ProviderError('That is not an artist this app can open.');
    } else if (!name) throw new ProviderError('An artist needs a name or an id.');
    return cached(this.store, `artistview:${dzId ?? ''}:${ytId ?? ''}:${fold(name)}`, 'artist', 6 * 3600, () => this.build(id, name, dzId, ytId, c));
  }

  private async build(id: string, name: string, dzId: string | null, ytId: string | null, c: Ctx): Promise<ArtistView> {
    const sources: ArtistView['sources'] = {};
    const exact = (list: ArtistSummary[], who: string) => list.find((a) => fold(a.name) === fold(who)) ?? null;
    const lookDz = async (who: string) => {
        try {
          const aid = dzId ?? (who ? exact(await this.searchDz(who, c), who)?.id.slice(3) ?? null : null);
          if (!aid) return (sources['deezer'] = { state: 'none' }), null;
          const r = await this.readDz(aid, c);
          sources['deezer'] = { state: 'ok', count: r.songs.length };
          return r;
        } catch (e) {
          sources['deezer'] = { state: 'failed', detail: (e as Error).message };
          return null;
        }
    };
    const lookYt = async (who: string) => {
        try {
          const uc = ytId ?? (who ? exact(await this.searchYt(who, c), who)?.id.slice(3) ?? null : null);
          if (!uc) return (sources['ytmusic'] = { state: 'none' }), null;
          return { uc, page: parseYtArtistPage(await this.yt!.browse(uc, c)) };
        } catch (e) {
          sources['ytmusic'] = { state: 'failed', detail: (e as Error).message };
          return null;
        }
    };
    let [dzSide, ytPage] = await Promise.all([lookDz(name), lookYt(name)]);
    // A song can name one artist and carry another's id (YouTube Music gives the first artist that has
    // one). The id decides who this is; the other service is then looked up by that artist's own name.
    const own = dzId ? dzSide?.name : ytId ? ytPage?.page.name : null;
    if (own && fold(own) !== fold(name)) {
      if (dzId) ytPage = await lookYt(own);
      else dzSide = await lookDz(own);
    }
    if (!dzSide && !ytPage) throw new ProviderError(`No artist named \u201c${name || id}\u201d was found on Deezer or YouTube Music.`);
    let ytSide: Awaited<ReturnType<Artists['readYtSongs']>> | null = null;
    if (ytPage) {
      try {
        ytSide = await this.readYtSongs(ytPage.uc, ytPage.page, !dzSide, c);
        sources['ytmusic'] = { state: 'ok', count: ytSide.songs.length };
      } catch (e) {
        sources['ytmusic'] = { state: 'failed', detail: (e as Error).message };
      }
    }
    const shown = dzSide?.name ?? ytSide?.name ?? name;
    const songs: Track[] = [];
    const seen = new Set<string>();
    for (const t of [...(dzSide?.songs ?? []), ...(ytSide?.songs ?? [])]) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      songs.push(t);
    }
    const named = (list: AlbumSummary[]) => list.map((a) => (a.artist ? a : { ...a, artist: shown }));
    const all = mergeAlbums(named(dzSide?.albums ?? []), named(ytSide?.albums ?? []));
    const links: ArtistView['links'] = {};
    if (dzSide) links.deezer = dzSide.url;
    if (ytSide) links.ytmusic = ytSide.url;
    return {
      id: id || (dzSide ? `dz:${dzSide.id}` : `yt:${ytSide!.id}`),
      name: shown,
      picture: dzSide?.picture ?? ytSide?.picture ?? null,
      detail: ytSide?.detail ?? dzSide?.detail ?? null,
      songs,
      albums: newestFirst(all.filter((a) => a.kind !== 'single')),
      singles: newestFirst(all.filter((a) => a.kind === 'single')),
      links,
      sources,
    };
  }

  private async readDz(aid: string, c: Ctx) {
    const [head, top, first] = await Promise.all([
      this.dzGet(`/artist/${aid}`, c),
      this.dzGet(`/artist/${aid}/top?limit=100`, c),
      this.dzGet(`/artist/${aid}/albums?limit=100`, c),
    ]);
    const name = String(head['name'] ?? '');
    const raw: Json[] = [...((first['data'] as Json[] | undefined) ?? [])];
    let next = typeof first['next'] === 'string' ? first['next'] : null;
    for (let p = 1; next && p < ALBUM_PAGES; p++) {
      const page = await this.dzGet(`/artist/${aid}/albums?limit=100&index=${p * 100}`, c);
      raw.push(...((page['data'] as Json[] | undefined) ?? []));
      next = typeof page['next'] === 'string' ? page['next'] : null;
    }
    // ALBUM-ALL-SONGS-001 holds here too: a song Deezer cannot stream in this region is still listed.
    const songs = ((top['data'] as Json[] | undefined) ?? []).filter((x) => x && x['title']).map((x) => this.dz.toTrack(x));
    return {
      id: aid, name, url: String(head['link'] ?? `https://www.deezer.com/artist/${aid}`),
      picture: (head['picture_xl'] ?? head['picture_big'] ?? null) as string | null,
      detail: typeof head['nb_fan'] === 'number' ? `${head['nb_fan'].toLocaleString('en-US')} fans` : null,
      songs, albums: parseDeezerAlbums({ data: raw.map((a) => ({ type: 'album', ...a })) }),
    };
  }

  /** Every song the artist has released: the page's songs, then each album's and single's others. */
  everySong(view: Pick<ArtistView, 'id' | 'songs' | 'albums' | 'singles'>, c: Ctx = {}): Promise<ArtistSongs> {
    const albums = this.albums;
    if (!albums) return Promise.reject(new ProviderError('Albums cannot be opened here.'));
    const pages = [...view.albums, ...view.singles];
    return cached(this.store, `artistsongs:${view.id}:${pages.length}`, 'artist', 6 * 3600, async () => {
      const read: (Track[] | null)[] = new Array(pages.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < pages.length) {
          const i = next++;
          read[i] = await albums.open(pages[i]!.id, c).then((v) => v.tracks, () => null);
        }
      };
      await Promise.all(Array.from({ length: Math.min(ALBUM_READS, pages.length) }, worker));
      const songs: Track[] = [];
      const seen = new Set<string>();
      for (const t of [...view.songs, ...read.flatMap((x) => x ?? [])]) {
        if (seen.has(t.key)) continue;
        seen.add(t.key);
        songs.push(t);
      }
      return { songs, opened: pages.length, failed: read.filter((x) => x === null).length };
    });
  }

  private async readYtSongs(uc: string, page: YtArtistPage, wantSongs: boolean, c: Ctx) {
    const yt = this.yt!;
    const songs: Track[] = [];
    if (wantSongs && page.songsList) {
      let r = parseYtSongRows(await yt.browse(page.songsList, c), yt);
      songs.push(...r.tracks);
      for (let p = 1; r.next && p < SONG_PAGES; p++) {
        r = parseYtSongRows(await yt.continueBrowse(r.next, c), yt);
        songs.push(...r.tracks);
      }
    }
    return { id: uc, name: page.name, url: `https://music.youtube.com/channel/${uc}`, picture: page.picture, detail: page.detail, songs, albums: [...page.albums, ...page.singles] };
  }
}
