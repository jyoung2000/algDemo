/**
 * Typed client for the discovery sidecar (../server/airwave_discovery/app.py). Shapes mirror what the
 * server returns today; optional fields are the ones the server omits when a provider does not know them.
 */
import { ListCache, type Held, type WireReply } from './engine/playlist-delta';

export type ProviderId = 'deezer' | 'ytmusic' | 'soundcloud' | 'spotify' | 'apple' | 'bandcamp' | 'audius' | 'hearthis' | 'archive' | 'radio';

export interface Release {
  date: string;
  precision: 'day' | 'month' | 'year';
  kind: string;
  source: string;
}

export interface Tag {
  name: string;
  label: string;
  source: string;
  scope: 'track' | 'album' | 'artist';
  confidence: number;
  inferred: boolean;
}

export interface Track {
  /** Live programme bookmark, not an on-demand recording. */
  radio_station?: import('./engine/radio').RadioStation;
  id: string;
  provider: ProviderId;
  platform_id: string;
  key: string;
  title: string;
  artists?: string[];
  artist?: string;
  album?: string;
  version?: string;
  versions?: string[];
  duration?: number;
  artwork?: string;
  url?: string;
  isrc?: string;
  release?: Release;
  tags?: Tag[];
  /** GENRE-ALL-001: a starting song arrives with its genres worked out, like a queue row. */
  characteristics?: Characteristics;
  preview?: string;
  explicit?: boolean;
  bpm?: number;
  kind?: string;
  warning?: string;
  incomplete?: boolean;
  embed_url?: string;
  also_on?: { provider: ProviderId; url: string; id: string }[];
  emphasis?: number;
  /** Why an identified song (lyrics or audio search) is in the results. */
  evidence?: Evidence;
}

export type Evidence =
  | { kind: 'lyrics'; snippet: string; ranges: [number, number][] }
  | { kind: 'audio'; offset?: number | null };

export interface IdentifyResponse extends SearchResponse {
  mode: 'lyrics' | 'audio';
  query: string;
  /** Songs the lyrics/audio service named; `unplayable` of them had no match on a service Airwave plays from. */
  named: number;
  unplayable: number;
  heard?: { title: string; artist: string };
}

export interface SourceState {
  state: 'ok' | 'failed' | 'budget' | 'skipped' | string;
  count?: number | null;
  ms?: number;
  detail?: string;
}

export interface SearchResponse {
  results: Track[];
  sources: Record<string, SourceState>;
  ms: number;
  bytes: number;
}

/**
 * ALBUM-SEARCH-001 / ALBUM-SEARCH-002: an album found by a search, from Deezer (`dz:`), Apple Music
 * (`ap:`), YouTube Music (`yt:`) or SoundCloud (`sc:`).
 */
export interface AlbumSummary {
  id: string;
  provider: 'deezer' | 'apple' | 'ytmusic' | 'soundcloud' | 'bandcamp';
  title: string;
  artist: string;
  artwork: string | null;
  year: string | null;
  kind: 'album' | 'ep' | 'mixtape' | 'compilation' | 'single';
  count: number | null;
  url: string;
  /** False for a SoundCloud set uploaded by someone other than the artist. */
  official?: boolean;
}

/** ALBUM-OPEN-001: a whole album, its songs in album order. */
export interface AlbumView extends AlbumSummary {
  tracks: Track[];
  duration: number | null;
  genres: string[];
  /** ALBUM-SOUND-001: the album's own listening mix, for the Sound card on its page. */
  mix?: AlbumMix;
}

/** ARTIST-PAGE-001: `dz:<deezer id>` or `yt:<UC channel id>`; a name alone is looked up exactly. */
export type ArtistTarget = { id?: string; name?: string; refresh?: boolean; refreshToken?: string };

export interface ArtistSummary {
  id: string;
  provider: 'deezer' | 'ytmusic';
  name: string;
  picture: string | null;
  detail: string | null;
  /** Deezer's follower count when it gives one (ARTIST-SIZE-001 / ARTIST-FAV-001). */
  fans?: number | null;
  url: string;
  alt?: string;
}

/**
 * What one platform did for an artist page. ARTIST-ALL-SOURCES-001 adds `checked` (how many uploads
 * or releases its page holds, new to the page or not) and `note` (an account the platform does not
 * vouch for, read because its uploads are this artist's).
 */
export interface ArtistSourceState {
  state: 'ok' | 'none' | 'failed';
  count?: number;
  detail?: string;
  why?: 'allowance' | 'offline' | 'busy' | 'refused' | 'failed';
  gave?: ('picture' | 'audience')[];
  checked?: number;
  note?: 'unverified';
}

/** ARTIST-ALL-SOURCES-001: what SoundCloud, Apple Music, Bandcamp and Audius add to an artist page. */
export interface ArtistExtras {
  songs: Track[];
  albums: AlbumSummary[];
  singles: AlbumSummary[];
  sources: Record<string, ArtistSourceState>;
}

export interface ArtistView {
  id: string;
  name: string;
  picture: string | null;
  detail: string | null;
  /** The most played songs. */
  songs: Track[];
  /** ARTIST-FEATURES-001: songs by other artists that this artist is on, most played first. */
  features: Track[];
  albums: AlbumSummary[];
  singles: AlbumSummary[];
  links: { deezer?: string; ytmusic?: string };
  /** ARTIST-SOURCES-001: what each service did; `why` when its page was not read, `gave` for the picture and audience. */
  sources: Record<string, ArtistSourceState>;
  /** ARTIST-FALLBACK-001: no service had a page for this name; the songs are the ones held here. */
  local?: boolean;
  /** ARTIST-CIRCLE-001: Deezer's related artists and YouTube Music's "Fans might also like", merged. */
  similar?: import('./engine/artist-circle').SimilarArtist[];
}

export interface AlbumSearchResponse {
  query: string;
  albums: AlbumSummary[];
  sources: Record<string, SourceState>;
}

export type ResolveResponse =
  | { kind: 'track'; track: Track; ms: number; warning?: string }
  | { kind: 'choice'; choice: 'playlist' | 'artist' | string; message: string; track?: Track; tracks: Track[]; title?: string; count?: number; bounded?: number }
  | { kind: 'error'; error: string; message: string };

export interface Reason {
  factor: string;
  text: string;
  weight: number;
}

export interface Playback {
  open: { provider: ProviderId; label: string; url: string }[];
  preview: string | null;
  embed: { provider: 'ytmusic' | 'soundcloud'; url: string } | null;
}

/** GENRE-ALL-001: something a row lacked of "a main genre and a subgenre", filled in by the engine. */
export interface GenreFill {
  label: string;
  sub: boolean;
  /** An estimate, not a fact and not a service's word: drawn as one. */
  guess: boolean;
  /** Where it came from, e.g. "Released in 1982" or "Most songs in this list". */
  why: string;
}

export interface Characteristics {
  bpm: number | null;
  genres: string[];
  /** GENRE-ALL-001: subgenre words the services use that the Taste Picker has no cell for ("Sophisti-pop"). */
  styles?: string[];
  /** GENRE-ALL-001: what the engine filled in so the row has a main genre and a subgenre. */
  fill?: GenreFill[];
  /** GENRE-ALL-001: the song's only main genre is one the picker has no place for ("Asian music"). */
  main_off?: string;
  /** GENRE-ALL-001: a lookup can still improve this row's genres. */
  genre_pending?: boolean;
  explicit: boolean | null;
  duration: number | null;
  release_year: string | null;
  popularity: number | null;
  /** 0..1: how well the song fits what you have listened to; null before any listening. */
  taste_fit: number | null;
  /** Taste Picker family and subgenre from the song's tags and tempo; null when neither is known. */
  family?: string | null;
  subgenre?: string | null;
  /**
   * Every family and subgenre the song's tags name, strongest first (TAGS-MULTI-001). A song is not
   * one genre: `family`/`subgenre` above are the first of these, and the card shows them all.
   */
  families?: { family: string; subgenre: string | null; color: string }[];
  tempo_fit?: number | null;
  color?: string | null;
  /** True when the genre was inferred (artist history, sound, or the seed), not sent by a provider. */
  genre_inferred?: boolean | null;
  /** Where the leading genre came from, e.g. 'Deezer album genre' or 'Songs that sound the same'. */
  genre_source?: string | null;
}

export interface TasteGenre {
  name: string;
  label: string;
  score: number;
  plays?: number;
  skips?: number;
}

/** What the engine has learned from listening so far (null until the first finished or skipped song). */
export interface TasteSummary {
  events: number;
  positives: number;
  negatives: number;
  bpm: number | null;
  skip_bpm: number | null;
  likes: TasteGenre[];
  avoids: TasteGenre[];
  /** Every genre with a meaningful score, strongest first (absent from older servers). */
  genres?: TasteGenre[];
}

/** MOOD-QUEUE-001: the engine's answer to /api/mood. */
export interface MoodAnswer {
  order: string[];
  changed: boolean;
  moved: string[];
  gain?: number;
  leading: string[];
  confidence: number;
  off?: boolean;
  /** MOOD-SHUFFLE-001: song key -> 0..1 fit to the mood, for the shuffle's weighted pick. */
  fit?: Record<string, number>;
}

export interface RecItem {
  rank: number;
  track: Track;
  score: number;
  coverage: number;
  tier: 'strong' | 'related' | 'emerging' | 'experimental';
  evidence: 'strong' | 'moderate' | 'thin';
  best_seed: { key: string; title: string; artist: string } | null;
  reasons: Reason[];
  uncertainty: string[];
  new_release: boolean;
  factors: Record<string, number | null>;
  weights: Record<string, number>;
  sources: string[];
  playback: Playback;
  characteristics?: Characteristics;
  /** QUEUE-ADD-001: the listener added this song to the queue themselves. */
  added?: boolean;
}

export interface AudioStats {
  embedded?: number;
  cached?: number;
  failed?: number;
  compared?: number;
  budget_stops?: number;
  skipped?: string;
  stopped?: string;
  ms?: number;
  infer_ms?: number;
}

export interface RecResult {
  /** 'gathering' is the provisional first wave, shown while the remaining sources load. */
  phase: 'gathering' | 'metadata' | 'final';
  items: RecItem[];
  count: number;
  asked: number;
  fresh?: boolean;
  sources: Record<string, SourceState>;
  audio: AudioStats;
  timings: Record<string, number>;
  transfer: Record<string, number>;
  candidates?: number;
  empty_reason?: string;
  /** NEXT-FAV-COLD-001: for a run with no starting song, which of stars / listening / sound it read. */
  started_from?: string;
  sample?: { label: string; recorded: string };
  /** Set on the last finished queue restored from the server after a reload. */
  saved_at?: number;
  /** The accepted additions in this batch, not the total list length or raw provider candidates. */
  discovery?: { added: number; limit: number; trigger: 'search' | 'listening' };
}

/** The live re-rank of the last run's song pool after a skip or a full listen. */
export interface RerankResult extends RecResult {
  taste: TasteSummary | null;
  pool: number;
}

/** GET /api/profile: what the recommender tracks, what it learned, and how it is set to use it. */
export interface Profile {
  tracked: {
    events: number;
    counts: Record<string, number>;
    plays: number;
    listened_sec: number;
    songs_played: number;
    /** Songs heard on a radio station that were identified and counted (RADIO-TASTE-001). */
    radio_listens: number;
    artists: number;
    first: number | null;
    last: number | null;
    impressions: { shown: number; songs: number; window_days: number };
    vectors: number;
  };
  seeds: { key: string; title: string; artist: string; bpm: number | null; genres: string[]; emphasis: number }[];
  taste: {
    events: number;
    positives: number;
    negatives: number;
    bpm: number | null;
    bpm_evidence: number;
    bpm_used: boolean;
    skip_bpm: number | null;
    genres: { name: string; label: string; score: number; plays: number; skips: number }[];
  };
  artists: { name: string; score: number; liked: boolean }[];
  /** ALBUM-TASTE-001: albums the listener keeps playing (or skips through). */
  albums?: { key: string; name: string; artist: string; score: number }[];
  songs: { key: string; title: string; artist: string; score: number; excluded: boolean; hidden: boolean }[];
  excluded: number;
  hidden: number;
  algorithm: {
    settings: { adventurous: number; fresh: boolean; queue_size: number; audio: boolean };
    weights: { factor: string; base: number; effective: number; share: number }[];
    tiers: Record<string, number>;
    feedback_weights: Record<string, number>;
    taste_weights: Record<string, number>;
    limits: Record<string, number>;
  };
  last_run: {
    at: number | null;
    songs: number;
    asked: number | null;
    candidates: number | null;
    pool: number | null;
    tiers: Record<string, number>;
    evidence: Record<string, number>;
    factors: { factor: string; mean: number; known: number; of: number }[];
    score: { top: number; median: number; low: number } | null;
    sources: { name: string; state: string; count: number | null; detail: string | null }[];
    audio: AudioStats;
    timings: Record<string, number>;
    transfer: Record<string, number>;
  } | null;
  recent: { ts: number; kind: string; key: string; title: string; artist: string; listened: number | null; radio?: boolean }[];
  /** The last songs played (complete, replay or skip), newest first, with the tempo and genres taste used. */
  played: {
    ts: number;
    kind: string;
    key: string;
    title: string;
    artist: string;
    artwork: string | null;
    bpm: number | null;
    genres: string[];
    genre_names: string[];
    listened: number | null;
    /** Heard on a radio station. */
    radio?: boolean;
  }[];
  /** The scoring formula, as the numbers the engine currently uses. */
  formula: {
    affinity: {
      best_seed_share: number;
      factors: { factor: string; weight: number }[];
      global: { factor: string; weight: number }[];
    };
    taste: { weight: number; half_life_days: number; event_weights: Record<string, number> };
    coverage: { floor: number };
    genre_provider_overlap: number;
    exposure: { per_show: number; max: number; window_days: number };
    selection: { queue_size: number; max_per_artist: number; tier_shares: Record<string, number> };
    feedback_decay_days: number;
  };
  generated: number;
}

export interface JobStatus {
  job: string;
  phase: string;
  progress: string;
  done: boolean;
  error: string | null;
  result: RecResult | null;
  elapsed_ms: number;
  sources: Record<string, SourceState>;
}

export interface Settings {
  fresh: boolean;
  adventurous: number;
  audio: boolean;
  daily_mb: number;
  request_mb: number;
  sample_mode: boolean;
  /** How many new songs one discovery run adds to the list. */
  queue_size?: number;
  /** Minimum calibrated DCLAP sound match (percent) for Find similar, 40–95. */
  similar_percent?: number;
  /** User-selected private audio queue cache capacity in GiB (0.25–20). Kept downloads are separate. */
  cache_gb?: number;
  /** 0 = let the shell pick its own safe default (a phone's ceiling is lower than a desktop's). */
  dl_parallel?: number;
  preload_target?: 'all' | 'count';
  preload_count?: number;
  /** Replenish a nearly played-through list after a completed song. */
  discover_while_listening?: boolean;
  /** MOOD-QUEUE-001: the now playing queue follows the listening mood (default on). */
  mood_queue?: boolean;
  /**
   * The ten-band equaliser (EQ-001), stored as the engine's own config shape. Previews only: see
   * `engine/audio-bus.ts` for why iframe playback can never be filtered.
   */
  eq?: { on: boolean; presetId: string; gains: number[]; preampDb: number; limiter: boolean };
  /** The single mixing slider, 0 (off) to 100 (long and creative). MIXER-001. */
  mix?: number;
  /**
   * Download full songs (bundled yt-dlp, to the Music folder) so the decks can play them and the
   * equaliser and crossfader reach them. LOCAL-AUDIO-001. Without it, full songs play in
   * YouTube's player, which the engine cannot touch.
   */
  local_mix?: boolean;
  /** "Play before blending": percent of each song that plays before the crossfader starts, 50..100. Default 95. */
  play_through?: number;
  /** The improved (v2) ranking engine; false falls back to the original scorer. */
  rank_v2?: boolean;
  /** Bounded maths expression for discovery scores. Null restores the built-in algorithm. */
  ranking_formula?: string | null;
}

export interface CapabilityState {
  state: 'working' | 'degraded' | 'unavailable' | 'unsupported' | 'not_tested' | string;
  detail?: string;
}

export interface Health {
  providers: Record<string, Record<string, CapabilityState>>;
  audio: {
    model: string;
    preprocess: string;
    dim: number;
    installed: boolean;
    download_bytes: number;
    source: string;
    license: string;
    check: CapabilityState & { cosine?: number; infer_ms?: number; ms?: number };
    vectors: number;
  };
  checked_at?: number;
  /** ALLOWANCE-REFRESH-001: present when this read also cleared the day's download allowance. */
  allowance_refreshed?: { cleared_bytes: number; day: string; /** ALLOWANCE-ARCH-001: bytes of background allowance given back. */ restored_bytes?: number };
}

/**
 * ALLOWANCE-ARCH-001: only background work (queue top-ups, genre and album look-ups) draws on the allowance, and only
 * on a metered connection. It refills through the day; what the listener asks for and playback are never limited.
 */
export interface Allowance {
  capacity: number;
  level: number;
  refill_per_hour: number;
  /** True off mobile data: nothing is limited. */
  unmetered: boolean;
  paused: boolean;
  /** Unix seconds when paused background work resumes by itself. */
  resumes_at: number | null;
  /** Bytes read today by lane: interactive, playback, background (and `other` from older versions). */
  today: Record<string, number>;
}

export interface Status {
  storage: {
    areas: Record<string, number>;
    /** The shell's private queue-audio cache against its size limit; null in a plain browser. */
    queue_audio: { bytes: number; limit: number } | null;
    /** This origin's own data (IndexedDB, caches) — what `navigator.storage.estimate()` sees. */
    app_data: number;
    limits: Record<string, number>;
    total: number;
    hard_cap: number;
    target: number;
    free_disk: number;
    not_counted: string;
  };
  /** ALLOWANCE-ARCH-001: the mobile data allowance for background work. Absent on an older engine. */
  allowance?: Allowance;
  transfer_today: Record<string, number>;
  transfer_daily_cap: number;
  transfer_request_cap: number;
  transfer_note: string;
  cache: { hits: number; misses: number; bytes: number; vectors: number };
  startup_ms: number;
  memory: { rss: number | null; peak: number | null };
  telemetry: string;
}

export interface SavedItem {
  track: Track;
  kind: 'like' | 'save';
  ts: number;
  /** TAGS-ALWAYS-001: genres worked out as for a Discover row (absent from an older engine). */
  characteristics?: Characteristics;
}

/** One song inside a saved list. `track` is null when the engine never recorded it. */
export interface PlaylistItem {
  key: string;
  added: number;
  track: Track | null;
  played: boolean;
}

/** A list the listener made. `discovery_ready` is false until every song in it has been played. */
/** The starting songs, and the saved list they came from when one is the now playing queue. */
/** ARTIST-FAV-001: a starred artist (engine/fav-artists.ts). */
export interface FavArtist {
  name: string;
  deezerId: string | null;
  fans: number | null;
  picture: string | null;
  pageId: string | null;
  addedAt: number;
}

export interface FavArtistsView {
  artists: FavArtist[];
  algorithm?: { id: string; name: string };
}

export interface SeedsView {
  seeds: Track[];
  playlist?: { id: string; name: string } | null;
  can_restore?: boolean;
}

/** ALBUM-SOUND-001: an album's own mix - the same shape a saved list has, minus the list itself. */
export interface AlbumMix {
  taste: TasteSummary | null;
  /** Songs on the album the engine could read; `placed` of them have a genre. */
  songs: number;
  placed: number;
}

export interface PlaylistMix {
  id: string;
  name: string;
  taste: TasteSummary | null;
  /** Songs in the list the engine could read; `placed` of them have a genre. */
  songs: number;
  placed: number;
}

/** ALBUM-SAVE-001: the album a saved album came from. */
export interface AlbumRef {
  id: string;
  provider: string;
  artist: string;
  artwork: string | null;
  year: string | null;
  kind: string;
  url: string;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  created: number;
  count: number;
  unplayed: number;
  discovery_ready: boolean;
  items: PlaylistItem[];
  /** Set on a saved album (ALBUM-SAVE-001); a list the listener made has none. */
  album?: AlbumRef | null;
}

export type PlaylistAction = 'create' | 'rename' | 'delete' | 'add' | 'remove' | 'set' | 'save_album';

export type FeedbackKind = 'qualified' | 'like' | 'dislike' | 'hide' | 'save' | 'replay' | 'complete' | 'skip' | 'unlike' | 'unsave' | 'undislike' | 'unhide';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

// The Android shell injects AirwaveNative; ?local=1 runs the same engine in a desktop browser for testing.
const listCache = new ListCache();
const readLists = (have: Held) => call<WireReply>(`/api/playlists?have=${encodeURIComponent(JSON.stringify(have))}`);
/** For tests: forget the lists this page holds. */
export const resetListCacheForTest = (): void => listCache.clear();

const inApp = (): boolean => typeof window !== 'undefined' && (Boolean((window as { AirwaveNative?: unknown }).AirwaveNative) || new URLSearchParams(window.location.search).has('local'));

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let status: number;
  let text: string;
  if (inApp()) {
    // Android: the engine runs in this page, no server involved.
    if (path === '/api/sample') {
      status = 200;
      text = JSON.stringify((await import('../../server/airwave_discovery/sample_data.json')).default);
    } else {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      // SERVICE-API-001: when the playback service owns the engine, ask it; never open a second one here.
      const { serviceClient, switchToLocal, ServiceError } = await import('./engine/service-client');
      const client = serviceClient();
      let r: { status: number; body: unknown; local?: unknown } | null = null;
      if (client) {
        try {
          r = await client.request(init.method ?? 'GET', path, body, init.signal);
        } catch (e) {
          if (e instanceof ServiceError && e.reason === 'aborted') throw new DOMException('The request was cancelled.', 'AbortError');
          throw new ApiError(e instanceof Error ? e.message : String(e), 503, null);
        }
        // The service engine never opened the original database: this page may, once it has claimed it.
        if (r.local === true && switchToLocal()) r = null;
      }
      if (!r) {
        r = await (await (await import('./engine/runtime')).startLocal()).handle(init.method ?? 'GET', path, body);
      }
      status = r.status;
      text = JSON.stringify(r.body);
    }
  } else {
    const res = await fetch(path, {
      ...init,
      headers: init.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : init.headers,
    });
    status = res.status;
    text = await res.text();
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (status < 200 || status >= 300) {
    const b = body as { message?: string; detail?: string } | null;
    throw new ApiError(b?.message ?? b?.detail ?? `HTTP ${status}`, status, body);
  }
  return body as T;
}

const json = (v: unknown) => JSON.stringify(v);

export const api = {
  /**
   * SERVICE-API-001: the exact list the service engine offered a car song in (a car search answer,
   * an album, a saved list), with its original Tracks. 404 when it offered no such song (and always
   * where no service engine exists).
   */
  carContext: (id: string) =>
    call<{ tracks: Track[]; ids: string[]; index: number }>('/_native/context', { method: 'POST', body: json({ id }) }),
  /** SRC-AUTO-001: `sources` asks only those (the ones that went out); every source by default. */
  search: (q: string, signal?: AbortSignal, sources: readonly string[] = ['ytmusic', 'deezer', 'soundcloud', 'apple', 'spotify']) =>
    call<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&sources=${sources.join(',')}`, signal ? { signal } : {}),
  searchLyrics: (q: string, signal?: AbortSignal) => call<IdentifyResponse>(`/api/search/lyrics?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),
  searchAlbums: (q: string, signal?: AbortSignal) => call<AlbumSearchResponse>(`/api/search/albums?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),
  /** ARTIST-PAGE-001: artists named by a search; an artist's page; every song on their albums and singles. */
  searchArtists: (q: string, signal?: AbortSignal) => call<{ query: string; artists: ArtistSummary[]; why?: 'allowance' | 'offline' | 'busy' | 'refused' | 'failed' }>(`/api/search/artists?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),
  artist: (target: ArtistTarget, signal?: AbortSignal) =>
    call<{ artist: ArtistView }>('/api/artist', { method: 'POST', body: json(target), ...(signal ? { signal } : {}) }),
  artistSongs: (target: ArtistTarget, signal?: AbortSignal) =>
    call<{ songs: Track[]; features?: Track[]; opened: number; failed: number; featuresComplete?: boolean }>('/api/artist/songs', { method: 'POST', body: json(target), ...(signal ? { signal } : {}) }),
  /** FEATURES-ALL-001: the songs other artists have them on, asked for on their own so the song list never waits. */
  artistFeatures: (target: ArtistTarget, signal?: AbortSignal) =>
    call<{ features: Track[]; complete?: boolean; more?: boolean }>('/api/artist/features', { method: 'POST', body: json(target), ...(signal ? { signal } : {}) }),
  /** ARTIST-ALL-SOURCES-001: the other platforms' songs and records for this artist, asked once the page is up. */
  artistSources: (target: ArtistTarget, signal?: AbortSignal) =>
    call<ArtistExtras>('/api/artist/sources', { method: 'POST', body: json(target), ...(signal ? { signal } : {}) }),
  /** `{ id }` opens that album; `{ track }` opens the album the song is on (404 `code: 'none'` when there is none). */
  album: (target: { id: string } | { track: Track }, signal?: AbortSignal) =>
    call<{ album: AlbumView }>('/api/album', { method: 'POST', body: json(target), ...(signal ? { signal } : {}) }),
  radioGenres: (track: Track) => call<{ track: Track; characteristics: Characteristics }>('/api/radio/genres', { method: 'POST', body: json({ track }) }),
  radioAnalyse: (track: Track, sessionId: string) => call<{ embedded: boolean; bpm: number | null; note?: string }>('/api/radio/analyse', { method: 'POST', body: json({ track, sessionId }) }),
  identifyAudio: (signature: string, ms: number, signal?: AbortSignal) =>
    call<IdentifyResponse>('/api/identify/audio', { method: 'POST', body: json({ signature, ms }), ...(signal ? { signal } : {}) }),
  resolve: async (url: string, signal?: AbortSignal): Promise<ResolveResponse> => {
    try {
      return await call<ResolveResponse>('/api/resolve', { method: 'POST', body: json({ url }), ...(signal ? { signal } : {}) });
    } catch (e) {
      if (e instanceof ApiError && e.body && typeof e.body === 'object' && (e.body as { kind?: string }).kind === 'error') {
        return e.body as ResolveResponse;
      }
      throw e;
    }
  },
  completeSpotify: (title: string, artist: string) => call<{ tracks: Track[] }>('/api/complete-spotify', { method: 'POST', body: json({ title, artist }) }),
  seeds: () => call<SeedsView>('/api/seeds'),
/** ARTIST-FAV-ALGO-001: the active algorithm's starred artists, and which algorithm that is. */
  favArtists: () => call<FavArtistsView>('/api/fav-artists'),
  editFavArtists: (body: { op: 'add'; artist: { name: string; pageId?: string | null; fans?: number | null; picture?: string | null } } | { op: 'remove'; name: string } | { op: 'set'; artists: unknown[] }) =>
    call<FavArtistsView>('/api/fav-artists', { method: 'POST', body: json(body) }),
  /** PLAYLIST-QUEUE-001: a saved list takes the place of the now playing queue; every song becomes a starting song. */
  queuePlaylist: (id: string) => call<SeedsView & { missing: number }>('/api/queue/playlist', { method: 'POST', body: json({ id }) }),
  /** Bring back the queue a saved list replaced. */
  restoreQueue: () => call<SeedsView>('/api/queue/restore', { method: 'POST', body: json({}) }),
  /** PLAYLIST-MIX-001: a saved list's own listening mix, in the shape the Sound card draws. */
  playlistMix: (id: string) => call<PlaylistMix>(`/api/playlists/mix?id=${encodeURIComponent(id)}`),
  putSeeds: (seeds: Track[]) => call<{ seeds: Track[] }>('/api/seeds', { method: 'PUT', body: json({ seeds }) }),
  settings: () => call<Settings>('/api/settings'),
  putSettings: (patch: Partial<Settings>) => call<Settings>('/api/settings', { method: 'PUT', body: json(patch) }),
  recommend: (listening?: { event_id: string; exclude: string[]; list_id?: string }) =>
    call<{ job: string | null; reason?: string; mood?: string[] }>('/api/recommend', { method: 'POST', body: json(listening ? { trigger: 'listening', ...listening } : {}) }),
  similar: (track: Track) => call<{ job: string }>('/api/similar', { method: 'POST', body: json({ track }) }),
  /** NEXT-FAV-CUSTOM-001: Find my next favorite with chosen genres, artists, count, familiarity and era. */
  discoverCustom: (criteria: import('./engine/custom-discovery').CustomCriteria, exclude: string[]) =>
    call<{ job: string }>('/api/discover/custom', { method: 'POST', body: json({ criteria, exclude }) }),
  job: (id: string, signal?: AbortSignal) => call<JobStatus>(`/api/jobs/${id}`, signal ? { signal } : {}),
  cancelJob: (id: string) => call<{ ok: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' }),
  feedback: (kind: FeedbackKind, track: Track, extra: { event_id?: string; listened?: number; duration?: number; coverage?: number; medium?: string; session?: string; origin?: string; confidence?: number; /** RADIO-TASTE-001: the earlier, shorter report of this same radio listen. */ supersedes?: string } = {}) =>
    call<{ recorded?: boolean; duplicate?: boolean; removed?: number }>('/api/feedback', { method: 'POST', body: json({ kind, track, ...extra }) }),
  feedbackState: () => call<{ state: Record<string, Partial<Record<FeedbackKind, boolean>>>; events: number; taste?: TasteSummary | null }>('/api/feedback/state'),
  importHistory: (events: import('./engine/import').ImportedEvent[]) => call<{ recorded: number; duplicates: number; skipped: number }>('/api/import/history', { method: 'POST', body: json({ events }) }),
  impressions: (keys: string[]) => call<{ recorded: number }>('/api/impressions', { method: 'POST', body: json({ keys }) }),
  /** SOURCE-CHAIN-001: `url` carries a non-YouTube source (SoundCloud); `exclude` names links that failed. */
  fullSong: (track: Track, retry = false, exclude: readonly string[] = []) =>
    call<{ id: string | null; source: string; url?: string; note?: string }>('/api/full-song', { method: 'POST', body: json({ track, retry, ...(exclude.length ? { exclude } : {}) }) }),
  /**
   * Analyse the complete song the shell already holds, rather than Deezer's 30-second preview
   * (FULL-SONG-EMBED-001). Local disk only, so it costs no transfer allowance; a song already
   * analysed answers `embedded: false, already: true` instead of running again.
   */
  embedLocal: (track: Track, sourceUrl: string) =>
    call<{ embedded: boolean; already: boolean; skipped?: 'long' | 'large'; source: string | null; segments: number | null; seconds: number | null }>('/api/embed-local', {
      method: 'POST',
      body: json({ track, source_url: sourceUrl }),
    }),
  /**
   * A signed, playable address for a Deezer preview. The catalogue holds the stable route
   * (/api/preview/deezer/<id>) because Deezer's own URLs are signed for about fifteen minutes;
   * an <audio> element cannot play that route, so it is exchanged for a fresh URL at play time.
   */
  previewUrl: (route: string) => call<{ url: string }>(route.replace('/api/preview/', '/api/preview-url/')),
  saved: () => call<{ items: SavedItem[] }>('/api/saved'),
  /** TAGS-ALWAYS-001: genres for songs outside the engine's lists (search results); null where nothing is known. */
  genres: (tracks: Track[]) => call<{ items: Record<string, Characteristics | null>; pending?: string[] }>('/api/genres', { method: 'POST', body: json({ tracks }) }),
  // PLAYLIST-DELTA-001: the app's own engine is told which lists this page already holds and sends only the rest.
  playlists: () => (inApp() ? listCache.read(readLists) : call<{ lists: PlaylistSummary[] }>('/api/playlists')),
  /** Every list edit goes through one call and answers with the lists as they now stand. */
  playlistEdit: (action: PlaylistAction, opts: { ids?: string[]; id?: string; name?: string; key?: string; tracks?: Track[]; album?: AlbumView } = {}) =>
    (inApp()
      ? listCache.read((have) => call<WireReply>('/api/playlists', { method: 'POST', body: json({ action, ...opts, have }) }), readLists)
      : call<{ lists: PlaylistSummary[] }>('/api/playlists', { method: 'POST', body: json({ action, ...opts }) })),
  health: (refresh = false) => call<Health>(`/api/health${refresh ? '?refresh=1' : ''}`),
  status: () => call<Status>('/api/status'),
  reset: (clearCache: boolean) => call<{ ok: boolean }>('/api/reset', { method: 'POST', body: json({ clear_cache: clearCache }) }),
  resetTaste: () => call<{ ok: boolean }>('/api/reset/taste', { method: 'POST', body: json({}) }),
  clearQueue: () => call<{ ok: boolean }>('/api/queue/clear', { method: 'POST', body: json({}) }),
  /** QUEUE-ADD-001: put a row in the now playing queue after `after` (the song playing), or at the top. */
  queueAdd: (item: RecItem, after: string | null) => call<RecResult>('/api/queue/add', { method: 'POST', body: json({ item, after }) }),
  modelInstall: () => call<{ installed: boolean; downloaded: number }>('/api/model/install', { method: 'POST', body: '{}' }),
  modelSelftest: () => call<CapabilityState & { cosine?: number }>('/api/model/selftest', { method: 'POST', body: '{}' }),
  sample: () => call<RecResult>('/api/sample'),
  last: () => call<RecResult>('/api/last'),
  /** GENRE-LOAD-001: look up the genres of a few of the queue's rows that have none; `left` says how many remain. */
  queueGenres: () => call<{ items: { key: string; tags: Track['tags']; characteristics: Characteristics }[]; left: number; spent?: boolean; /** ALLOWANCE-ARCH-001: when paused look-ups resume by themselves (unix seconds). */ resumes_at?: number }>('/api/queue/genres', { method: 'POST', body: json({}) }),
  rerank: (exclude: string[]) => call<RerankResult>('/api/rerank', { method: 'POST', body: json({ exclude }) }),
  /** MOOD-QUEUE-001: the order the movable songs still to come should play in for the listening mood. */
  mood: (body: { upcoming: { track: Track; characteristics?: Characteristics | null }[]; score?: { track: Track; characteristics?: Characteristics | null }[]; shown?: string[]; current?: { track: Track; characteristics?: Characteristics | null }; signal?: { track: Track; kind: 'like' | 'dislike' | 'similar' | 'complete' | 'skip' } }) =>
    call<MoodAnswer>('/api/mood', { method: 'POST', body: json(body) }),
  profile: () => call<Profile>('/api/profile'),
};

export function newEventId(kind: string, key: string): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${key.slice(0, 40)}:${r}`.slice(0, 80);
}
