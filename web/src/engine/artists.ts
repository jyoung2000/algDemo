/**
 * Artist pages (ARTIST-PAGE-001). Owner: "can we add artist pages where we can see all of an artist
 * songs and albums".
 *
 * An artist is read from two services at once and merged:
 *   - Deezer: the artist, their 100 most played songs (the songs other artists have them on
 *     included) and their whole discography (albums, EPs, singles), page after page;
 *   - YouTube Music: the artist page (picture, audience, albums, singles & EPs). Its songs list is
 *     read only for an artist Deezer does not have: it runs about 40 KB a song as sent (4.0 MB for
 *     100 songs on 2026-11-10), against about 20 KB for a whole Deezer album.
 * The page opens on the most played songs; `everySong` then opens every album and single and adds
 * each song not already listed, so the list holds everything the artist has released.
 * The songs another artist leads are taken out of that list and answered as `features`
 * (ARTIST-FEATURES-001), so the page reads as a discography: songs, albums, singles, features.
 * The other service's page is found by the artist's exact name only, so a different artist whose name
 * merely resembles it is never borrowed. Songs are ordinary tracks: they play in full exactly as a
 * search result does. Albums open through engine/albums.ts.
 */
import { BudgetExceeded, Cancelled, FetchError, type CancelToken, type Http, type Meter } from './net';
import { cached, DZ, ProviderError, type Deezer } from './deezer';
import { fold, parseTitle } from './identity';
import { mergeSimilar, type SimilarArtist } from './artist-circle';
import { albumKind, mergeAlbums, parseDeezerAlbums, type Albums, type AlbumSummary } from './albums';
import { parseDuration, YT_ALBUM, type YouTubeMusic, type YtItem } from './ytmusic';
import type { Track } from './track';
import type { Store } from './store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** ARTIST-ARTICLE-001: a name folded with its English article set aside ("The X", "X, The" -> "x"). */
export function sansArticle(name: string): string {
  const f = fold(String(name ?? '').replace(/^\s*(.+?)\s*,\s*the\s*$/i, '$1'));
  const bare = f.replace(/^the\s+/, '');
  return bare || f;
}

export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
  /** ARTIST-REFRESH-001: shared by the page and every continuation in one new look. */
  refresh?: boolean;
  refreshToken?: string;
}

import { artistCache } from './refresh-cache';
export { artistCache } from './refresh-cache';

export const YT_ARTIST = /^UC[A-Za-z0-9_-]{22}$/;
const YT_LIST = /^VL[A-Za-z0-9_-]{10,80}$/;
const DZ_ID = /^\d{1,15}$/;
/** Pages of the YouTube Music songs list (about 100 songs each) and of Deezer's lists. */
const SONG_PAGES = 8;
/**
 * Deezer answers 100 releases a page and says when another follows; every page is read, so the
 * discography is the whole discography. The bound is a stop against a list that never ends, not a
 * limit any real artist reaches (2,000 releases).
 */
const ALBUM_PAGES = 20;
/** Albums opened at once by `everySong`. */
const ALBUM_READS = 4;
/**
 * The songs other artists have them on: every page of each feature search is read (100 rows a page),
 * and every row another artist leads is confirmed by one small track read, a few at a time. The bounds
 * are stops against an endless answer, not a cap on a real artist's features.
 */
const FEATURE_PAGES = 30;
const FEATURE_CANDIDATES = 1200;
const FEATURE_READS = 6;
/**
 * FEATURES-ALL-002: YouTube Music's songs search answers 20 rows a page. Every page the artist is
 * still on is read; three pages in a row without them on any row is the search having moved on to
 * other artists, which is its end for this purpose. The page bound is a stop against an endless answer.
 */
const YT_FEATURE_PAGES = 30;
/** OPEN-FLOW-001: how long YouTube Music has, once Deezer has given a page, before the page opens without it. */
const YT_GRACE_MS = 2500;
/** How long a page with a service missing is kept: long enough for a visit, short enough to ask again. */
const PARTIAL_KEEP_S = 120;
const LATE = Symbol('late');
type DzSide = Awaited<ReturnType<Artists['readDz']>>;
type YtSide = Awaited<ReturnType<Artists['readYtSongs']>>;
/** OPEN-HEAL-001: what a page that opened early had in hand, and what it was still waiting on. */
interface ArtistCarry {
  dz: unknown;
  dzSource: ArtistSource | undefined;
  ytLook: Promise<unknown>;
  ytSongs: Promise<unknown> | undefined;
}
/** FEATURES-FLOW-001: how long past its time a step waits for work that is just about done. */
const STEP_SLACK_MS = 100;
// No quiet-page shortcut: later pages can still contain credited guest appearances.
const YT_PAGE_GAP_MS = 400;

/**
 * FEATURES-ALL-001. Owner: "on the feature page ensure all features load". Deezer has no list of the
 * songs an artist guests on, and its name search answers with a short window (about 170 to 270 rows
 * for a well known artist, however many pages are asked for). Measured for one artist: the name alone
 * confirmed 54 features; asking as well for "feat <name>" and for the name inside a song's title
 * confirmed 35 more. So the three are asked, in this order, and their rows pooled.
 */
export function featureSearches(name: string): string[] {
  const plain = name.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
  return [name, `feat ${name}`, `track:"${plain}"`];
}

/**
 * FEATURES-ALL-002. Owner: "the artist page only loads like 8 features, ensure it loads all pages".
 * Deezer was the only service asked for features. YouTube Music's songs search names every artist
 * on a row and links each to their own channel, so it is asked too: by the name, and by "feat
 * <name>", which leads with the songs they guest on. Measured for one artist: Deezer confirmed 5
 * features and YouTube Music held 9, found as far down as the twelfth page.
 */
export function ytFeatureSearches(name: string): string[] {
  return [name, `feat ${name}`];
}

/** One key for a song two services both have: its title without "(feat. ...)" and its lead artist. */
function featureKey(t: Pick<Track, 'title' | 'artists'>): string {
  return `${parseTitle(t.title).core}|${fold(t.artists[0] ?? '')}`;
}

/**
 * The index of a Deezer track search's next page, only when the link is Deezer's own API and the same
 * search; anything else (another host, path or query) is not a page of this search and gives null.
 */
export function nextSearchIndex(link: unknown, query: string): number | null {
  if (typeof link !== 'string') return null;
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'api.deezer.com' || u.pathname !== '/search/track') return null;
  if (u.searchParams.get('q') !== query) return null;
  const raw = u.searchParams.get('index') ?? '';
  if (!/^\d{1,6}$/.test(raw)) return null;
  return Number(raw);
}

export interface ArtistSummary {
  /** `dz:<deezer id>` or `yt:<UC channel id>`. */
  id: string;
  provider: 'deezer' | 'ytmusic';
  name: string;
  picture: string | null;
  /** "112,807 fans" or "4.47M monthly audience". */
  detail: string | null;
  /** Deezer's fan count, when it gives one: it tells two same-named artists apart (ARTIST-NAME-PICK-001). */
  fans?: number | null;
  url: string;
  /** The same artist's id on the other service, when found. */
  alt?: string;
}

/** ARTIST-SOURCES-001: why a service's artist page was not read. */
export type SourceWhy = 'allowance' | 'offline' | 'busy' | 'refused' | 'failed';
/**
 * ARTIST-SOURCES-001: what one service did for an artist page. `none` means it answered and has no
 * such artist; `failed` means it was not read, and `why` says so in a word the page has copy for.
 * `gave` names what the page shows from it besides songs and albums, which carry their own provider.
 */
export interface ArtistSource {
  state: 'ok' | 'none' | 'failed';
  count?: number;
  detail?: string;
  why?: SourceWhy;
  gave?: ('picture' | 'audience')[];
}

/** No service gave a page. Carries what happened to each, so "has no page" is never said of one that was not read. */
export class ArtistNotOpened extends ProviderError {
  constructor(message: string, readonly sources: Record<string, ArtistSource>) {
    super(message);
  }
}

/** The reason in the terms local-api's identifyFailure uses, so both read a failure the same way. */
export function whyNotRead(e: unknown): SourceWhy {
  const msg = String((e as Error)?.message ?? e);
  if (e instanceof BudgetExceeded) return 'allowance';
  if (/HTTP (429|5\d\d)/.test(msg)) return 'busy';
  if (/HTTP 4\d\d/.test(msg)) return 'refused';
  if (e instanceof FetchError || e instanceof TypeError || /network|timed out|fetch|Socket|Unknown ?Host|Connect|ENOTFOUND/i.test(msg)) return 'offline';
  return 'failed';
}

export interface ArtistView {
  id: string;
  name: string;
  picture: string | null;
  detail: string | null;
  /** The most played songs, once each (Deezer's, or YouTube Music's list when Deezer lacks the artist). */
  songs: Track[];
  /** Songs by other artists that this artist is on, most played first (ARTIST-FEATURES-001). */
  features: Track[];
  /** Albums, EPs, mixtapes and compilations, newest first. */
  albums: AlbumSummary[];
  /** Singles, newest first. */
  singles: AlbumSummary[];
  links: { deezer?: string; ytmusic?: string };
  sources: Record<string, ArtistSource>;
  /** ARTIST-CIRCLE-001: Deezer's related artists and YouTube Music's "Fans might also like", merged. */
  similar?: SimilarArtist[];
}

export type ArtistTarget = { id?: string; name?: string; refresh?: boolean; refreshToken?: string };

/** What a look for features needs of the page it is for. */
export type FeatureView = Pick<ArtistView, 'id' | 'name' | 'songs' | 'features' | 'links'> & { sources?: ArtistView['sources'] };

/** FEATURES-FLOW-001: every feature confirmed so far; `more` while another step would find more. */
export interface FeatureAnswer {
  features: Track[];
  complete: boolean;
  more: boolean;
}

/** A look for features in progress: where each search has got to, and what is waiting to be read. */
interface FeatureState {
  dzId: string | null;
  uc: string | null;
  name: string;
  known: Set<string>;
  verdictKey: string | null;
  no: Set<string>;
  yes: Record<string, Track>;
  dirty: boolean;
  queries: string[];
  q: number;
  index: number;
  at: number;
  p: number;
  ids: Set<string>;
  accepted: number;
  queue: { id: string; order: number }[];
  searching: Promise<void> | null;
  searchDone: boolean;
  dzFound: Map<number, Track>;
  dzComplete: boolean;
  ytQueries: string[];
  yq: number;
  ytToken: string | null;
  yp: number;
  quiet: number;
  ytDone: boolean;
  ytFound: Track[];
  ytSeen: Set<string>;
  ytTokens: Set<string>;
  ytComplete: boolean;
  had: Set<string>;
  shown: Set<string>;
  said: Set<string>;
  emitted: Track[];
  /** The newest step's allowance and stop, how long the work may go on, and the work itself while it runs. */
  ctx: Ctx;
  until: number;
  running: Promise<void> | null;
}

export interface ArtistSongs {
  /** The most played songs first, then every other song on their albums and singles, newest first. */
  songs: Track[];
  /** More songs other artists have them on, found after the page opened (ARTIST-FEATURES-001). */
  features: Track[];
  /** Album and single pages read, and how many of them could not be read. */
  opened: number;
  failed: number;
  /** False when a search page, a limit, or a candidate's read left features unlooked-at. */
  featuresComplete: boolean;
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
      fans: typeof x['nb_fan'] === 'number' ? x['nb_fan'] : null,
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
  /**
   * A shelf the page only shows a few of, with the link to its whole list: YouTube Music shows about
   * ten albums and keeps the rest behind "More" (ARTIST-FEATURES-001 asked for all of them).
   */
  more: { kind: 'albums' | 'singles'; browseId: string; params: string }[];
  /** ARTIST-CIRCLE-001: the page's "Fans might also like" shelf. */
  related: ArtistSummary[];
}

/** A YouTube Music artist page: header, the link to every song, and the album pages it shows. */
export function parseYtArtistPage(resp: Json, uc?: string): YtArtistPage {
  const head = nav(resp, ['header', 'musicImmersiveHeaderRenderer']) ?? nav(resp, ['header', 'musicVisualHeaderRenderer']);
  if (!head) throw new ProviderError('YouTube Music has no artist with that id.');
  const name = text(head['title']);
  const sections = (nav(resp, ['contents', 'singleColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents']) as unknown as Json[] | undefined) ?? [];
  let songsList: string | null = null;
  const albums: AlbumSummary[] = [];
  const singles: AlbumSummary[] = [];
  const more: YtArtistPage['more'] = [];
  const related: ArtistSummary[] = [];
  for (const s of sections) {
    const shelf = s['musicShelfRenderer'];
    if (shelf && !songsList) {
      const id = String(nav(shelf, ['title', 'runs', 0, 'navigationEndpoint', 'browseEndpoint', 'browseId']) ?? nav(shelf, ['bottomEndpoint', 'browseEndpoint', 'browseId']) ?? '');
      if (YT_LIST.test(id)) songsList = id;
    }
    const head = nav(s, ['musicCarouselShelfRenderer', 'header', 'musicCarouselShelfBasicHeaderRenderer']);
    if (head) {
      const link = nav(head, ['moreContentButton', 'buttonRenderer', 'navigationEndpoint', 'browseEndpoint']);
      const params = link?.['params'];
      const title = text(head['title']);
      // DISCOGRAPHY-MORE-001: the list's own id, "MPAD" and the artist's channel (or the channel alone,
      // as older pages had it). When the channel is known, a link to anything else is not followed.
      const list = /^(?:MPAD)?(UC[A-Za-z0-9_-]{22})$/.exec(String(link?.['browseId'] ?? ''));
      if (list && (!uc || list[1] === uc) && typeof params === 'string' && /^[A-Za-z0-9_%=+-]{4,200}$/.test(params)) {
        const kind = /single/i.test(title) ? 'singles' : /album/i.test(title) ? 'albums' : null;
        if (kind) more.push({ kind, browseId: list[0], params });
      }
    }
    for (const it of ((s['musicCarouselShelfRenderer']?.['contents'] as Json[] | undefined) ?? [])) {
      const x = it['musicTwoRowItemRenderer'];
      const id = browseId(x);
      // ARTIST-CIRCLE-001: an artist on the page ("Fans might also like") is a similar artist, never this one.
      if (x && YT_ARTIST.test(id) && id !== uc) {
        const sub = text(x['subtitle']);
        related.push({ id: `yt:${id}`, provider: 'ytmusic', name: text(x['title']), picture: lastThumb(x['thumbnailRenderer']), detail: sub || null, url: `https://music.youtube.com/channel/${id}` });
        continue;
      }
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
  return { name, picture: lastThumb(head['thumbnail']), detail: text(head['monthlyListenerCount']) || null, songsList, albums, singles, more, related };
}

/**
 * The whole list behind a shelf's "More" link: a grid of albums, EPs or singles. Each is an ordinary
 * album page, so it opens exactly as one from the shelf does.
 */
export function parseYtDiscography(resp: Json, artist: string): AlbumSummary[] {
  const secs = (nav(resp, ['contents', 'singleColumnBrowseResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents']) as unknown as Json[] | undefined) ?? [];
  const items: Json[] = [];
  for (const s of secs) {
    items.push(...((nav(s, ['gridRenderer', 'items']) as unknown as Json[] | undefined) ?? []));
    items.push(...((nav(s, ['musicCarouselShelfRenderer', 'contents']) as unknown as Json[] | undefined) ?? []));
  }
  const out: AlbumSummary[] = [];
  for (const it of items) {
    const x = it['musicTwoRowItemRenderer'];
    const id = browseId(x);
    if (!x || !YT_ALBUM.test(id)) continue;
    const title = text(x['title']);
    const parts = text(x['subtitle']).split(' \u2022 ').map((p) => p.trim());
    const yr = parts.find((p) => /^\d{4}$/.test(p)) ?? null;
    const type = /^single$/i.test(parts[0] ?? '') ? 'single' : /^ep$/i.test(parts[0] ?? '') ? 'ep' : 'album';
    if (!title) continue;
    out.push({
      id: `yt:${id}`, provider: 'ytmusic', title, artist, artwork: lastThumb(x['thumbnailRenderer']), year: yr,
      kind: albumKind(type, title, null), count: null, url: `https://music.youtube.com/browse/${id}`,
    });
  }
  return out;
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

/**
 * ARTIST-FEATURES-001. Owner: "clicking on a artist name should take you to a discography page where
 * you can see all there albums, singles and features". A song is a feature when another artist leads
 * it and this artist is still named on it — Deezer's most played list holds those, and a song's
 * artists are its contributors. A row that names neither spelling of them cannot be shown to be a
 * feature, so it stays among the most played rather than being claimed as one.
 */
export function partitionFeatures<T extends Pick<Track, 'artists' | 'artist'>>(tracks: readonly T[], who: string): { songs: T[]; features: T[] } {
  const me = fold(who);
  const songs: T[] = [];
  const features: T[] = [];
  for (const t of tracks) {
    const names = (t.artists?.length ? t.artists : t.artist ? [String(t.artist)] : []).map((n) => fold(String(n)));
    const guest = names.length > 1 && names[0] !== me && names.slice(1).includes(me);
    (guest ? features : songs).push(t);
  }
  return { songs, features };
}

// ---- the service ----------------------------------------------------------------------------------

export class Artists {
  constructor(
    private readonly http: Http,
    private readonly dz: Deezer,
    private readonly yt?: YouTubeMusic,
    private readonly store?: Store,
    private readonly albums?: Albums,
    private readonly opts: { ytGraceMs?: number } = {},
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
    return cached(artistCache(this.store, c), `dz:artsearch:${fold(q)}`, 'search', 15 * 60, async () => parseDeezerArtists(await this.dzGet(`/search/artist?q=${encodeURIComponent(q)}&limit=6`, c)));
  }

  private searchYt(q: string, c: Ctx): Promise<ArtistSummary[]> {
    const yt = this.yt;
    if (!yt) return Promise.reject(new ProviderError('YouTube Music is not available here.'));
    return cached(artistCache(this.store, c), `yt:artsearch:${fold(q)}`, 'search', 15 * 60, async () => parseYtArtistSearch(await yt.artistSearch(q, c)));
  }

  /** Both services, one row per artist (by name), the artist the words name first. */
  async search(q: string, limit = 6, c: Ctx = {}): Promise<ArtistSummary[]> {
    return (await this.searchWithWhy(q, limit, c)).artists;
  }

  /** The same search, saying why it came back empty when neither service could be read (NEXT-FAV-CUSTOM-001). */
  async searchWithWhy(q: string, limit = 6, c: Ctx = {}): Promise<{ artists: ArtistSummary[]; why?: SourceWhy }> {
    const errs: unknown[] = [];
    const [dz, yt] = await Promise.all([this.searchDz(q, c).catch((e) => { errs.push(e); return []; }), this.searchYt(q, c).catch((e) => { errs.push(e); return []; })]);
    const artists = this.mergeArtistHits(q, limit, dz, yt);
    return !artists.length && errs.length === 2 ? { artists, why: whyNotRead(errs[0]) } : { artists };
  }

  private mergeArtistHits(q: string, limit: number, dz: ArtistSummary[], yt: ArtistSummary[]): ArtistSummary[] {
    const byName = new Map<string, ArtistSummary>();
    for (const a of [...dz, ...yt]) {
      const k = fold(a.name);
      const had = byName.get(k);
      if (!had) byName.set(k, { ...a });
      // Two Deezer artists can share a name: the row is the one people listen to (ARTIST-NAME-PICK-001).
      else if (had.provider === a.provider) {
        if ((a.fans ?? -1) > (had.fans ?? -1)) byName.set(k, { ...a, ...(had.alt ? { alt: had.alt } : {}) });
      }
      // Only the other service's page is the same artist.
      else {
        had.alt ??= a.id;
        had.picture ??= a.picture;
      }
    }
    const fq = fold(q);
    const rank = (a: ArtistSummary) => (fold(a.name) === fq ? 0 : fq.includes(fold(a.name)) ? 1 : 2);
    return [...byName.values()].map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a).slice(0, limit);
  }

  async open(target: ArtistTarget, c: Ctx = {}): Promise<ArtistView> {
    c = { ...c, ...(target.refresh ? { refresh: true } : {}), ...(target.refreshToken ? { refreshToken: target.refreshToken } : {}) };
    const store = artistCache(this.store, c);
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
    // Versioned with the Deezer request identity (DEEZER-UA-001) and with what each service gave
    // (ARTIST-SOURCES-001): a view built under another shape is not served.
    // artistview5: the view carries similar artists (ARTIST-CIRCLE-001).
    const key = `artistview5:${dzId ?? ''}:${ytId ?? ''}:${fold(name)}`;
    const hit = store?.cacheGet(key);
    if (hit) return hit.value as ArtistView;
    try {
      const built = await this.build(id, name, dzId, ytId, c);
      // OPEN-FLOW-001: a page a service was too slow for, or did not answer for, is kept only a couple
      // of minutes, so the next visit asks that service again instead of repeating the gap for hours.
      await store?.cachePut(key, 'artist', built.view, built.whole ? 6 * 3600 : PARTIAL_KEEP_S);
      // OPEN-HEAL-001: what the page did not wait for is still on its way. When it lands the whole
      // page takes the short-lived one's place, so the page can mend itself a few seconds later
      // instead of saying "busy" until the listener leaves and comes back.
      const healKey = `${key}:${c.refreshToken ?? ''}`;
      if (built.carry && !this.healing.has(healKey)) {
        const heal = this.build(id, name, dzId, ytId, c, built.carry)
          .then(async (b) => {
            if (b.view.sources['ytmusic']?.state === 'failed') return;
            await store?.cachePut(key, 'artist', b.view, b.whole ? 6 * 3600 : PARTIAL_KEEP_S);
          })
          .catch(() => undefined)
          .finally(() => { this.healing.delete(healKey); });
        this.healing.set(healKey, heal);
      }
      return built.view;
    } catch (e) {
      const stale = store?.cacheGet(key, true);
      if (stale) return stale.value as ArtistView;
      throw e;
    }
  }

  /** OPEN-HEAL-001: pages being finished after they opened, by cache key. */
  private readonly healing = new Map<string, Promise<void>>();

  /**
   * With `carry` (OPEN-HEAL-001) this finishes a page that opened without waiting for YouTube Music:
   * Deezer's side is the one already read, and the YouTube Music requests are the ones already on
   * their way, waited for this time however long they take. Nothing is asked for twice.
   */
  private async build(id: string, name: string, dzId: string | null, ytId: string | null, c: Ctx, carry?: ArtistCarry): Promise<{ view: ArtistView; whole: boolean; carry?: ArtistCarry }> {
    const sources: ArtistView['sources'] = {};
    /**
     * ARTIST-NAME-PICK-001. Several artists can carry one name, and the service answers its own
     * order, which can put a 42-fan namesake first. The artist the words mean is the one people
     * listen to, so of the exact matches the most followed opens; without fan counts the first
     * stands, and a name that merely resembles it is still never borrowed.
     */
    const most = (hits: ArtistSummary[]) => hits.reduce<ArtistSummary | null>((best, a) => (best && (best.fans ?? -1) >= (a.fans ?? -1) ? best : a), null);
    // ARTIST-ARTICLE-001: Deezer files "The Jackson 5" as "Jackson 5". An exact name still wins; only
    // when none matches may a leading "The" (or a trailing ", The") be set aside on both sides.
    const exact = (list: ArtistSummary[], who: string) =>
      most(list.filter((a) => fold(a.name) === fold(who))) ?? most(list.filter((a) => sansArticle(a.name) === sansArticle(who)));
    const lookDz = async (who: string) => {
        try {
          const aid = dzId ?? (who ? exact(await this.searchDz(who, c), who)?.id.slice(3) ?? null : null);
          if (!aid) return (sources['deezer'] = { state: 'none' }), null;
          const r = await this.readDz(aid, c);
          sources['deezer'] = { state: 'ok', count: r.songs.length };
          return r;
        } catch (e) {
          sources['deezer'] = { state: 'failed', detail: (e as Error).message, why: whyNotRead(e) };
          return null;
        }
    };
    type YtLook = { uc: string; page: YtArtistPage } | { none: true } | { failed: unknown };
    // Never rejects and never touches `sources`: an answer that arrives after the page has opened
    // without it must change nothing.
    const lookYt = async (who: string): Promise<YtLook> => {
        try {
          const uc = ytId ?? (who ? exact(await this.searchYt(who, c), who)?.id.slice(3) ?? null : null);
          if (!uc) return { none: true };
          return { uc, page: parseYtArtistPage(await this.yt!.browse(uc, c), uc) };
        } catch (e) {
          return { failed: e };
        }
    };
    /**
     * OPEN-FLOW-001. Measured: Deezer's whole answer is in hand in about half a second; YouTube Music
     * usually takes as long, and now and then holds a request eight seconds before refusing it. Once
     * Deezer has given a page, YouTube Music has a few seconds more and then the page opens without
     * it, saying so. With no Deezer page there is nothing to open with, so it is waited for.
     */
    let until = Infinity;
    let late = false;
    const soon = <T,>(p: Promise<T>): Promise<T | typeof LATE> => {
      if (until === Infinity) return p;
      p.catch(() => undefined);
      return Promise.race([p, new Promise<typeof LATE>((r) => setTimeout(() => r(LATE), Math.max(0, until - Date.now())))]);
    };
    const startClock = () => {
      if (!carry && dzSide && until === Infinity) until = Date.now() + (this.opts.ytGraceMs ?? YT_GRACE_MS);
    };
    // The look the page ends up using: the one a finished page (OPEN-HEAL-001) waits for.
    let looking: Promise<YtLook> = carry ? (carry.ytLook as Promise<YtLook>) : lookYt(name);
    let dzSide: DzSide | null;
    if (carry) {
      dzSide = carry.dz as DzSide | null;
      if (carry.dzSource) sources['deezer'] = { ...carry.dzSource };
    } else dzSide = await lookDz(name);
    startClock();
    let ytLook: YtLook | typeof LATE = await soon(looking);
    // A song can name one artist and carry another's id (YouTube Music gives the first artist that has
    // one). The id decides who this is; the other service is then looked up by that artist's own name.
    const own = carry ? null : dzId ? dzSide?.name : ytId && ytLook !== LATE && 'page' in ytLook ? ytLook.page.name : null;
    if (own && fold(own) !== fold(name)) {
      if (dzId) {
        looking = lookYt(own);
        ytLook = await soon(looking);
      } else {
        dzSide = await lookDz(own);
        startClock();
      }
    }
    // What Deezer said, before the page notes what else it gave: a finished page starts from this.
    const dzSource = sources['deezer'] ? { ...sources['deezer'] } : undefined;
    let reading: Promise<YtSide> | undefined;
    let ytPage: { uc: string; page: YtArtistPage } | null = null;
    if (ytLook === LATE) {
      late = true;
      sources['ytmusic'] = { state: 'failed', detail: 'slow to answer', why: 'busy' };
    } else if ('none' in ytLook) sources['ytmusic'] = { state: 'none' };
    else if ('failed' in ytLook) sources['ytmusic'] = { state: 'failed', detail: (ytLook.failed as Error)?.message ?? '', why: whyNotRead(ytLook.failed) };
    else ytPage = ytLook;
    if (!dzSide && !ytPage) throw new ArtistNotOpened(`No artist named \u201c${name || id}\u201d was found on Deezer or YouTube Music.`, sources);
    let ytSide: YtSide | null = null;
    if (ytPage) {
      try {
        reading = (carry?.ytSongs as Promise<YtSide> | undefined) ?? this.readYtSongs(ytPage.uc, ytPage.page, !dzSide, c);
        const read = await soon(reading);
        if (read === LATE) {
          // The lists behind the shelves are slow: the page opens with the few each shelf shows.
          late = true;
          const p = ytPage.page;
          ytSide = { id: ytPage.uc, name: p.name, url: `https://music.youtube.com/channel/${ytPage.uc}`, picture: p.picture, detail: p.detail, songs: [], albums: [...p.albums, ...p.singles] };
        } else ytSide = read;
        sources['ytmusic'] = { state: 'ok', count: ytSide.songs.length };
      } catch (e) {
        sources['ytmusic'] = { state: 'failed', detail: (e as Error).message, why: whyNotRead(e) };
      }
    }
    const shown = dzSide?.name ?? ytSide?.name ?? name;
    const pool: Track[] = [];
    const seen = new Set<string>();
    for (const t of [...(dzSide?.songs ?? []), ...(ytSide?.songs ?? [])]) {
      if (seen.has(t.key)) continue;
      seen.add(t.key);
      pool.push(t);
    }
    // ARTIST-FEATURES-001: their own songs, and the songs other artists have them on, apart.
    const { songs, features } = partitionFeatures(pool, shown);
    const named = (list: AlbumSummary[]) => list.map((a) => (a.artist ? a : { ...a, artist: shown }));
    const all = mergeAlbums(named(dzSide?.albums ?? []), named(ytSide?.albums ?? []));
    const links: ArtistView['links'] = {};
    if (dzSide) links.deezer = dzSide.url;
    if (ytSide) links.ytmusic = ytSide.url;
    // ARTIST-SOURCES-001: the picture and the audience figure each come from one service; say which.
    const gives = (p: 'deezer' | 'ytmusic', what: 'picture' | 'audience') => {
      const src = sources[p];
      if (src?.state === 'ok') src.gave = [...(src.gave ?? []), what];
    };
    if (dzSide?.picture) gives('deezer', 'picture');
    else if (ytSide?.picture) gives('ytmusic', 'picture');
    if (ytSide?.detail) gives('ytmusic', 'audience');
    else if (dzSide?.detail) gives('deezer', 'audience');
    const view: ArtistView = {
      id: id || (dzSide ? `dz:${dzSide.id}` : `yt:${ytSide!.id}`),
      name: shown,
      picture: dzSide?.picture ?? ytSide?.picture ?? null,
      detail: ytSide?.detail ?? dzSide?.detail ?? null,
      songs,
      features,
      albums: newestFirst(all.filter((a) => a.kind !== 'single')),
      singles: newestFirst(all.filter((a) => a.kind === 'single')),
      links,
      sources,
      similar: mergeSimilar(shown, dzSide?.related ?? [], ytPage?.page.related ?? []),
    };
    const whole = !late && !Object.values(sources).some((x) => x.state === 'failed');
    return late ? { view, whole, carry: { dz: dzSide, dzSource, ytLook: looking, ytSongs: reading } } : { view, whole };
  }

  private async readDz(aid: string, c: Ctx) {
    const [head, top, first, rel] = await Promise.all([
      this.dzGet(`/artist/${aid}`, c),
      this.dzGet(`/artist/${aid}/top?limit=100`, c),
      this.dzGet(`/artist/${aid}/albums?limit=100`, c),
      // ARTIST-CIRCLE-001: Deezer's related artists. A failure here never costs the page.
      this.dzGet(`/artist/${aid}/related?limit=20`, c).catch(() => null),
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
      related: rel ? parseDeezerArtists(rel) : [],
    };
  }

  /**
   * Every song the artist has released: the page's songs, then each album's and single's others.
   * FEATURES-ALL-001: with `features: false` the features are left to `everyFeature`, so the song list
   * never waits on a few hundred small reads.
   */
  everySong(view: Pick<ArtistView, 'id' | 'name' | 'songs' | 'features' | 'albums' | 'singles' | 'links'>, c: Ctx = {}, opts: { features?: boolean } = {}): Promise<ArtistSongs> {
    const albums = this.albums;
    if (!albums) return Promise.reject(new ProviderError('Albums cannot be opened here.'));
    const pages = [...view.albums, ...view.singles];
    const withFeatures = opts.features !== false;
    // 4: features found under one Deezer request identity on every shell (DEEZER-UA-001).
    const key = `${withFeatures ? 'artistsongs4' : 'artistsongsonly1'}:${view.id}:${JSON.stringify(pages.map((p) => p.id))}`;
    const store = artistCache(this.store, c);
    const hit = store?.cacheGet(key)?.value as ArtistSongs | undefined;
    if (hit) return Promise.resolve(hit);
    // An answer missing features is not kept, so the next look asks again (ARTIST-FEATURES-001).
    const keep = store ? { cacheGet: () => null, cachePut: (k: string, kind: string, v: ArtistSongs, ttl: number) => (v.featuresComplete ? store.cachePut(k, kind, v, ttl) : undefined) } : undefined;
    return cached(keep as unknown as Store | undefined, key, 'artist', 6 * 3600, async () => {
      // SONGS-FIRST-001: while a song list is being read, a look for features leaves Deezer to it.
      if (!withFeatures) this.songReads += 1;
      try {
        return await this.readEverySong(view, pages, withFeatures, albums, c);
      } finally {
        if (!withFeatures && --this.songReads === 0) this.songWaiters.splice(0).forEach((r) => r());
      }
    });
  }

  private async readEverySong(view: Pick<ArtistView, 'id' | 'name' | 'songs' | 'features' | 'links'>, pages: AlbumSummary[], withFeatures: boolean, albums: Albums, c: Ctx): Promise<ArtistSongs> {
    {
      const read: (Track[] | null)[] = new Array(pages.length).fill(null);
      let next = 0;
      const worker = async () => {
        while (next < pages.length) {
          const i = next++;
          read[i] = await albums.open(pages[i]!.id, c).then((v) => v.tracks, () => null);
        }
      };
      // The albums, and (for a Deezer artist) more of the songs other artists have them on, together.
      const [, more] = await Promise.all([
        Promise.all(Array.from({ length: Math.min(ALBUM_READS, pages.length) }, worker)),
        withFeatures ? this.findFeatures(view, c) : Promise.resolve({ tracks: [] as Track[], complete: true }),
      ]);
      const songs: Track[] = [];
      const seen = new Set<string>();
      for (const t of [...view.songs, ...read.flatMap((x) => x ?? [])]) {
        if (seen.has(t.key)) continue;
        seen.add(t.key);
        songs.push(t);
      }
      // A song of theirs that an album also holds is their own song, not a feature.
      const had = new Set([...seen, ...(view.features ?? []).map((t) => t.key)]);
      const features: Track[] = [];
      for (const t of more.tracks) {
        if (had.has(t.key)) continue;
        had.add(t.key);
        features.push(t);
      }
      return { songs, features, opened: pages.length, failed: read.filter((x) => x === null).length, featuresComplete: more.complete };
    }
  }

  /**
   * SONGS-FIRST-001. Measured: Deezer answers about nine reads a second, and a song list (one read
   * per album and single) took 12 to 16 seconds while a feature look was asking beside it. The songs
   * are what the page is for, so the look's Deezer reads wait until no song list is being read.
   */
  private songReads = 0;
  private songWaiters: (() => void)[] = [];
  private songsRead(): Promise<void> {
    return this.songReads === 0 ? Promise.resolve() : new Promise((r) => this.songWaiters.push(r));
  }

  /**
   * FEATURES-ALL-001: the songs other artists have them on, beyond the ones the page opened with. On
   * its own so the page can list the songs first. An incomplete answer is not kept, so the next look
   * asks again.
   */
  async everyFeature(view: FeatureView, c: Ctx = {}): Promise<{ features: Track[]; complete: boolean }> {
    const look = this.featureLook(view, c);
    let r: FeatureAnswer;
    do { r = await look.step(c, Infinity); } while (r.more);
    return { features: r.features, complete: r.complete };
  }

  /**
   * FEATURES-FLOW-001: the same look, taken a few seconds at a time. Each `step` works for about `ms`
   * (always long enough to get somewhere) and answers with every feature confirmed so far, so the
   * page can list them as they are found instead of after the last one. A row once given is never
   * moved or dropped; `more` says whether another step would find anything.
   */
  featureLook(view: FeatureView, c: Ctx = {}): { step: (c: Ctx, ms: number) => Promise<FeatureAnswer> } {
    const store = artistCache(this.store, c);
    const key = `artistfeats4:${view.id}`;
    const hit = store?.cacheGet(key)?.value as { features: Track[]; complete: boolean } | undefined;
    if (hit) return { step: async () => ({ features: hit.features, complete: hit.complete, more: false }) };
    const st = this.featureState(view, c);
    let running: Promise<FeatureAnswer> | null = null;
    return {
      step: (next, ms) => {
        // One step at a time: a second caller is given the first one's answer.
        running ??= this.featureStep(st, { ...c, ...next }, ms)
          .then(async (r) => {
            if (!r.more && r.complete) await store?.cachePut(key, 'artist', { features: r.features, complete: true }, 24 * 3600);
            return r;
          })
          .finally(() => { running = null; });
        return running;
      },
    };
  }

  /** Every feature, with no answer kept: for the every-song look that still asks for both together. */
  private async findFeatures(view: FeatureView, c: Ctx): Promise<{ tracks: Track[]; complete: boolean }> {
    const st = this.featureState(view, c);
    let r: FeatureAnswer;
    do { r = await this.featureStep(st, c, Infinity); } while (r.more);
    return { tracks: r.features, complete: r.complete };
  }

  private featureState(view: FeatureView, c: Ctx = {}): FeatureState {
    const dzId = view.name ? /\/artist\/(\d{1,15})/.exec(view.links?.deezer ?? '')?.[1] ?? /^dz:(\d{1,15})$/.exec(view.id)?.[1] ?? null : null;
    const uc = view.name && this.yt ? /\/channel\/(UC[A-Za-z0-9_-]{22})(?![A-Za-z0-9_-])/.exec(view.links?.ytmusic ?? '')?.[1] ?? /^yt:(UC[A-Za-z0-9_-]{22})$/.exec(view.id)?.[1] ?? null : null;
    const shown = [...view.songs, ...(view.features ?? [])];
    const known = new Set<string>();
    for (const t of view.features ?? []) {
      if (t.provider === 'deezer' && t['platform_id']) known.add(String(t['platform_id']));
    }
    // FEATURES-FLOW-001: what earlier looks learnt about each candidate. Who is on a song does not
    // change, so one that was read is not read again: a look again, or a look a step at a time that
    // was left half way, picks up where the last one stopped.
    const verdictKey = dzId ? `artistfeatverdict2:${dzId}` : null;
    const kept = (verdictKey ? artistCache(this.store, c)?.cacheGet(verdictKey)?.value : undefined) as { no?: string[]; yes?: Record<string, Track> } | undefined;
    return {
      dzId, uc, name: view.name, known, verdictKey,
      no: new Set(kept?.no ?? []), yes: { ...(kept?.yes ?? {}) }, dirty: false,
      queries: dzId ? featureSearches(view.name) : [], q: 0, index: 0, at: 0, p: 0,
      // A service the page opened without (slow, or not reached) was not asked for features either:
      // the list says it is incomplete, so it is not kept and "Look again" is offered.
      ids: new Set(), accepted: 0, queue: [], searching: null, searchDone: !dzId, dzFound: new Map(), dzComplete: view.sources?.['deezer']?.state !== 'failed',
      ytQueries: uc ? ytFeatureSearches(view.name) : [], yq: 0, ytToken: null, yp: 0, quiet: 0, ytDone: !uc, ytFound: [], ytSeen: new Set(), ytTokens: new Set(), ytComplete: view.sources?.['ytmusic']?.state !== 'failed',
      // A Deezer row is dropped only when it is one the page already lists as a feature; a YouTube
      // Music row also when the page has the song at all, or Deezer has it under the same title and lead.
      had: new Set((view.features ?? []).map((t) => t.key)), shown: new Set(shown.map((t) => t.key)),
      said: new Set((view.features ?? []).map(featureKey)), emitted: [],
      ctx: {}, until: 0, running: null,
    };
  }

  private async featureStep(st: FeatureState, c: Ctx, ms: number): Promise<FeatureAnswer> {
    // The work goes on for as long as steps keep being asked for: each step moves the time it may
    // run until, and starts it again if it had stopped. Requests are charged to the newest step.
    st.ctx = c;
    st.until = ms === Infinity ? Infinity : Date.now() + Math.max(0, ms);
    if (!st.running) {
      // Deezer allows about nine reads a second; these share them. YouTube Music is asked one page
      // at a time: asked faster, it starts answering "slow down".
      const run = Promise.all([
        this.dzSearchLoop(st),
        ...Array.from({ length: FEATURE_READS }, () => this.dzReadLoop(st)),
        this.ytLoop(st),
      ]).then(() => undefined, () => undefined).finally(() => { if (st.running === run) st.running = null; });
      st.running = run;
    }
    // FEATURES-FLOW-001: a step answers when its time is up, whatever is still in flight. Measured:
    // YouTube Music now and then holds a page six to nine seconds, and a step that waited for it
    // left the list with nothing new for 13 and 20 seconds. What is in flight lands in a later step.
    if (ms === Infinity) await st.running;
    else if (st.running) await Promise.race([st.running, new Promise<void>((r) => setTimeout(r, Math.max(0, ms) + STEP_SLACK_MS))]);
    for (const order of [...st.dzFound.keys()].sort((a, b) => a - b)) {
      const t = st.dzFound.get(order)!;
      if (st.had.has(t.key)) continue;
      st.had.add(t.key);
      st.shown.add(t.key);
      st.said.add(featureKey(t));
      st.emitted.push(t);
    }
    st.dzFound.clear();
    for (const t of st.ytFound.splice(0)) {
      const k = featureKey(t);
      if (st.shown.has(t.key) || st.had.has(t.key) || st.said.has(k)) continue;
      st.shown.add(t.key);
      st.said.add(k);
      st.emitted.push(t);
    }
    if (st.dirty && st.verdictKey) {
      st.dirty = false;
      await artistCache(this.store, c)?.cachePut(st.verdictKey, 'artist', { no: [...st.no], yes: st.yes }, 30 * 24 * 3600);
    }
    const more = st.running !== null || !(st.searchDone && st.queue.length === 0 && st.ytDone);
    return { features: [...st.emitted], complete: st.dzComplete && st.ytComplete, more };
  }

  /** The allowance is spent, or the look was called off: nothing further can be asked. */
  private static halts(e: unknown): boolean {
    return e instanceof BudgetExceeded || e instanceof Cancelled;
  }

  /**
   * ARTIST-FEATURES-001: more of the songs other artists have them on. Their most played list holds
   * the best known ones; a name search offers others, but a search row never says who is on the song,
   * so each candidate is read once and kept only when Deezer's own contributors name this artist. A
   * row that merely has the words in its title is never claimed as a feature.
   */
  private async dzSearchLoop(st: FeatureState): Promise<void> {
    for (let did = false; !st.searchDone && (!did || Date.now() < st.until); did = true) {
      // The wait for a song list (SONGS-FIRST-001) is part of the search, so the readers wait on it too.
      st.searching = (async () => {
        if (this.songReads > 0) await this.songsRead();
        await this.dzSearchPage(st, st.ctx);
      })();
      await st.searching;
      st.searching = null;
    }
  }

  /** One page of one search. Never rejects: what went wrong is recorded as "incomplete". */
  private async dzSearchPage(st: FeatureState, c: Ctx): Promise<void> {
    const query = st.queries[st.q]!;
    // FEATURES-ALL-001: the name search first (it must answer, or there is nothing to go on), then the
    // two that find what it leaves out. One of those failing keeps the rows and says "incomplete".
    const first = st.q === 0 && st.p === 0;
    const advance = () => {
      st.q += 1;
      st.index = 0;
      st.at = 0;
      st.p = 0;
      if (st.q >= st.queries.length) st.searchDone = true;
    };
    let resp: Json;
    try {
      resp = await this.dzGet(`/search/track?q=${encodeURIComponent(query)}&limit=100${st.index ? `&index=${st.index}` : ''}`, c);
    } catch (e) {
      st.dzComplete = false;
      if (first || Artists.halts(e)) {
        st.searchDone = true;
        st.queue.length = 0;
      } else advance();
      return;
    }
    for (const x of (resp['data'] as Json[] | undefined) ?? []) {
      const id = x && x['id'] ? String(x['id']) : '';
      if (!id || st.known.has(id) || st.ids.has(id) || String(x['artist']?.['id'] ?? '') === st.dzId) continue;
      st.ids.add(id);
      if (st.accepted >= FEATURE_CANDIDATES) { st.dzComplete = false; continue; }
      st.queue.push({ id, order: st.accepted++ });
    }
    // Every page the search offers, by Deezer's own next link, so a feature far down the list is still
    // found whatever page size Deezer answers. Only the link's index is taken, and only when it is a
    // later page of this same search: any other address is never fetched.
    if (typeof resp['next'] !== 'string') return advance();
    const index = nextSearchIndex(resp['next'], query);
    if (index === null || index <= st.at || st.p + 1 >= FEATURE_PAGES) {
      st.dzComplete = false;
      return advance();
    }
    st.at = index;
    st.index = index;
    st.p += 1;
  }

  private async dzReadLoop(st: FeatureState): Promise<void> {
    for (let did = false; !did || Date.now() < st.until;) {
      const cand = st.queue.shift();
      if (!cand) {
        // Nothing to read yet: wait for the page being searched, if one is.
        if (st.searchDone || !st.searching) return;
        await st.searching;
        continue;
      }
      if (st.no.has(cand.id)) continue;
      const kept = st.yes[cand.id];
      if (kept) { st.dzFound.set(cand.order, kept); continue; }
      if (this.songReads > 0) await this.songsRead();
      did = true;
      let full: Json;
      try {
        full = await this.dzGet(`/track/${cand.id}`, st.ctx);
      } catch (e) {
        st.dzComplete = false;
        if (Artists.halts(e)) {
          st.searchDone = true;
          st.queue.length = 0;
          return;
        }
        continue;
      }
      // Confirmed by Deezer's id for this artist, never by the name: a namesake is someone else.
      const contributors = full['contributors'];
      // A partial response is unknown, not a cached negative verdict lasting a month.
      if (!Array.isArray(contributors) || contributors.length === 0 || !full['artist']?.['id']) { st.dzComplete = false; continue; }
      const on = String(full['artist']['id']) !== st.dzId && (contributors as Json[]).some((x) => String(x['id']) === st.dzId);
      if (on) {
        const t = this.dz.toTrack(full);
        st.dzFound.set(cand.order, t);
        st.yes[cand.id] = t;
      } else st.no.add(cand.id);
      st.dirty = true;
    }
  }

  /**
   * FEATURES-ALL-002: the songs on YouTube Music that another artist leads and that link THIS
   * artist's channel. Confirmed by the channel id, never by the name: a namesake is someone else,
   * and a row that only has the name in its title is not a feature.
   */
  private async ytLoop(st: FeatureState): Promise<void> {
    const yt = this.yt;
    if (!yt) { st.ytDone = true; return; }
    const advance = () => {
      st.yq += 1;
      st.ytToken = null;
      st.yp = 0;
      st.quiet = 0;
      st.ytTokens.clear();
      if (st.yq >= st.ytQueries.length) st.ytDone = true;
    };
    for (let did = false; !st.ytDone && (!did || Date.now() < st.until); did = true) {
      let page: { items: YtItem[]; next: string | null };
      try {
        page = await yt.songSearchPage(st.ytQueries[st.yq]!, st.ytToken, st.ctx);
      } catch (e) {
        // A page that fails keeps the rows already read, and the answer says it is incomplete.
        st.ytComplete = false;
        if (Artists.halts(e)) { st.ytDone = true; return; }
        advance();
        continue;
      }
      let on = false;
      for (const x of page.items) {
        if (!x.artists.some((a) => a.id === st.uc)) continue;
        on = true;
        if (x.artists[0]?.id === st.uc) continue;
        const t = yt.toTrack(x, 'song');
        if (st.ytSeen.has(t.key)) continue;
        st.ytSeen.add(t.key);
        st.ytFound.push(t);
      }
      st.quiet = on ? 0 : st.quiet + 1;
      st.ytToken = page.next;
      if (!st.ytToken) advance();
      else if (st.ytTokens.has(st.ytToken) || st.yp + 1 >= YT_FEATURE_PAGES) { st.ytComplete = false; advance(); }
      else { st.ytTokens.add(st.ytToken); st.yp += 1; }
      // About a page a second. Measured 2026-11-16: read as fast as they come, some forty pages an
      // artist, YouTube Music started holding requests and refusing them, and the artist pages
      // opened next then had to do without it. Nothing is waiting on this list.
      if (!st.ytDone) await this.http.wait(YT_PAGE_GAP_MS);
    }
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
    // The page's shelves show about ten each; their "More" lists hold the rest of the discography. A
    // shelf that cannot be read leaves the few the page showed, rather than failing the whole artist.
    // Asked together (OPEN-FLOW-001), each by the list's own id (DISCOGRAPHY-MORE-001).
    const whole = (await Promise.all(page.more.map((m) => yt.discography(m.browseId, m.params, c).then((r) => parseYtDiscography(r, page.name), () => [] as AlbumSummary[])))).flat();
    return {
      id: uc, name: page.name, url: `https://music.youtube.com/channel/${uc}`, picture: page.picture, detail: page.detail, songs,
      albums: [...page.albums, ...page.singles, ...whole],
    };
  }
}
