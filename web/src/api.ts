/**
 * Typed client for the discovery sidecar (../server/airwave_discovery/app.py). Shapes mirror what the
 * server returns today; optional fields are the ones the server omits when a provider does not know them.
 */

export type ProviderId = 'deezer' | 'ytmusic' | 'soundcloud' | 'spotify' | 'apple' | 'bandcamp' | 'audius' | 'hearthis' | 'archive';

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

export interface Characteristics {
  bpm: number | null;
  genres: string[];
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
  recent: { ts: number; kind: string; key: string; title: string; artist: string; listened: number | null }[];
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
  /** User-selected private audio queue cache capacity in GiB (0.25–20). Kept downloads are separate. */
  cache_gb?: number;
  /** 0 = let the shell pick its own safe default (a phone's ceiling is lower than a desktop's). */
  dl_parallel?: number;
  preload_target?: 'all' | 'count';
  preload_count?: number;
  /** Replenish a nearly played-through list after a completed song. */
  discover_while_listening?: boolean;
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
}

/** One song inside a saved list. `track` is null when the engine never recorded it. */
export interface PlaylistItem {
  key: string;
  added: number;
  track: Track | null;
  played: boolean;
}

/** A list the listener made. `discovery_ready` is false until every song in it has been played. */
export interface PlaylistSummary {
  id: string;
  name: string;
  created: number;
  count: number;
  unplayed: number;
  discovery_ready: boolean;
  items: PlaylistItem[];
}

export type PlaylistAction = 'create' | 'rename' | 'delete' | 'add' | 'remove' | 'set';

export type FeedbackKind = 'like' | 'dislike' | 'hide' | 'save' | 'replay' | 'complete' | 'skip' | 'unlike' | 'unsave' | 'undislike' | 'unhide';

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
      const local = await (await import('./engine/runtime')).startLocal();
      const r = await local.handle(init.method ?? 'GET', path, init.body ? JSON.parse(String(init.body)) : null);
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
  search: (q: string, signal?: AbortSignal) =>
    call<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&sources=ytmusic,deezer,soundcloud,apple,spotify`, signal ? { signal } : {}),
  searchLyrics: (q: string, signal?: AbortSignal) => call<IdentifyResponse>(`/api/search/lyrics?q=${encodeURIComponent(q)}`, signal ? { signal } : {}),
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
  seeds: () => call<{ seeds: Track[] }>('/api/seeds'),
  putSeeds: (seeds: Track[]) => call<{ seeds: Track[] }>('/api/seeds', { method: 'PUT', body: json({ seeds }) }),
  settings: () => call<Settings>('/api/settings'),
  putSettings: (patch: Partial<Settings>) => call<Settings>('/api/settings', { method: 'PUT', body: json(patch) }),
  recommend: (listening?: { event_id: string; exclude: string[]; list_id?: string }) =>
    call<{ job: string | null; reason?: string }>('/api/recommend', { method: 'POST', body: json(listening ? { trigger: 'listening', ...listening } : {}) }),
  job: (id: string, signal?: AbortSignal) => call<JobStatus>(`/api/jobs/${id}`, signal ? { signal } : {}),
  cancelJob: (id: string) => call<{ ok: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' }),
  feedback: (kind: FeedbackKind, track: Track, extra: { event_id?: string; listened?: number; duration?: number; coverage?: number; medium?: string; session?: string; origin?: string; confidence?: number } = {}) =>
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
    call<{ embedded: boolean; already: boolean; source: string; segments: number | null; seconds: number | null }>('/api/embed-local', {
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
  playlists: () => call<{ lists: PlaylistSummary[] }>('/api/playlists'),
  /** Every list edit goes through one call and answers with the lists as they now stand. */
  playlistEdit: (action: PlaylistAction, opts: { ids?: string[]; id?: string; name?: string; key?: string } = {}) =>
    call<{ lists: PlaylistSummary[] }>('/api/playlists', { method: 'POST', body: json({ action, ...opts }) }),
  health: (refresh = false) => call<Health>(`/api/health${refresh ? '?refresh=1' : ''}`),
  status: () => call<Status>('/api/status'),
  reset: (clearCache: boolean) => call<{ ok: boolean }>('/api/reset', { method: 'POST', body: json({ clear_cache: clearCache }) }),
  resetTaste: () => call<{ ok: boolean }>('/api/reset/taste', { method: 'POST', body: json({}) }),
  clearQueue: () => call<{ ok: boolean }>('/api/queue/clear', { method: 'POST', body: json({}) }),
  modelInstall: () => call<{ installed: boolean; downloaded: number }>('/api/model/install', { method: 'POST', body: '{}' }),
  modelSelftest: () => call<CapabilityState & { cosine?: number }>('/api/model/selftest', { method: 'POST', body: '{}' }),
  sample: () => call<RecResult>('/api/sample'),
  last: () => call<RecResult>('/api/last'),
  rerank: (exclude: string[]) => call<RerankResult>('/api/rerank', { method: 'POST', body: json({ exclude }) }),
  profile: () => call<Profile>('/api/profile'),
};

export function newEventId(kind: string, key: string): string {
  const r = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${key.slice(0, 40)}:${r}`.slice(0, 80);
}
