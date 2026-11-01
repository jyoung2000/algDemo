/**
 * YouTube Music adapter. Python uses ytmusicapi; there is no JS port that runs in a WebView, so this
 * calls the same unauthenticated InnerTube endpoints (search, next, browse) and ports the parsers it
 * needs from ytmusicapi (parse_song_runs, parse_song_flat, parse_watch_track, parse_mixed_content).
 * Behaviour mirrors providers.py YouTubeMusic. Verified against responses recorded live from
 * music.youtube.com (see fixtures/ytm-*.json), trimmed to the first few items.
 */
import type { CancelToken, Http, Meter } from './net';
import { fold, matchRecordings } from './identity';
import { makeTrack, release, type Track } from './track';
import { cached, NeedsChoice, ProviderError } from './deezer';
import type { Store } from './store';

type Json = Record<string, any>;
export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

const API = 'https://music.youtube.com/youtubei/v1/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0';
/** ytmusicapi get_search_params('songs'). */
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_BYTES = 4_000_000;

export interface Artist {
  name: string;
  id: string | null;
}
/** What ytmusicapi hands back for one song, after parsing. */
export interface YtItem {
  videoId: string;
  title: string;
  artists: Artist[];
  album: Artist | null;
  duration_seconds: number | null;
  year: string | null;
  thumbnails: { url: string }[];
  videoType: string;
  isExplicit: boolean | null;
}

// ---- ytmusicapi parsers ---------------------------------------------------------------------

/** Walk `path` through `o`; undefined when any step is missing (ytmusicapi nav(..., none_if_absent)). */
const nav = (o: any, path: (string | number)[]): any => path.reduce((a, k) => (a == null ? undefined : a[k]), o);

const VIEWS_PREFIX = /^\D*?[\s:\uff1a\u200e-\u200f\u202a-\u202e]/;

function parseViews(text: string): string | null {
  let prefixed = false;
  if (!/[a-zA-Z]/.test(text)) {
    const next = text.replace(VIEWS_PREFIX, '');
    prefixed = next !== text;
    text = next;
  }
  if (!/^\d/.test(text)) return null;
  // A bare ASCII token like "2Pac" is an artist, not a view count with a stripped word.
  if (!prefixed && /^[\x00-\x7f]*$/.test(text) && !text.includes(' ')) return null;
  return text.split(' ')[0]!.split('\u00a0').slice(0, 2).join('\u00a0');
}

type Run = { text: string; navigationEndpoint?: Json };
type Parsed =
  | { type: 'album' | 'artist'; data: Artist }
  | { type: 'duration' | 'year' | 'views'; data: string };

function parseSongRun(run: Run): Parsed {
  const text = run.text;
  if (run.navigationEndpoint) {
    const id: string | null = nav(run, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ?? null;
    const item = { name: text, id };
    return id && (id.startsWith('MPRE') || id.includes('release_detail')) ? { type: 'album', data: item } : { type: 'artist', data: item };
  }
  if (/^(\d+:)*\d+:\d+$/.test(text)) return { type: 'duration', data: text };
  if (/^\d{4}$/.test(text)) return { type: 'year', data: text };
  const v = parseViews(text);
  if (v !== null) return { type: 'views', data: v };
  return { type: 'artist', data: { name: text, id: null } };
}

export function parseDuration(d: string | null | undefined): number | null {
  if (!d || !d.trim()) return null;
  const parts = d.trim().split(':');
  if (parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.reverse().slice(0, 3).reduce((s, p, i) => s + Number(p) * [1, 60, 3600][i]!, 0);
}

const isDot = (r: Run | undefined) => !!r && r.text === ' • ' && !r.navigationEndpoint;

interface SongRuns {
  artists?: Artist[];
  album?: Artist;
  duration?: string;
  duration_seconds?: number | null;
  year?: string;
  views?: string;
}

export function parseSongRuns(runs: Run[], skipTypeSpec = false): SongRuns {
  const out: SongRuns = {};
  // The unlinked first run ("Song", "Single") is a type label, not an artist.
  if (
    skipTypeSpec &&
    runs.length > 2 &&
    !runs[0]!.navigationEndpoint &&
    parseSongRun(runs[0]!).type === 'artist' &&
    isDot(runs[1]) &&
    ['artist', 'duration', 'views', 'year'].includes(parseSongRun(runs[2]!).type)
  ) {
    runs = runs.slice(2);
  }
  runs.forEach((run, i) => {
    if (i % 2) return; // odd items are separators
    const p = parseSongRun(run);
    switch (p.type) {
      case 'album': out.album = p.data; break;
      case 'artist': (out.artists ??= []).push(p.data); break;
      case 'views': out.views = p.data; break;
      case 'duration': out.duration = p.data; out.duration_seconds = parseDuration(p.data); break;
      case 'year': out.year = p.data; break;
    }
  });
  return out;
}

const flexRuns = (li: Json, i: number): Run[] | undefined => li.flexColumns?.[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
const PLAY = ['overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer'];
const VIDEO_TYPE = ['watchEndpoint', 'watchEndpointMusicSupportedConfigs', 'watchEndpointMusicConfig', 'musicVideoType'];

/** musicResponsiveListItemRenderer -> song (ytmusicapi parse_song_flat). Null when it has no video. */
export function parseSongFlat(li: Json): YtItem | null {
  const c0 = flexRuns(li, 0);
  const play = nav(li, [...PLAY, 'playNavigationEndpoint']);
  const videoId: string | undefined = nav(c0?.[0], ['navigationEndpoint', 'watchEndpoint', 'videoId']) ?? nav(play, ['watchEndpoint', 'videoId']);
  if (!videoId) return null;
  const runs = flexRuns(li, 1) ?? [];
  const sr = parseSongRuns(runs, true);
  const thumbs: { url: string }[] = nav(li, ['thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails']) ?? [];
  return {
    videoId,
    title: c0?.[0]?.text ?? '',
    artists: sr.artists ?? [],
    album: sr.album ?? (li.flexColumns?.length > 2 ? albumColumn(li) : null),
    duration_seconds: sr.duration_seconds ?? fixedDuration(li),
    year: sr.year ?? null,
    thumbnails: thumbs,
    videoType: nav(play, VIDEO_TYPE) ?? '',
    isExplicit: nav(li, ['badges', 0, 'musicInlineBadgeRenderer', 'accessibilityData', 'accessibilityData', 'label']) != null,
  };
}

function albumColumn(li: Json): Artist | null {
  const r = flexRuns(li, 2)?.[0];
  return r ? { name: r.text, id: nav(r, ['navigationEndpoint', 'browseEndpoint', 'browseId']) ?? null } : null;
}

function fixedDuration(li: Json): number | null {
  const t = nav(li, ['fixedColumns', 0, 'musicResponsiveListItemFixedColumnRenderer', 'text', 'runs', 0, 'text']);
  return parseDuration(t);
}

/** playlistPanelVideoRenderer -> song (ytmusicapi parse_watch_track). */
export function parseWatchTrack(d: Json): YtItem {
  const sr = parseSongRuns(nav(d, ['longBylineText', 'runs']) ?? []);
  const len: string | undefined = nav(d, ['lengthText', 'runs', 0, 'text']);
  return {
    videoId: d.videoId,
    title: nav(d, ['title', 'runs', 0, 'text']) ?? '',
    artists: sr.artists ?? [],
    album: sr.album ?? null,
    duration_seconds: sr.duration_seconds ?? parseDuration(len),
    year: sr.year ?? null,
    thumbnails: nav(d, ['thumbnail', 'thumbnails']) ?? [],
    videoType: nav(d, ['navigationEndpoint', ...VIDEO_TYPE]) ?? '',
    isExplicit: null,
  };
}

/** The watch panel: playable tracks plus the browse id of its "Related" tab. */
export function parseWatch(resp: Json): { tracks: YtItem[]; related: string | null } {
  const wn = nav(resp, ['contents', 'singleColumnMusicWatchNextResultsRenderer', 'tabbedRenderer', 'watchNextTabbedResultsRenderer']);
  if (!wn) throw new ProviderError('YouTube Music returned nothing for that video.');
  let related: string | null = null;
  for (const tab of wn.tabs ?? []) {
    if (tab.tabRenderer?.unselectable) continue;
    const be = nav(tab, ['tabRenderer', 'endpoint', 'browseEndpoint']);
    if (nav(be, ['browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType']) === 'MUSIC_PAGE_TYPE_TRACK_RELATED') related = be.browseId;
  }
  const panel = nav(wn, ['tabs', 0, 'tabRenderer', 'content', 'musicQueueRenderer', 'content', 'playlistPanelRenderer', 'contents']);
  if (!panel) throw new ProviderError('YouTube Music returned nothing for that video.');
  const tracks: YtItem[] = [];
  for (let r of panel as Json[]) {
    if (r.playlistPanelVideoWrapperRenderer) r = r.playlistPanelVideoWrapperRenderer.primaryRenderer;
    const d = r?.playlistPanelVideoRenderer;
    if (!d || d.unplayableText) continue;
    tracks.push(parseWatchTrack(d));
  }
  return { tracks, related };
}

/** The "Related" tab: "You might also like" songs and "Similar artists". */
export function parseRelated(resp: Json): { songs: YtItem[]; artists: { id: string | null; name: string }[] } {
  const out = { songs: [] as YtItem[], artists: [] as { id: string | null; name: string }[] };
  const sections: Json[] = nav(resp, ['contents', 'sectionListRenderer', 'contents']) ?? [];
  for (const s of sections) {
    const shelf = s.musicCarouselShelfRenderer;
    if (!shelf) continue;
    const title = String(nav(shelf, ['header', 'musicCarouselShelfBasicHeaderRenderer', 'title', 'runs', 0, 'text']) ?? '').toLowerCase();
    const contents: Json[] = shelf.contents ?? [];
    if (title === 'you might also like') {
      for (const c of contents) {
        const song = c.musicResponsiveListItemRenderer && parseSongFlat(c.musicResponsiveListItemRenderer);
        if (song) out.songs.push(song);
      }
    } else if (title === 'similar artists') {
      for (const c of contents) {
        const d = c.musicTwoRowItemRenderer;
        const name = nav(d, ['title', 'runs', 0, 'text']);
        const be = nav(d, ['title', 'runs', 0, 'navigationEndpoint', 'browseEndpoint']);
        if (name) out.artists.push({ id: be?.browseId ?? null, name });
      }
    }
  }
  return out;
}

export function parseSearchSongs(resp: Json): YtItem[] {
  const tabs: Json[] = nav(resp, ['contents', 'tabbedSearchResultsRenderer', 'tabs']) ?? [];
  const sections: Json[] = nav(tabs, [0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents']) ?? [];
  const out: YtItem[] = [];
  for (const s of sections) {
    for (const c of s.musicShelfRenderer?.contents ?? []) {
      const song = c.musicResponsiveListItemRenderer && parseSongFlat(c.musicResponsiveListItemRenderer);
      if (song) out.push(song);
    }
  }
  return out;
}

export function parsePlaylist(resp: Json): { title: string; trackCount: number | null; tracks: YtItem[] } {
  const two = nav(resp, ['contents', 'twoColumnBrowseResultsRenderer']);
  const shelf = nav(two, ['secondaryContents', 'sectionListRenderer', 'contents', 0, 'musicPlaylistShelfRenderer']);
  if (!shelf) throw new ProviderError('That playlist is private, empty or not available without signing in.');
  const head = nav(two, ['tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents', 0, 'musicResponsiveHeaderRenderer']);
  const subtitle = ((nav(head, ['secondSubtitle', 'runs']) ?? []) as Run[]).map((r) => r.text).join('');
  const count = /([\d,]+) tracks?/.exec(subtitle);
  const tracks: YtItem[] = [];
  for (const c of shelf.contents ?? []) {
    const song = c.musicResponsiveListItemRenderer && parseSongFlat(c.musicResponsiveListItemRenderer);
    if (song) tracks.push(song);
  }
  return { title: nav(head, ['title', 'runs', 0, 'text']) ?? '', trackCount: count ? Number(count[1]!.replace(/,/g, '')) : null, tracks };
}

// ---- adapter --------------------------------------------------------------------------------

const H = 3600;
const DAY = 86400;

export class YouTubeMusic {
  readonly name = 'ytmusic';
  readonly label = 'YouTube Music';

  constructor(private readonly http: Http, private readonly store?: Store) {}

  private async post(endpoint: string, body: Json, c: Ctx): Promise<Json> {
    const context = { context: { client: { clientName: 'WEB_REMIX', clientVersion: `1.${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.01.00` }, user: {} } };
    const o: Parameters<Http['getJson']>[1] = {
      category: 'metadata',
      maxBytes: MAX_BYTES,
      method: 'POST',
      body: JSON.stringify({ ...body, ...context }),
      headers: { 'user-agent': UA, 'content-type': 'application/json', origin: 'https://music.youtube.com' },
    };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    return this.http.getJson<Json>(`${API}${endpoint}?alt=json`, o);
  }

  private watch(videoId: string, limit: number, c: Ctx, radio = false) {
    const body: Json = { enablePersistentPlaylistPanel: true, isAudioOnly: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL', videoId, playlistId: `RDAMVM${videoId}` };
    if (radio) body['params'] = 'wAEB';
    else body['watchEndpointMusicSupportedConfigs'] = { watchEndpointMusicConfig: { hasPersistentPlaylistPanel: true, musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' } };
    return this.post('next', body, c).then(parseWatch).then((w) => ({ ...w, tracks: w.tracks.slice(0, Math.max(1, limit)) }));
  }

  toTrack(x: YtItem, kind?: string): Track {
    let arts = x.artists.map((a) => a.name).filter(Boolean);
    arts = arts.filter((a) => !/^[\d.,]+[KMB]? (views|plays)$/.test(a));
    const thumb = x.thumbnails.length ? x.thumbnails[x.thumbnails.length - 1]!.url : null;
    const art = thumb && thumb.includes('=w') ? thumb.replace(/=w\d+-h\d+/, '=w240-h240') : thumb;
    const vtype = x.videoType || '';
    const rel = x.year ? release(x.year, 'release', 'YouTube Music') : null;
    return makeTrack({
      provider: 'ytmusic', platformId: x.videoId, title: x.title || '', artists: arts.length ? arts : ['Unknown artist'],
      album: x.album?.name ?? null, duration: x.duration_seconds, artwork: art,
      url: `https://music.youtube.com/watch?v=${x.videoId}`, rel,
      artistIds: { ytmusic: x.artists.find((a) => a.id)?.id ?? '' },
      explicit: x.isExplicit, kind: kind ?? (['MUSIC_VIDEO_TYPE_ATV', 'MUSIC_VIDEO_TYPE_OMV', ''].includes(vtype) ? 'song' : 'video'),
      extra: { video_type: vtype },
    });
  }

  search(q: string, limit = 15, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `yt:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const r = await this.post('search', { query: q, params: SONGS_FILTER }, c);
      return parseSearchSongs(r).slice(0, limit).map((x) => this.toTrack(x, 'song'));
    });
  }

  song(vid: string, c: Ctx = {}): Promise<Track> {
    return cached(this.store, `yt:song:${vid}`, 'track', 7 * DAY, async () => {
      let w;
      try {
        w = await this.watch(vid, 1, c);
      } catch (e) {
        if (e instanceof ProviderError || /HTTP 4\d\d/.test(String((e as Error).message))) {
          throw new ProviderError('YouTube has no video at that link, or it is private or removed.');
        }
        throw e;
      }
      const first = w.tracks[0];
      if (!first) throw new ProviderError('YouTube Music returned nothing for that video.');
      if (first.videoId !== vid) throw new ProviderError('That video is unavailable on YouTube Music.');
      return { ...this.toTrack(first), related_browse: w.related };
    });
  }

  async resolveLink(url: string, c: Ctx = {}): Promise<Track> {
    const u = new URL(url);
    const host = u.hostname;
    let vid: string | null = null;
    if (host === 'youtu.be') vid = u.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || null;
    else if (u.pathname === '/watch') vid = u.searchParams.get('v');
    else if (/^\/(shorts|live|embed)\//.test(u.pathname)) {
      throw new ProviderError('Shorts, live streams and embeds are videos, not songs. Paste a song or music-video link.');
    }
    const playlist = u.searchParams.get('list');
    if (!vid && u.pathname === '/playlist' && playlist) return this.playlist(playlist, c);
    if (!vid || !YT_ID.test(vid)) throw new ProviderError('That YouTube link does not point at a single video.');
    const t = await this.song(vid, c);
    if (t.kind === 'video') return { ...t, warning: 'YouTube marks this as a user upload, not an official song. It may be a mix, cover or clip.' };
    return t;
  }

  /** Playlists are never added whole: the user picks songs, so this always throws NeedsChoice. */
  async playlist(pid: string, c: Ctx = {}, limit = 25): Promise<never> {
    if (/^(RD|LL|WL)/.test(pid)) throw new ProviderError('Mixes, Liked and Watch Later lists are personal or generated; paste a public playlist or a song.');
    let p;
    try {
      p = parsePlaylist(await this.post('browse', { browseId: pid.startsWith('VL') ? pid : `VL${pid}` }, c));
    } catch (e) {
      if (e instanceof ProviderError && /private, empty/.test(e.message)) throw e;
      throw new ProviderError('That playlist is private, empty or not available without signing in.');
    }
    const tracks = p.tracks.slice(0, limit).map((x) => this.toTrack(x));
    throw new NeedsChoice('playlist', `“${p.title}” is a playlist. Choose the songs you want from it.`, { title: p.title, count: p.trackCount, tracks, bounded: limit });
  }

  radio(vid: string, limit: number, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `yt:radio:${vid}:${limit}`, 'related', 6 * H, async () => {
      // +1: the first track is the seed itself (ytmusicapi's limit counts it).
      const w = await this.watch(vid, limit + 1, c);
      return w.tracks.slice(1).slice(0, limit).map((x) => this.toTrack(x));
    });
  }

  /** The radio call returns up to 50 tracks regardless of `limit`; take them all (watch() trims to `limit`). */
  related(vid: string, c: Ctx = {}): Promise<{ songs: Track[]; artists: { id: string | null; name: string }[] }> {
    return cached(this.store, `yt:related:${vid}`, 'related', 12 * H, async () => {
      const song = await this.song(vid, c);
      let browse = song['related_browse'] as string | null | undefined;
      if (!browse) browse = (await this.watch(vid, 1, c)).related;
      if (!browse) return { songs: [], artists: [] };
      const r = parseRelated(await this.post('browse', { browseId: browse }, c));
      return { songs: r.songs.map((x) => this.toTrack(x)), artists: r.artists };
    });
  }

  async findMatch(t: Track, c: Ctx = {}): Promise<{ match: Track | null; uncertain: Track[] }> {
    if (t.provider === 'ytmusic') return { match: t, uncertain: [] };
    const q = `${t.artists[0] ?? ''} ${t.title}`.trim();
    const uncertain: Track[] = [];
    for (const r of await this.search(q, 8, c)) {
      const v = matchRecordings(t, r);
      if (v.verdict === 'same') return { match: r, uncertain: [] };
      if (v.verdict === 'uncertain') uncertain.push({ ...r, match_note: v.reason });
    }
    return { match: null, uncertain: uncertain.slice(0, 5) };
  }
}
