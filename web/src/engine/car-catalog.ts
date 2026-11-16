import { api, type AlbumSearchResponse, type AlbumView, type IdentifyResponse, type SearchResponse, type Track } from '../api';
import { namesAlbum } from './album-key';
import { carAlbumTrackId, decodeCarAlbumId, songFromTrack, type CarKind, type CarSearchMode, type CatalogAnswer, type NativeAlbum, type NativeSong } from './media-native';
import { isAlbumTrack, isByArtist, isFeatureTrack, isSingleTrack } from '../result-types';

/**
 * CAR-SEARCH-TYPES-001: the kinds a song is, for the car's search icons. RESULT-ARTIST-001: a song
 * is the searched artist's when the search names one of its credited artists.
 */
export function carKinds(t: Track, lyricMatch = false, query = ''): CarKind[] {
  const k: CarKind[] = [];
  if (isSingleTrack(t)) k.push('single');
  else if (isAlbumTrack(t)) k.push('album');
  if (isFeatureTrack(t)) k.push('feature');
  if (lyricMatch) k.push('lyrics');
  if (query && isByArtist(t, query)) k.push('artist');
  return k;
}

/** CAR-SEARCH-TYPES-001: what the car's Identify icon needs from the fingerprint code. */
export interface Fingerprinter {
  SAMPLE_RATE: number;
  makeSignature: (samples: Float32Array, signal?: AbortSignal) => Promise<unknown>;
  pickWindow: (samples: Float32Array) => Float32Array;
  peakCount: (sig: never) => number;
  signatureUri: (sig: never) => string;
  signatureMillis: (sig: never) => number;
}

/** ALBUM-CAR-001: how many albums a car search opens, and how many songs of each the car lists. */
const CAR_ALBUMS = 3;
const CAR_ALBUM_SONGS = 60;
/**
 * CAR-AUX-BOUND-001: how long a car search waits for its lyric matches and album bodies. The song
 * matches are the answer; these only add to it and must never hold it past the car's deadline.
 */
export const CAR_AUX_MS = 6_000;

/** [p], or [fallback] once [ms] pass first (the work itself is left to finish or fail on its own). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => { t = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

/** Bounded catalogue search for car queries. Search is metadata discovery, never automatic queue
 * insertion or proof of downloaded audio; selecting a retained Track uses the ordinary full-song
 * player/resolver. The native layer owns request IDs, timeout and result notifications. */
export class CarCatalog {
  private readonly tracks = new Map<string, Track>();
  /** ALBUM-CAR-001: the albums a car search opened, by album id, songs in album order. */
  private readonly albumTracks = new Map<string, Track[]>();
  private latest = '';
  constructor(
    private readonly lookup: (query: string) => Promise<SearchResponse> = api.search,
    private readonly ready: (track: Track) => boolean = () => false,
    /** VOICE-SEARCH-001: the car asks for lyrics too, as the phone's search box does. */
    private readonly lyrics: ((query: string) => Promise<IdentifyResponse>) | null = null,
    /** ALBUM-CAR-001: the car asks for albums too, and opens the first few. */
    private readonly albums: ((query: string) => Promise<AlbumSearchResponse>) | null = null,
    private readonly openAlbum: ((id: string) => Promise<{ album: AlbumView }>) | null = null,
    /** CAR-SEARCH-TYPES-001: Shazam-style naming of the music the phone heard. */
    private readonly identify: ((signature: string, ms: number) => Promise<IdentifyResponse>) | null = null,
    private readonly fingerprint: (() => Promise<Fingerprinter>) | null = null,
  ) {}
  /** SERVICE-API-001: recent result lists, newest first, so a song's whole list can be found again. */
  private readonly lists: string[][] = [];
  find(id: string): Track | undefined { return this.tracks.get(id) ?? this.albumOf(id)?.track; }

  /**
   * The song a car id names with the exact list it was offered in. Album ids decode through the
   * existing helper and must name a retained album song; any other id containing a slash, or one this
   * catalogue never offered, is refused.
   */
  contextOf(id: string): { tracks: Track[]; ids: string[]; index: number } | null {
    const album = this.albumOf(id);
    if (album) {
      const albumId = decodeCarAlbumId(id)!.albumId;
      return { tracks: album.tracks, ids: album.tracks.map(t => carAlbumTrackId(albumId, t.key)), index: album.tracks.indexOf(album.track) };
    }
    if (id.includes('/') || !this.tracks.has(id)) return null;
    const keys = this.lists.find(l => l.includes(id)) ?? [id];
    const tracks = keys.flatMap(k => { const t = this.tracks.get(k); return t ? [t] : []; });
    return { tracks, ids: tracks.map(t => t.key), index: Math.max(0, tracks.findIndex(t => t.key === id)) };
  }

  private rememberList(rows: readonly Track[]): void {
    if (!rows.length) return;
    this.lists.unshift(rows.map(t => t.key));
    this.lists.length = Math.min(this.lists.length, 10);
  }

  /** The song a car album id names, with the album it plays in; null for any other id. */
  albumOf(id: string): { track: Track; tracks: Track[] } | null {
    const ref = decodeCarAlbumId(id);
    const tracks = ref ? this.albumTracks.get(ref.albumId) : undefined;
    const track = tracks?.find((t) => t.key === ref!.key);
    return track && tracks ? { track, tracks } : null;
  }

  async search(raw: string): Promise<NativeSong[]> {
    return (await this.searchAll(raw)).songs;
  }

  async searchAll(raw: string, opts: { album?: boolean; mode?: CarSearchMode } = {}): Promise<Required<CatalogAnswer>> {
    const none = { songs: [], albums: [], play: null };
    const query = raw.trim().slice(0, 200);
    if (!query) return none;
    // Android Auto submits every edited prefix, not only Enter. Drop a query only when a longer
    // query extends it (still typing) — never when the car runs a genuinely different search in
    // parallel. Superseded calls resolve empty so the car never waits indefinitely.
    // Android Auto backgrounds the phone Activity: its hidden WebView can suspend JS timers
    // indefinitely. The native car request already has bounded pending work and a deadline,
    // so never make that request depend on a page-side setTimeout. The plain page entry point
    // still debounces typed prefixes while it is foregrounded.
    if (opts.mode === undefined) {
      this.latest = query;
      await new Promise(resolve => setTimeout(resolve, 350));
      if (this.latest !== query && this.latest.startsWith(query)) return none;
    }
    // Titles, lyrics and albums are asked together; a lyrics or album failure never hides the title matches.
    // RESULT-ARTIST-001: an artist search wants the artist's songs, not songs quoting their name.
    // CAR-AUX-BOUND-001: lyrics and album bodies are bounded, except where they ARE the answer.
    // CAR-LYRICS-TRUTH-001: in Lyrics mode the lyric answer IS the answer, so a lookup that could not run
    // (no connection, the daily transfer allowance used up) is reported with its reason, not as "none".
    let lyricFailure: string | null = null;
    const asked = this.lyrics && opts.mode !== 'artists'
      ? this.lyrics(query).then(r => r.results, (e: unknown) => { lyricFailure = e instanceof Error ? e.message : String(e); return [] as Track[]; })
      : Promise.resolve([] as Track[]);
    const words = opts.mode === 'lyrics' ? asked : within(asked, CAR_AUX_MS, [] as Track[]);
    const wantAlbums = opts.mode === undefined || opts.mode === 'all' || opts.mode === 'albums';
    const found = this.albums && this.openAlbum && wantAlbums
      ? this.albums(query).then(r => r.albums.filter(a => a.kind !== 'single').slice(0, CAR_ALBUMS), () => [])
      : Promise.resolve([]);
    const opened = found.then(list => Promise.all(list.map(a => this.openAlbum!(a.id).then(r => r.album, () => null))));
    const bodiesIn = opts.mode === 'albums' ? opened : within(opened, CAR_AUX_MS, [] as Awaited<typeof opened>);
    const [result, byWords, bodies] = await Promise.all([this.lookup(query), words, bodiesIn]);
    const albums: NativeAlbum[] = [];
    for (const a of bodies) {
      if (!a || !a.tracks.length) continue;
      this.albumTracks.delete(a.id);
      this.albumTracks.set(a.id, a.tracks);
      albums.push({
        id: a.id, title: a.title, artist: a.artist, artwork: a.artwork,
        songs: a.tracks.slice(0, CAR_ALBUM_SONGS).map(t => ({ ...songFromTrack(t, this.ready(t)), id: carAlbumTrackId(a.id, t.key) })),
      });
    }
    while (this.albumTracks.size > 20) this.albumTracks.delete(this.albumTracks.keys().next().value!);
    const states = Object.values(result.sources ?? {});
    if (!result.results.length && !byWords.length && !albums.length && states.length && !states.some(s => s.state === 'ok')) {
      throw new Error('Music search is unavailable. Check your connection and try again.');
    }
    if (opts.mode === 'lyrics' && !byWords.length && lyricFailure) throw new Error(String(lyricFailure).slice(0, 200));
    const lyricKeys = new Set(byWords.map(t => t.key));
    // A lyrics search lists the lyric matches first, so they are not cut off by the title matches.
    // An artist search lists the artist's own songs first, for the same reason.
    const byArtist = opts.mode === 'artists' ? result.results.filter(t => isByArtist(t, query)) : [];
    const ordered = opts.mode === 'lyrics' ? [...byWords, ...result.results] : [...byArtist, ...result.results, ...byWords];
    const rows = [...new Map(ordered.filter(t => t.key && t.title).map(t => [t.key, t])).values()].slice(0, 25);
    for (const track of rows) {
      this.tracks.delete(track.key);
      this.tracks.set(track.key, track);
    }
    while (this.tracks.size > 200) this.tracks.delete(this.tracks.keys().next().value!);
    this.rememberList(rows);
    // A voice request for the album, or words that name it, plays the album from its first song.
    const lead = albums[0];
    const play = lead && (opts.album || namesAlbum(query, lead.title)) ? lead.songs[0]?.id ?? null : null;
    return { songs: rows.map(t => ({ ...songFromTrack(t, this.ready(t)), kinds: carKinds(t, lyricKeys.has(t.key), query) })), albums, play };
  }

  /**
   * CAR-SEARCH-TYPES-001: the car's Identify icon. The phone recorded the music playing; fingerprint
   * it as the phone's own mic search does and name it. The songs found are kept so tapping one in the
   * car plays it. A clip too quiet to fingerprint names nothing rather than guessing.
   */
  async identifyClip(samples: Float32Array): Promise<NativeSong[]> {
    if (!this.identify || !this.fingerprint) throw new Error('Identify is not available.');
    const L = await this.fingerprint();
    if (samples.length < 3 * L.SAMPLE_RATE) throw new Error('The clip was too short to identify.');
    const sig = await L.makeSignature(L.pickWindow(samples));
    if (L.peakCount(sig as never) < 20) return [];
    const r = await this.identify(L.signatureUri(sig as never), L.signatureMillis(sig as never));
    const rows = r.results.filter(t => t.key && t.title).slice(0, 10);
    for (const track of rows) {
      this.tracks.delete(track.key);
      this.tracks.set(track.key, track);
    }
    while (this.tracks.size > 200) this.tracks.delete(this.tracks.keys().next().value!);
    return rows.map(t => ({ ...songFromTrack(t, this.ready(t)), kinds: carKinds(t) }));
  }
}
