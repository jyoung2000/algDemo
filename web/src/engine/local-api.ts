/**
 * The app's own API (port of server/airwave_discovery/app.py), answered in-process so the Android APK
 * needs no server. `handle()` takes what the UI would have sent to /api/* and returns what the server
 * would have answered, status code included. Jobs run as async tasks; the browser polls them as before.
 */
import { applyAlgorithmPatch, engineFromSettings, settingsWithAlgorithms } from './algorithms';
import * as A from './audio';
import { isSimilarityPercent, selectSimilar, soundMatch, SIMILAR_DEFAULT, SIMILAR_FLOOR, SIMILAR_LIMIT, type SoundHit, type SoundTrack } from './similar-sound';
import { customOutcome, normaliseCriteria, runCustomDiscovery, songIdOf, type CandidateTrack, type CustomCriteria, type CustomPorts } from './custom-discovery';
import { genreIdentity } from './genre-identity';
import { MOOD, buildMood, moodFit, moodOrder, moodTags, type MoodCandidate, type MoodKind, type MoodSignal } from './mood-queue';
/** CAR-MOOD-001: the presses the car may send with a mood question. */
const CAR_MOOD_KINDS = new Set(['like', 'dislike', 'similar', 'complete', 'skip']);
import type { Track as NativeTrack } from './track';
import { DEFAULT_ENGINE, TRANSFER, engineWithWeights } from './config';
import { EQ_DEFAULTS, parseEq } from './eq';
import { PLAY_THROUGH_DEFAULT, clampPlayThrough, clampSlider } from './crossfade';
import { appendDiscovery, needsListeningDiscovery, newDiscoveryTracks } from './discovery';
import {
  PLAYLIST_TRACKS_MAX,
  PlaylistError,
  addToPlaylists,
  createPlaylist,
  deletePlaylist,
  parsePlaylists,
  playlistFullyPlayed,
  saveAlbum,
  playlistsHolding,
  removeFromPlaylists,
  renamePlaylist,
  unplayedCount,
  type Playlist,
} from './playlists';
import { Deezer, NeedsChoice, ProviderError, cached, type Ctx } from './deezer';
import * as E from './engine';
import { buildTaste, tasteSummary, tasteFit, type TasteProfile } from './taste';
import { type Colour } from './taste-gather';
import { buildTasteBlend, type TasteBlend } from './taste2';
import { ARTIST_SUBS_KEY, MUSICBRAINZ_UA, artistName, lookupArtistSubs, withArtistSubs, type ArtistSubsMap } from './artist-subs';
import { fold, matchRecordings } from './identity';
import { findFullSong, type FullSongResult } from './full-song-chain';

/**
 * How long "no source has this song" stands before the engine asks again (SOURCE-CHAIN-001).
 * It used to be six hours, which with a quiet library meant a missing song stayed missing for the
 * rest of the day. Uploads appear over time, so a miss is a snapshot, not a verdict.
 */
const NO_SOURCE_TTL = 15 * 60;
/** FOLDER-IMPORT-001: an imported song's file answer should outlive any listening session. */
const IMPORTED_SOURCE_TTL = 10 * 365 * 86400;

import { buildProfile } from './profile';
import { playlistMix } from './playlist-mix';
import { albumGenres, baseAlbumTitle, releaseGroupId, tagsFromReleaseGroup } from './album-genres';
import { seedWindow } from './seed-window';
import type { Tag } from './genres';
import { classify, classifyAll } from './classify';
import { makeTag } from './genres';
import { inferFromArtist, inferFromSeed, inferFromSound, needsSub, recordArtistGenres, withoutNamesake, currentTags } from './infer';
import { fillGenres, mainGenre, stylesFor, subLabels } from './genre-fill';
import { BlockedUrl, BudgetExceeded, Cancelled, FetchError, Http, type HttpPort, Meter } from './net';
import { dl, downloadsAvailable } from './downloads';
import { localAudioUrl } from './local-audio';
import { Job, Pipeline, pmap, type Embedder } from './pipeline';
import { SOURCE_LABELS, cleanTrack, playbackFor, round, type Dict } from './shape';
import { AppleMusic } from './apple';
import { Albums } from './albums';
import { ArtistNotOpened, Artists, partitionFeatures, type ArtistSource } from './artists';
import { ArtistExtrasReader } from './artist-extras';
import { albumKeyOf } from './album-key';
import { SoundCloud } from './soundcloud';
import { Bandcamp } from './bandcamp';
import { Audius } from './audius';
import { HearThis } from './hearthis';
import { InternetArchive } from './internet-archive';
import { Spotify, looksLikeUrl, normaliseUrl, providerForUrl } from './spotify';
import type { Store } from './store';
import { YouTubeMusic } from './ytmusic';
import { Genius, Shazam } from './listen/providers';
import { resolveHits, type Evidence } from './listen/identify';
import { canMatch, confidentMatch, enrichImported, statedTags, uniqueTags } from './imported-genres';

export interface LocalDeps {
  store: Store;
  port: HttpPort;
  /** Null when the audio model is not available; the engine then ranks on metadata alone. */
  encoder: Embedder | null;
  now?: () => number;
  /** Spotify search, only where a shell can run spotDL (Windows). Absent on Android, where Spotify search is unavailable. */
  /** Builds the Spotify search on this api's own Http client. Absent only in tests. */
  spotifySearch?: (http: Http) => (q: string, limit: number) => Promise<Dict[]>;
}

export interface LocalResponse {
  status: number;
  body: unknown;
}

/** What the listing shows about a song: its measured characteristics and how it fits the listening. */
export function characteristicsOf(c: Dict, taste: TasteProfile | null): Dict {
  // NAMESAKE-001: artist tags that belong to someone else with the same name are not this song's.
  let tags = currentTags(((c['tags'] as Tag[] | undefined) ?? [])) as unknown as Dict[];
  // Apple Music names one genre per song (`primaryGenreName`) and sends no tag list: use it as the song's tag.
  const named = (c['extra'] as Dict | undefined)?.['genre'];
  if (!tags.length && typeof named === 'string' && named) {
    const tag = makeTag(named, 'Apple Music genre', 'track', 0.7);
    if (tag) tags = [tag as unknown as Dict];
  }
  const seen = new Set<string>();
  const genres = [...tags]
    .sort((a, b) => Number(b['confidence'] ?? 0) - Number(a['confidence'] ?? 0))
    .map((g) => String(g['label'] ?? g['name']))
    .filter((l) => l && !seen.has(l) && (seen.add(l), true))
    .slice(0, 4);
  const tf = taste ? tasteFit({ tags: tags as never, bpm: (c['bpm'] as number) ?? null }, taste) : null;
  const bpmIn = typeof c['bpm'] === 'number' ? (c['bpm'] as number) : null;
  const cls = classify(tags as never, bpmIn);
  // Every genre the tags name, not only the strongest (TAGS-MULTI-001). `family`/`subgenre` stay
  // as the first of them, so a song's place on the taste map is unchanged.
  const all = classifyAll(tags as never, bpmIn);
  const lead = [...tags].sort((a, b) => Number(b['confidence'] ?? 0) - Number(a['confidence'] ?? 0))[0];
  return {
    family: cls?.family ?? null,
    subgenre: cls?.subgenre ?? null,
    families: all.map((c) => ({ family: c.family, subgenre: c.subgenre, color: c.color })),
    tempo_fit: cls?.tempoFit ?? null,
    color: cls?.color ?? null,
    genre_inferred: lead ? Boolean(lead['inferred']) : null,
    genre_source: lead ? String(lead['source'] ?? '') : null,
    bpm: typeof c['bpm'] === 'number' ? Math.round(c['bpm'] as number) : null,
    genres,
    explicit: c['explicit'] ?? null,
    duration: typeof c['duration'] === 'number' ? Math.round(c['duration'] as number) : null,
    release_year: typeof (c['release'] as Dict | undefined)?.['date'] === 'string' ? String((c['release'] as Dict)['date']).slice(0, 4) : null,
    popularity: typeof (c['extra'] as Dict | undefined)?.['popularity'] === 'number' ? (c['extra'] as Dict)['popularity'] : null,
    taste_fit: tf ? round(tf.value, 2) : null,
  };
}

// `settings()` returns { ...DEFAULT_SETTINGS, ...stored }, so a new key defaults cleanly for an
// install that predates it — no migration needed.
/** FEATURES-FLOW-001: how long one request works on a look for features before answering with what it has. */
const FEATURE_SLICE_MS = 2500;
/** MOOD-DISCOVER-001: when the mood last asked for songs, and how often it may. */
const MOOD_DISCOVERY_AT = 'mood_discovery_at';
const MOOD_DISCOVERY_EVERY_S = 600;
const DEFAULT_SETTINGS = { fresh: false, adventurous: 0.5, audio: true, daily_mb: TRANSFER.daily / 1e6, request_mb: TRANSFER.perRequest / 1e6, sample_mode: false, queue_size: DEFAULT_ENGINE.queueSize, similar_percent: SIMILAR_DEFAULT, cache_gb: 1, dl_parallel: 0, preload_target: 'all' as 'all' | 'count', preload_count: 20, discover_while_listening: true, mood_queue: true, rank_v2: true, eq: EQ_DEFAULTS, mix: 0, local_mix: true, play_through: PLAY_THROUGH_DEFAULT };
/** How many songs one discovery run adds to the list: the user's choice in Settings. */
export const QUEUE_SIZE_MIN = 5;
export const QUEUE_SIZE_MAX = 60;
const FEEDBACK_KINDS = new Set(['qualified', 'like', 'dislike', 'hide', 'save', 'replay', 'complete', 'skip', 'unlike', 'unsave', 'undislike', 'unhide']);
/** PLAYLIST-QUEUE-001 store keys: the list now in the queue, the queue it replaced, the seed window. */
const QUEUE_PLAYLIST_KEY = 'queue_playlist';
/** Songs saved lists were made with (ALBUM-OPEN-001), by key, so a list made from an album shows every song. */
const LIST_TRACKS_KEY = 'list_tracks';
/** TAGS-ALWAYS-001: genres looked up for saved songs that had none, by song key. */
const SAVED_TAGS_KEY = 'saved_tags';
/** TAGS-ALWAYS-001: release dates looked up for saved songs that had none (key -> release or year hint). */
const SAVED_DATES_KEY = 'saved_dates';
/** What says which album a song is on; a copy that leaves these out keeps them from another copy. */
const ALBUM_FIELDS = ['album', 'album_id', 'release'] as const;

/**
 * ALBUM-OPEN-001 / ALBUM-TASTE-001: the copy of a song that was played (often SoundCloud or YouTube) may
 * not name its album, though another copy with the same key does. Fill only what is missing, and only
 * when the copy names no album of its own, so a copy that says otherwise is never overwritten.
 */
function withAlbumOf(t: Dict, from: Dict | undefined): Dict {
  if (!from || t['album'] || !from['album']) return t;
  const out = { ...t };
  for (const f of ALBUM_FIELDS) if ((out[f] === undefined || out[f] === null || out[f] === '') && from[f]) out[f] = from[f];
  return out;
}

/** IMPORT-GENRES-001: what a confident catalogue match lent an imported song, kept on every copy of it. */
const IMPORT_FACTS = ['tags', 'artwork', 'duration', 'release', 'year_hint', 'catalogue_match', 'file_genre'] as const;
const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * IMPORT-GENRES-001: a fresher copy of an imported song (one played, queued or re-imported) does not
 * know the genres, cover and length its saved-list copy was given; fill only what it lacks.
 */
function withImportFactsOf(t: Dict, from: Dict | undefined): Dict {
  if (!from || from['provider'] !== 'imported') return t;
  // SAVED-GENRES-001: the same song streamed earlier (a catalogue copy with this key) lacks what a
  // confident match gave the imported copy. Lend only its genre facts and cover; never the file link.
  const facts = t['provider'] === 'imported' ? IMPORT_FACTS : from['catalogue_match'] ? LENT_TO_CATALOGUE : [];
  let out = t;
  for (const f of facts) {
    if (blank(out[f]) && !blank(from[f])) out = { ...out, [f]: from[f] };
  }
  return out;
}
const LENT_TO_CATALOGUE = ['tags', 'artwork', 'release', 'year_hint'] as const;
const QUEUE_SAVED_KEY = 'queue_saved';
const SEED_CURSOR_KEY = 'seed_cursor';
/** COLOR-DISCOVERY-001: how far previous runs have read into the listener's colours. */
const TASTE_CURSOR_KEY = 'taste_cursor';
const CAPS = ['search', 'resolve_link', 'related_candidates', 'artist_candidates', 'recent_candidates', 'playback_link'];

/**
 * Where a full-song embedding lives (FULL-SONG-EMBED-001).
 *
 * Preview vectors are keyed `deezer:<id>`, which a song with no Deezer match can never have — so
 * those songs were scored with no audio at all while still being shown a fit percentage. A full-song
 * vector is keyed by the song itself, is looked up first because it describes the song better, and
 * never overwrites the preview vector it supersedes.
 */
export const songVectorKey = (key: string): string => `song:${key}`;

const ok = (body: unknown, status = 200): LocalResponse => ({ status, body });
/** matchRecordings' verdict for an exact title and artist where one side has no duration (identity.ts). */
const NO_LENGTH = 'no duration to compare';
const fail = (status: number, message: string, extra: Dict = {}): LocalResponse => ({ status, body: { message, detail: message, ...extra } });
const unixNow = (): number => Date.now() / 1000;
/** The day the transfer counter is keyed by, same shape the store uses. */
const today = (): string => new Date().toISOString().slice(0, 10);
const newId = (): string => Math.random().toString(16).slice(2, 14).padEnd(12, '0');

/** The songs in `incoming` whose key the pool does not hold yet, in their original order. */
export function addNewCandidates(pool: Dict[], incoming: Dict[]): Dict[] {
  const have = new Set(pool.map((c) => String(c['key'])));
  const out: Dict[] = [];
  for (const c of incoming) {
    const k = String(c['key']);
    if (have.has(k)) continue;
    have.add(k);
    out.push(c);
  }
  return out;
}

/** TASTE-FULL-BOUND-001: the longest song, and the largest file, the page decodes to learn its sound. */
export const FULL_SONG_MAX_SECONDS = 600;
export const FULL_SONG_MAX_BYTES = 16 * 1024 * 1024;

/** The body, or null as soon as it is known to be over `max` bytes (the rest is never read). */
async function readAtMost(res: Response, max: number): Promise<Uint8Array | null> {
  const told = Number(res.headers.get('content-length'));
  if (Number.isFinite(told) && told > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export class LocalApi {
  readonly store: Store;
  readonly http: Http;
  readonly dz: Deezer;
  readonly ytm: YouTubeMusic;
  readonly sc: SoundCloud;
  readonly bandcamp: Bandcamp;
  readonly audius: Audius;
  readonly hearthis: HearThis;
  readonly archive: InternetArchive;
  readonly apple: AppleMusic;
  readonly albums: Albums;
  readonly artists: Artists;
  readonly extras: ArtistExtrasReader;
  /** FEATURES-FLOW-001: looks for features in progress, by artist id. */
  private readonly featureLooks = new Map<string, ReturnType<Artists['featureLook']>>();
  readonly sp: Spotify;
  readonly genius: Genius;
  readonly shazam: Shazam;
  private readonly spotifySearch: ((q: string, limit: number) => Promise<Dict[]>) | null;
  readonly pipeline: Pipeline;
  private readonly encoder: Embedder | null;
  private jobs = new Map<string, Job>();
  private currentJob: string | null = null;
  /** The last finished run's candidates and context, kept so the player can re-rank them live. */
  private pool: { cands: Dict[]; ctx: E.Context; job: Job } | null = null;
  private health: Dict = {};
  private healthAt = 0;
  private healthRun: Promise<Dict> | null = null;
  private audioCheck: Dict = { state: 'not_tested' };
  private readonly started = performance.now();

  constructor(deps: LocalDeps) {
    this.store = deps.store;
    this.encoder = deps.encoder;
    this.http = new Http(deps.port);
    this.dz = new Deezer(this.http, this.store);
    this.ytm = new YouTubeMusic(this.http, this.store);
    this.sc = new SoundCloud(this.http, this.store);
    this.bandcamp = new Bandcamp(this.http, this.store);
    this.audius = new Audius(this.http, this.store);
    this.hearthis = new HearThis(this.http, this.store);
    this.archive = new InternetArchive(this.http, this.store);
    this.apple = new AppleMusic(this.http, this.store);
    this.albums = new Albums(this.http, this.dz, this.store, this.ytm, this.sc, this.bandcamp);
    this.artists = new Artists(this.http, this.dz, this.ytm, this.store, this.albums);
    this.extras = new ArtistExtrasReader(this.http, this.store, { sc: this.sc, bandcamp: this.bandcamp, audius: this.audius, albums: this.albums });
    this.sp = new Spotify(this.http, this.store);
    this.genius = new Genius(this.http);
    this.shazam = new Shazam(this.http);
    this.spotifySearch = deps.spotifySearch ? deps.spotifySearch(this.http) : null;
    this.pipeline = new Pipeline(this.store, this.http, this.dz, this.ytm, this.sc, this.apple, this.spotifySearch, this.encoder);
    this.store.expireImpressions(unixNow() - DEFAULT_ENGINE.exposureWindowDays * 86400 * 4);
  }

  settings(): Dict {
    const stored: Dict = { ...(this.store.get<Dict>('settings', {}) ?? {}) };
    if ('mode' in stored) {
      const old = stored['mode'];
      delete stored['mode'];
      stored['fresh'] ??= old === 'new';
      if (old === 'similar') stored['adventurous'] = Math.min(Number(stored['adventurous'] ?? 0.5), 0.25);
    }
    // ALGO-MANAGER-001: legacy weights/ranking_formula migrate into the active user algorithm "My formula".
    return settingsWithAlgorithms({ ...DEFAULT_SETTINGS, ...stored, play_through: 100 }); // FULL-COMPLETION-001 migrates stored early-overlap values
  }

  /**
   * The allowance for the lookups that start a song (which YouTube video to play, a fresh preview address).
   * They read a few kilobytes and the song itself streams from YouTube's player, so a spent daily discovery
   * allowance must not stop a song from playing. What they read still counts toward the day's total.
   */
  private playbackMeter(): Meter {
    // Deliberately independent of the owner's daily discovery allowance: finding the audio for a
    // song they are trying to play must not be refused because the day's browsing budget is spent
    // (see "looks up the full song even when the day's discovery allowance is used up"). Every byte
    // is still counted through the sink, so Settings shows it.
    //
    // 8 MB, not 3: resolving a song may have to read SoundCloud's client-id bundle, which is
    // 2,950,727 bytes and served uncompressed (measured 2026-11-05). At 3 MB there was never room
    // left after the YouTube searches, so the SoundCloud leg died before it ever searched and every
    // song it could have rescued was reported as having no source. 8 MB is the native bridge's own
    // per-request ceiling (MainActivity.kt maxBytes). The id is then cached for a day, so the cost
    // is paid once rather than per song.
    return new Meter(8_000_000, 8_000_000, (c, n) => this.store.addTransfer(c, n));
  }

  /**
   * FEATURES-ALL-002: every page of an artist's features is up to a few hundred small Deezer reads
   * and up to sixty YouTube Music search pages (about 55 KB each as they are asked for). One search's
   * cap cut that short part-way and left the list saying "incomplete" on every look. Measured for a
   * well known artist: about 4 MB. The day's allowance still bounds it. FEATURES-FLOW-001 takes the
   * look a few seconds per request; each request's share is far under this cap.
   */
  private featureMeter(): Meter {
    const daily = Math.trunc(Number(this.settings()['daily_mb']) * 1e6);
    const used = Object.values(this.store.transferToday()).reduce((a, b) => a + b, 0);
    return new Meter(12_000_000, Math.max(0, daily - used), (c, n) => this.store.addTransfer(c, n));
  }

  private searchMeter(): Meter {
    const daily = Math.trunc(Number(this.settings()['daily_mb']) * 1e6);
    const used = Object.values(this.store.transferToday()).reduce((a, b) => a + b, 0);
    // Per-search cap sized so one search can read SoundCloud's ~2.9 MB client-id bundle plus the other
    // providers' answers. The daily allowance (daily_mb) is the real limit and is unchanged.
    return new Meter(6_000_000, Math.max(0, daily - used), (c, n) => this.store.addTransfer(c, n));
  }

  // ---------------------------------------------------------------------------------------
  async handle(method: string, rawPath: string, body: Dict | null = null): Promise<LocalResponse> {
    const u = new URL(rawPath, 'http://local');
    const path = u.pathname;
    const q = u.searchParams;
    const m = method.toUpperCase();
    try {
      if (m === 'GET' && path === '/api/health') return ok(await this.healthRoute(q.get('refresh') === '1' || q.get('refresh') === 'true'));
      if (m === 'GET' && path === '/api/search') return ok(await this.search(q.get('q') ?? '', q.get('sources') ?? 'ytmusic,deezer,soundcloud,apple', Number(q.get('limit') ?? 12)));
      if (m === 'GET' && path === '/api/search/lyrics') return await this.searchLyrics(q.get('q') ?? '');
      if (m === 'GET' && path === '/api/search/albums') return ok(await this.searchAlbums(q.get('q') ?? ''));
      if (m === 'POST' && path === '/api/album') return await this.album(body ?? {});
      if (m === 'GET' && path === '/api/search/artists') return ok(await this.searchArtists(q.get('q') ?? ''));
      if (m === 'POST' && path === '/api/artist') return await this.artist(body ?? {}, 'page');
      if (m === 'POST' && path === '/api/artist/songs') return await this.artist(body ?? {}, 'songs');
      if (m === 'POST' && path === '/api/artist/features') return await this.artist(body ?? {}, 'features');
      if (m === 'POST' && path === '/api/artist/sources') return await this.artist(body ?? {}, 'sources');
      if (m === 'POST' && path === '/api/identify/audio') return await this.identifyAudio(body ?? {});
      if (m === 'POST' && path === '/api/radio/analyse') return await this.radioAnalyse(body ?? {});
      if (m === 'POST' && path === '/api/radio/genres') {
        const t = body?.['track'] as Dict; if (!t?.['key'] || !t?.['title']) return fail(400, 'A track is required');
        const found = await this.lookUpGenres(t, this.searchMeter());
        const tags = found.tags.length ? found.tags : this.knownGenres()(t);
        const enriched = { ...found.track, tags };
        const characteristics = this.genreFiller([{ track: enriched }])(enriched, characteristicsOf(enriched, null));
        return ok({ track: cleanTrack(enriched), characteristics });
      }
      if (m === 'POST' && path === '/api/resolve') return await this.resolve(String(body?.['url'] ?? ''));
      if (m === 'POST' && path === '/api/complete-spotify') return ok(await this.completeSpotify(String(body?.['title'] ?? ''), String(body?.['artist'] ?? '')));
      if (path === '/api/seeds') return m === 'PUT' ? await this.putSeeds(body ?? {}) : ok(this.seedsView());
      if (path === '/api/settings') return m === 'PUT' ? await this.putSettings(body ?? {}) : ok(this.settings());
      if (m === 'POST' && path === '/api/recommend') return this.recommend(body ?? {});
      if (m === 'POST' && path === '/api/similar') return this.similar(body ?? {});
      if (m === 'POST' && path === '/api/discover/custom') return this.discoverCustom(body ?? {});
      const job = /^\/api\/jobs\/([A-Za-z0-9]+)$/.exec(path);
      if (job) return m === 'DELETE' ? this.cancelJob(job[1]!) : this.jobStatus(job[1]!);
      if (m === 'POST' && path === '/api/feedback') return await this.feedback(body ?? {});
      if (m === 'POST' && path === '/api/import/history') return await this.importHistory(body ?? {});
      if (m === 'POST' && path === '/api/import/local') return await this.importLocal(body ?? {});
      if (m === 'GET' && path === '/api/feedback/state') return ok(this.feedbackState());
      if (m === 'POST' && path === '/api/impressions') return await this.impressions(body ?? {});
      if (m === 'POST' && path === '/api/full-song') return await this.fullSong(body ?? {});
      if (m === 'POST' && path === '/api/embed-local') return await this.embedLocal(body ?? {});
      if (m === 'GET' && path === '/api/saved') return ok(this.saved());
      if (m === 'POST' && path === '/api/genres') return ok(await this.genresFor(((body ?? {})['tracks'] as Dict[] | undefined) ?? []));
      if (m === 'GET' && path === '/api/playlists') return ok(this.playlists());
      if (m === 'POST' && path === '/api/playlists') return await this.playlistAction(body ?? {});
      if (m === 'GET' && path === '/api/status') return ok(await this.status());
      if (m === 'POST' && path === '/api/reset') return this.reset(Boolean(body?.['clear_cache']));
      if (m === 'POST' && path === '/api/reset/taste') return this.resetTaste();
      if (m === 'POST' && path === '/api/queue/clear') return await this.clearQueue();
      if (m === 'POST' && path === '/api/queue/playlist') return await this.queueFromPlaylist(String(body?.['id'] ?? ''));
      if (m === 'POST' && path === '/api/queue/restore') return await this.restoreQueue();
      if (m === 'POST' && path === '/api/queue/add') return await this.queueAdd(body ?? {});
      if (m === 'POST' && path === '/api/queue/genres') return await this.queueGenres(body ?? {});
      if (m === 'GET' && path === '/api/playlists/mix') return this.playlistMixRoute(q.get('id') ?? '');
      if (m === 'POST' && path === '/api/model/install') return ok({ installed: this.encoder !== null, downloaded: 0 });
      if (m === 'POST' && path === '/api/model/selftest') return await this.selftest();
      if (m === 'POST' && path === '/api/rerank') return await this.rerank(body ?? {});
      if (m === 'POST' && path === '/api/mood') return this.mood(body ?? {});
      if (m === 'GET' && path === '/api/profile') return ok(this.profile());
      if (m === 'GET' && path === '/api/last') {
        const r = this.store.get<Dict>('last_result');
        return r ? ok(this.completed(this.withKnownGenres(r))) : fail(404, 'No earlier recommendations yet.');
      }
      const pv = /^\/api\/preview-url\/deezer\/(\d{1,20})$/.exec(path);
      if (m === 'GET' && pv) return await this.previewUrl(pv[1]!);
      return fail(404, 'Not found');
    } catch (e) {
      if (e instanceof BlockedUrl) return ok({ kind: 'error', error: 'blocked', message: e.message, detail: e.message }, 400);
      return fail(500, `${(e as Error).name}: ${(e as Error).message}`);
    }
  }

  // ---- health --------------------------------------------------------------------------
  private async probe<T>(fn: () => Promise<T>, good: (v: T) => [boolean, string]): Promise<Dict> {
    const t0 = performance.now();
    try {
      const v = await fn();
      const [yes, detail] = good(v);
      return { state: yes ? 'working' : 'degraded', detail, checked: unixNow(), latency_ms: Math.trunc(performance.now() - t0) };
    } catch (e) {
      return { state: 'unavailable', detail: `${(e as Error).name}: ${String((e as Error).message).slice(0, 110)}`, checked: unixNow(), latency_ms: null };
    }
  }

  private async refreshHealth(): Promise<Dict> {
    const unsupported = { state: 'unsupported', detail: 'this provider offers no keyless way to do this', checked: unixNow(), latency_ms: null };
    const c: Ctx = { meter: this.searchMeter() };
    const dz = await this.probe(() => this.dz.search('daft punk', 1, c), (r) => [r.length > 0, r.length ? 'live search answered' : 'empty answer']);
    const yt = await this.probe(
      async () => {
        const res = await this.ytm.search('daft punk', 1, c);
        const vid = res.find((x) => x.platform_id)?.platform_id;
        return { vid, related: vid ? await this.ytm.radio(vid, 4, c) : [] };
      },
      (r) => [Boolean(r.vid), 'live song search answered'],
    );
    const ytRadio: Dict = yt['state'] === 'unavailable' ? yt : { ...yt, detail: 'radio answered' };
    const sc = await this.probe(() => this.sc.search('flickermood forss', 1, c), (r) => [r.length > 0, 'SoundCloud search answered (client id read from soundcloud.com)']);
    const spm = await this.probe(() => this.sp.resolveLink('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b', c), (t) => [Boolean(t.title), 'oEmbed answered (title + artwork, no artist)']);
    // Full-song fallback sources: they do not stream or supply candidates, they find one exact
    // recording and the app downloads it. Probing each keeps the panel honest about all eight
    // sources the engine really uses (SRC-PANEL-001). The queries are harmless live searches with a
    // known public answer, so "Working" means the catalogue actually responded.
    const bc = await this.probe(() => this.bandcamp.search('Giant Step Ben Prunty', 3, c), (r) => [r.length > 0, 'Bandcamp search answered with a full-track link']);
    const au = await this.probe(() => this.audius.search('Bass Go Boom LOUDWERX', 3, c), (r) => [r.length > 0, 'Audius search answered with a full-track link']);
    const ht = await this.probe(() => this.hearthis.search('Creative Commons', 5, c), (r) => [r.length > 0, 'HearThis answered with creator-downloadable Creative Commons tracks']);
    const ar = await this.probe(() => this.archive.search('Cold Funk', 3, c), (r) => [r.length > 0, 'Internet Archive answered with a Creative Commons audio file']);
    const caps = (names: string[], h: Dict): Dict => Object.fromEntries(names.map((n) => [n, h]));
    const out: Dict = {
      deezer: caps(['search', 'resolve_link', 'related_candidates', 'artist_candidates', 'recent_candidates', 'playback_link'], dz),
      ytmusic: { ...caps(['search', 'resolve_link', 'playback_link'], yt), ...caps(['related_candidates', 'artist_candidates'], ytRadio) },
      soundcloud: { ...caps(['search', 'resolve_link', 'related_candidates'], sc), playback_link: sc },
      spotify: { resolve_link: spm, playback_link: spm },
      // Fallback sources only do search + play; the remaining columns fall through to 'unsupported'.
      bandcamp: caps(['search', 'playback_link'], bc),
      audius: caps(['search', 'playback_link'], au),
      hearthis: caps(['search', 'playback_link'], ht),
      archive: caps(['search', 'playback_link'], ar),
    };
    for (const p of Object.keys(out)) for (const cap of CAPS) out[p][cap] ??= unsupported;
    out['spicetify'] = { companion: { state: 'not_tested', detail: 'Optional Spotify desktop bridge; not part of the phone app.', checked: unixNow(), latency_ms: null } };
    this.health = out;
    this.healthAt = unixNow();
    return out;
  }

  private async healthRoute(refresh: boolean): Promise<Dict> {
    // ALLOWANCE-REFRESH-001: "Check again" also gives the day's download allowance back, before the
    // probes run, so the very next search, discovery or genre read has room. A plain read (the
    // Settings screen opening) never clears anything.
    const refreshed = refresh ? { cleared_bytes: this.store.clearTransfer(), day: today() } : null;
    if (refresh || !Object.keys(this.health).length || unixNow() - this.healthAt > 600) {
      this.healthRun ??= this.refreshHealth().finally(() => (this.healthRun = null));
      await this.healthRun;
    }
    return { providers: this.health, checked_at: this.healthAt, audio: this.audioState(), ...(refreshed ? { allowance_refreshed: refreshed } : {}) };
  }

  private audioState(): Dict {
    return {
      model: A.MODEL_ID, preprocess: A.PREPROCESS_ID, dim: A.DIM, installed: this.encoder !== null, download_bytes: 0,
      source: 'Full songs from the queue cache, else Deezer 30-second previews', license: 'AGPL-3.0 (AudioMuse-AI-DCLAP)', check: this.audioCheck, vectors: this.store.vectorCount(),
    };
  }

  // ---- search / resolve ----------------------------------------------------------------
  private dedupe(lists: Dict[][]): Dict[] {
    const out: Dict[] = [];
    for (const lst of lists) {
      for (const t of lst) {
        const dup = out.find((o) => o['key'] === t['key'] && matchRecordings(o as never, t as never).verdict === 'same');
        if (dup) {
          (dup['also_on'] ??= []).push({ provider: t['provider'], url: t['url'], id: t['platform_id'] });
          continue;
        }
        out.push(t);
      }
    }
    return out;
  }

  private async search(qIn: string, sources: string, limitIn: number): Promise<Dict> {
    const q = qIn.trim().slice(0, 200);
    if (!q) return { query: q, results: [], sources: {} };
    if (looksLikeUrl(q)) {
      const r = await this.resolve(q);
      return r.body as Dict;
    }
    const t0 = performance.now();
    const meter = this.searchMeter();
    const wanted = sources.split(',').filter((x) => ['ytmusic', 'deezer', 'soundcloud', 'apple', 'spotify'].includes(x));
    if (!wanted.length) wanted.push('ytmusic');
    const limit = Math.max(1, Math.min(25, Number.isFinite(limitIn) ? limitIn : 12));
    const status: Dict = {};
    const prov: Record<string, { search(q: string, n: number, c: Ctx): Promise<Dict[]> }> = {
      ytmusic: this.ytm as never,
      deezer: this.dz as never,
      soundcloud: this.sc as never,
      apple: this.apple as never,
      spotify: { search: (q, n) => (this.spotifySearch ? this.spotifySearch(q, n) : Promise.reject(new ProviderError('Spotify search runs only in the Windows app.'))) },
    };
    const lists = await Promise.all(
      wanted.map(async (name) => {
        const t = performance.now();
        try {
          const res = await prov[name]!.search(q, limit, { meter });
          status[name] = { state: 'ok', count: res.length, ms: Math.trunc(performance.now() - t) };
          return res;
        } catch (e) {
          // SRC-BUDGET-001: refused because the DAY's allowance is spent (not this search's own cap), so
          // the search line can say the allowance is all used up and not offer a refresh that cannot help.
          const spent = e instanceof BudgetExceeded && meter.daily - meter.total <= 0;
          status[name] = { state: spent ? 'budget' : 'failed', detail: `${(e as Error).name}: ${String((e as Error).message).slice(0, 120)}`, ms: Math.trunc(performance.now() - t) };
          return [] as Dict[];
        }
      }),
    );
    const results = this.dedupe(lists).map((t) => ({ ...cleanTrack(t), also_on: t['also_on'] ?? [] }));
    const ms = performance.now() - t0;
    return { query: q, results, sources: status, ms: Math.round(ms), bytes: meter.total };
  }

  // ---- albums (ALBUM-SEARCH-001, ALBUM-OPEN-001) ------------------------------------------
  private async searchAlbums(raw: string): Promise<Dict> {
    const q = raw.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!q || looksLikeUrl(q)) return { query: q, albums: [], sources: {} };
    const t0 = performance.now();
    const meter = this.searchMeter();
    const r = await this.albums.search(q, 12, { meter });
    return { query: q, albums: r.albums, sources: r.sources, ms: Math.round(performance.now() - t0), bytes: meter.total };
  }

  // ---- artists (ARTIST-PAGE-001) ----------------------------------------------------------
  private async searchArtists(raw: string): Promise<Dict> {
    const q = raw.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!q || looksLikeUrl(q)) return { query: q, artists: [] };
    const meter = this.searchMeter();
    const r = await this.artists.searchWithWhy(q, 6, { meter });
    return { query: q, artists: r.artists, ...(r.why ? { why: r.why } : {}), bytes: meter.total };
  }

  /** `{ id?, name? }` opens that artist; with `every`, the songs on all their albums and singles too. */
  private async artist(body: Dict, want: 'page' | 'songs' | 'features' | 'sources'): Promise<LocalResponse> {
    const every = want !== 'page';
    const meter = want === 'features' ? this.featureMeter() : this.searchMeter();
    const refreshToken = typeof body['refreshToken'] === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(body['refreshToken']) ? body['refreshToken'] : undefined;
    const ctx = { meter, refresh: body['refresh'] === true, refreshToken };
    const id = typeof body['id'] === 'string' ? body['id'].slice(0, 80) : '';
    const name = typeof body['name'] === 'string' ? body['name'].trim().slice(0, 200) : '';
    if (!id && !name) return fail(400, 'id or name required');
    try {
      const target = { ...(id ? { id } : {}), ...(name ? { name } : {}) };
      const a = await this.artists.open(target, ctx);
      const clean = (list: readonly object[]) => list.map((t) => cleanTrack(t as Dict));
      if (!every) return ok({ artist: { ...a, songs: clean(a.songs) } });
      // ARTIST-ALL-SOURCES-001: what SoundCloud, Apple Music, Bandcamp and Audius add, asked on its own
      // so the page never waits on four more services, and one of them failing costs nothing else.
      if (want === 'sources') {
        const x = await this.extras.read(a, ctx);
        return ok({ songs: clean(x.songs), albums: x.albums, singles: x.singles, sources: x.sources });
      }
      // FEATURES-ALL-001: the features are their own request, so the song list never waits on the few
      // hundred small reads that confirm them, and one failing does not lose the other.
      // FEATURES-FLOW-001: a look takes up to a minute, so it is taken a few seconds per request. Each
      // answer has every feature confirmed so far and `more` while another request would add to it;
      // the page lists them as they come. Work is done only while the page keeps asking.
      if (want === 'features') {
        // OPEN-HEAL-001: a look begun on a page that opened without a service is not carried on once
        // the page has that service; the new look asks it too (what Deezer said is remembered).
        const lookKey = `${a.id}|${a.links.deezer ? 'd' : ''}${a.links.ytmusic ? 'y' : ''}:${refreshToken || ''}`;
        let job = this.featureLooks.get(lookKey);
        if (!job) {
          // A handful of looks at most are kept: one left half way is picked up if the page returns.
          if (this.featureLooks.size >= 4) this.featureLooks.delete(this.featureLooks.keys().next().value as string);
          job = this.artists.featureLook(a, ctx);
          this.featureLooks.set(lookKey, job);
        }
        const found = await job.step(ctx, FEATURE_SLICE_MS);
        if (!found.more) this.featureLooks.delete(lookKey);
        return ok({ features: clean(found.features), complete: found.complete, more: found.more });
      }
      const all = await this.artists.everySong(a, ctx, { features: false });
      return ok({ songs: clean(all.songs), features: [], opened: all.opened, failed: all.failed, featuresComplete: true });
    } catch (e) {
      // ARTIST-FALLBACK-001: song credits carry names no service has a page for - uploader handles,
      // small self-releases, a name spelt another way. Tapping one lands on what this app holds by
      // that name rather than on an error.
      if (e instanceof ProviderError && name) {
        // ARTIST-SOURCES-001: what happened to each service goes with the page, so it never says a
        // service has no page for this name when the service was not read at all.
        const local = this.localArtist(name, e instanceof ArtistNotOpened ? e.sources : undefined);
        // ARTIST-FALLBACK-002: the page asks for every song next, with the local id. That request gets
        // its own shape; answered with a second page, the screen had no song list and the app went blank.
        if (want === 'features') return ok({ features: [], complete: true });
        // A name Deezer and YouTube Music have no page for can still have one elsewhere: an account
        // SoundCloud or Audius vouches for, or a page whose songs are the ones held here.
        if (want === 'sources') {
          const x = await this.extras.read({ id: String(local['id']), name, songs: local['songs'] as { title: string }[], features: local['features'] as { title: string }[], albums: [], singles: [] }, ctx);
          return ok({ songs: x.songs.map((t) => cleanTrack(t as Dict)), albums: x.albums, singles: x.singles, sources: x.sources });
        }
        if (every) return ok({ songs: local['songs'], features: local['features'], opened: 0, failed: 0, featuresComplete: true });
        return ok({ artist: local });
      }
      // Opened by id alone there is no name to fall back on: give the real reason, not "no artist named".
      if (e instanceof ArtistNotOpened) {
        const why = Object.values(e.sources).find((x) => x.state === 'failed')?.why;
        if (why === 'allowance') return fail(429, 'The daily transfer allowance is used up.', { code: 'budget' });
        if (why === 'offline') return fail(503, 'No connection.', { code: 'offline' });
        if (why === 'busy') return fail(503, 'The artist service is busy.', { code: 'busy' });
      }
      return this.identifyFailure(e, 'artist');
    }
  }

  /**
   * ALBUM-GENRE-DETAIL-001: what MusicBrainz's listeners call this record. Two small requests, both
   * cached a month and charged to the day's allowance: a search that proves which release-group is
   * meant, then the lookup that carries its genres (a search answer has none). Any failure, or a
   * release nobody tagged, simply adds nothing.
   */
  private async releaseGroupTags(title: string, artist: string, meter: Meter | undefined, artistKnown: Tag[] = []): Promise<Tag[]> {
    if (!title || title.length > 120 || artist.length > 120) return [];
    const headers = { 'user-agent': MUSICBRAINZ_UA, accept: 'application/json' };
    const get = (url: string, key: string) =>
      cached(this.store, key, 'metadata', 30 * 24 * 3600, () =>
        this.http.getJson<Dict>(url, { maxBytes: 150_000, ...(meter ? { meter } : {}), category: 'metadata', headers }),
      );
    try {
      // A reissue is the same record: MusicBrainz files "A Great Chaos (Deluxe)" as "A Great Chaos".
      const asked = baseAlbumTitle(title);
      const q = `release:"${asked.replace(/"/g, ' ')}"${artist ? ` AND artist:"${artist.replace(/"/g, ' ')}"` : ''}`;
      const found = await get(`https://musicbrainz.org/ws/2/release-group?query=${encodeURIComponent(q)}&fmt=json&limit=1`, `mb:rg:${fold(artist)}:${fold(asked)}`);
      const id = releaseGroupId(found, title, artist);
      if (!id) return [];
      const full = await get(`https://musicbrainz.org/ws/2/release-group/${id}?inc=tags+genres&fmt=json`, `mb:rgtags:${id}`);
      return tagsFromReleaseGroup(full, undefined, undefined, artistKnown);
    } catch {
      return [];
    }
  }

  /** The songs this app already holds credited to a name, as an artist page of its own. */
  private localArtist(name: string, seen?: Record<string, ArtistSource>): Dict {
    const held = [...this.knownTracks().values()].filter((t) =>
      ((t['artists'] as string[] | undefined) ?? (t['artist'] ? [String(t['artist'])] : [])).some((n) => fold(String(n)) === fold(name)),
    );
    const { songs, features } = partitionFeatures(held as never, name);
    return {
      id: `local:${fold(name)}`, name, picture: null, detail: null, local: true,
      songs: (songs as Dict[]).map((t) => cleanTrack(t)),
      features: (features as Dict[]).map((t) => cleanTrack(t)),
      albums: [], singles: [], links: {},
      sources: Object.fromEntries(
        (['deezer', 'ytmusic'] as const).map((p) => {
          const s = seen?.[p];
          return [p, s?.state === 'failed' ? { state: 'failed', why: s.why ?? 'failed' } : { state: 'none' }];
        }),
      ),
    };
  }

  /** `{ id }` opens that album; `{ track }` opens the album the song sits on. */
  private async album(body: Dict): Promise<LocalResponse> {
    const meter = this.searchMeter();
    const id = typeof body['id'] === 'string' ? body['id'] : '';
    const track = body['track'] && typeof body['track'] === 'object' ? (body['track'] as Dict) : null;
    if (!id && !track) return fail(400, 'id or track required');
    try {
      const a = id ? await this.albums.open(id, { meter }) : await this.albums.openFor(track as never, { meter });
      if (!a) return fail(404, 'No album for this song was found on Deezer, Apple Music, YouTube Music or SoundCloud.', { code: 'none' });
      // ALBUM-SOUND-001: the album's own sound, from the genres of its songs, in the shape the
      // Sound card draws for the listener's taste and for a saved list. Album songs come straight
      // from the provider and usually carry no tags of their own, so what the service says about
      // the album itself (Deezer and Apple state a genre) stands in for a song it cannot place.
      const tracks = a.tracks.map((t) => cleanTrack(t as Dict));
      const own = this.genresOfTrack();
      const stated = a.genres.map((g) => makeTag(String(g), 'album genre', 'album', 0.6)).filter((t): t is Tag => Boolean(t));
      const artist = String((a as Dict)['artist'] ?? '');
      const subsKey = fold(artist);
      // ALBUM-GENRE-DETAIL-001, step one: what this artist is known for. Asked once per artist
      // (MusicBrainz, cached a month, inside the day's allowance) and remembered for everything
      // else that reads a genre.
      if (artist && artist.length <= 80 && !(this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {})[subsKey]?.tags.length) {
        try {
          await lookupArtistSubs(this.store, this.http, artist, { meter }, (key, fn) => cached(this.store, key, 'metadata', 30 * 24 * 3600, fn) as Promise<never>, unixNow());
        } catch {
          /* no subgenre detail is not a failed album */
        }
      }
      const subs = this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {};
      // Step two: what MusicBrainz's listeners call THIS record ("neo-soul", "rage"), which is
      // finer than a service's one-word album genre. Ties go to what the artist is known for, so a
      // single stray vote does not take a slot from the style the record is actually in.
      const mbTags = await this.releaseGroupTags(String((a as Dict)['title'] ?? ''), artist, meter, subs[subsKey]?.tags ?? []);
      const albumTags = [...mbTags, ...stated.filter((t) => !mbTags.some((m) => m.name === t.name))];
      const genresOf = (t: Dict): Tag[] => albumGenres({ ...t, tags: own(t) }, { albumTags, subs, artist });
      // ALBUM-RAGE-001: when the songs were placed from album-level tags they all carry the same
      // ones, so the bar is drawn from the strength of that evidence rather than from 21 identical
      // play counts. A record whose songs carry their own tags still counts songs.
      const fromAlbum = tracks.every((t) => !own(t).length);
      const mix = playlistMix(tracks, genresOf, unixNow(), { byEvidence: fromAlbum });
      const tagged = tracks.map((t) => ({ ...t, tags: genresOf(t) }));
      return ok({ album: { ...a, tracks: tagged, mix } });
    } catch (e) {
      if (e instanceof ProviderError) return fail(404, e.message, { code: 'none' });
      return this.identifyFailure(e, 'album');
    }
  }

  // ---- identify by lyrics / audio ------------------------------------------------------
  /** What went wrong with a Genius/Shazam call, in terms the UI has copy for. */
  private identifyFailure(e: unknown, what: 'lyrics' | 'audio' | 'album' | 'artist'): LocalResponse {
    const msg = String((e as Error)?.message ?? e);
    if (e instanceof BudgetExceeded) return fail(429, 'The daily transfer allowance is used up.', { code: 'budget' });
    if (/HTTP (429|5\d\d)/.test(msg)) return fail(503, `The ${what} service is busy.`, { code: 'busy' });
    if (/HTTP 4\d\d/.test(msg)) return fail(502, `The ${what} service refused the request.`, { code: 'refused' });
    if (e instanceof FetchError || e instanceof TypeError || /network|timed out|fetch|Socket|Unknown ?Host|Connect/i.test(msg)) return fail(503, 'No connection.', { code: 'offline' });
    return fail(500, `${(e as Error).name}: ${msg}`, { code: 'failed' });
  }

  private searchersForIdentify(): Record<string, { search(q: string, n: number, c: Ctx): Promise<Dict[]> }> {
    return { deezer: this.dz as never, ytmusic: this.ytm as never, apple: this.apple as never };
  }

  private async searchLyrics(raw: string): Promise<LocalResponse> {
    const q = raw.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!q) return ok({ query: q, results: [], sources: {}, mode: 'lyrics', ms: 0 });
    const t0 = performance.now();
    const meter = this.searchMeter();
    const c: Ctx = { meter };
    let hits;
    try {
      hits = await this.genius.searchLyrics(q, c);
    } catch (e) {
      return this.identifyFailure(e, 'lyrics');
    }
    const tagged = hits.map((h) => ({ ...h, evidence: { kind: 'lyrics', snippet: h.snippet, ranges: h.ranges } as Evidence }));
    const { results, unplayable } = await resolveHits(tagged, this.searchersForIdentify(), c);
    return ok({
      query: q, mode: 'lyrics', results, ms: Math.round(performance.now() - t0), bytes: meter.total,
      sources: { genius: { state: 'ok', count: hits.length }, ...(unplayable ? { unplayable: { state: 'skipped', count: unplayable } } : {}) },
      named: hits.length, unplayable,
    });
  }

  private async identifyAudio(body: Dict): Promise<LocalResponse> {
    const uri = String(body['signature'] ?? '');
    const ms = Number(body['ms']);
    if (!uri.startsWith('data:audio/vnd.shazam.sig;base64,') || uri.length > 400_000) return fail(400, 'That is not a fingerprint.', { code: 'bad_request' });
    if (!Number.isFinite(ms) || ms < 1000 || ms > 30_000) return fail(400, 'The clip length is not valid.', { code: 'bad_request' });
    const t0 = performance.now();
    const meter = this.searchMeter();
    const c: Ctx = { meter };
    let hit;
    try {
      hit = await this.shazam.identify(uri, ms, c);
    } catch (e) {
      return this.identifyFailure(e, 'audio');
    }
    if (!hit) return ok({ query: '', mode: 'audio', results: [], sources: { shazam: { state: 'ok', count: 0 } }, ms: Math.round(performance.now() - t0), bytes: meter.total, named: 0, unplayable: 0 });
    const { results, unplayable } = await resolveHits([{ ...hit, evidence: { kind: 'audio', offset: hit.offset } as Evidence }], this.searchersForIdentify(), c);
    return ok({
      query: `${hit.artist} ${hit.title}`, mode: 'audio', results, ms: Math.round(performance.now() - t0), bytes: meter.total,
      sources: { shazam: { state: 'ok', count: 1 }, ...(unplayable ? { unplayable: { state: 'skipped', count: unplayable } } : {}) },
      named: 1, unplayable, heard: { title: hit.title, artist: hit.artist },
    });
  }

  private async resolve(raw: string): Promise<LocalResponse> {
    const meter = this.searchMeter();
    const t0 = performance.now();
    const c: Ctx = { meter };
    let track: Dict;
    try {
      let url: string;
      try {
        url = normaliseUrl(raw.slice(0, 2000));
      } catch (e) {
        if (e instanceof BlockedUrl) throw e;
        return ok({ kind: 'error', error: 'unresolved', message: 'That does not look like a music link. Search for the song by name instead.' }, 422);
      }
      const name = providerForUrl(url);
      const p = { deezer: this.dz, ytmusic: this.ytm, soundcloud: this.sc, spotify: this.sp }[name];
      track = (await p.resolveLink(url, c)) as Dict;
    } catch (e) {
      if (e instanceof NeedsChoice) {
        const p: Dict = { ...e.payload };
        p['tracks'] = ((p['tracks'] as Dict[]) ?? []).map(cleanTrack);
        return ok({ kind: 'choice', choice: e.kind, message: e.message, ...p });
      }
      if (e instanceof BlockedUrl) return ok({ kind: 'error', error: 'blocked', message: e.message }, 400);
      if (e instanceof ProviderError || e instanceof FetchError) return ok({ kind: 'error', error: 'unresolved', message: e.message }, 422);
      return ok({ kind: 'error', error: 'unresolved', message: `Could not read that link (${(e as Error).name}).` }, 422);
    }
    const out: Dict = { kind: 'track', track: cleanTrack(track), ms: Math.round(performance.now() - t0) };
    if (track['incomplete'] || !(track['artists'] as string[] | undefined)?.length) {
      let options: Dict[] = [];
      try {
        options = [...(await this.dz.search(track['title'], 6, c)), ...(await this.ytm.search(track['title'], 6, c))] as Dict[];
      } catch {
        options = [];
      }
      return ok({
        kind: 'choice', choice: 'artist',
        message: `Spotify identified “${track['title']}” but not its artist. Pick the matching song or type the artist.`,
        track: cleanTrack(track), tracks: this.dedupe([options]).slice(0, 10).map(cleanTrack),
      });
    }
    if (track['warning']) out['warning'] = track['warning'];
    return ok(out);
  }

  private async completeSpotify(title: string, artist: string): Promise<Dict> {
    const t = title.slice(0, 200);
    const a = artist.slice(0, 200);
    const c: Ctx = { meter: this.searchMeter() };
    const base = { title: t, artists: [a], duration: null, version: null };
    const options = [...(await this.dz.search(`${a} ${t}`, 8, c)), ...(await this.ytm.search(`${a} ${t}`, 8, c))] as Dict[];
    const good = options.filter((x) => matchRecordings(base as never, x as never).verdict !== 'different');
    return { tracks: this.dedupe([good.length ? good : options]).slice(0, 10).map(cleanTrack) };
  }

  // ---- seeds / settings ----------------------------------------------------------------
  private async putSeeds(body: Dict): Promise<LocalResponse> {
    const seeds = body['seeds'] ?? [];
    if (!Array.isArray(seeds)) return fail(400, 'seeds must be a list.');
    const out: Dict[] = [];
    const keys = new Set<string>();
    for (const t of seeds as Dict[]) {
      if (!t || typeof t !== 'object' || !t['key'] || !t['provider'] || !t['platform_id']) return fail(400, 'Each seed needs a provider, id and key.');
      if (keys.has(t['key'])) continue;
      keys.add(t['key']);
      const c = cleanTrack(t);
      c['emphasis'] = Math.min(2, Math.max(0.5, Number(t['emphasis'] ?? 1)));
      out.push(c);
    }
    await this.store.setSeeds(out);
    return ok(this.seedsView());
  }

  /**
   * The starting songs, and the saved list they came from when one was sent to the now playing queue
   * (PLAYLIST-QUEUE-001). `can_restore` says the queue it replaced is held and can come back.
   */
  private seedsView(): Dict {
    const pl = this.store.get<{ id: string; name: string }>(QUEUE_PLAYLIST_KEY);
    // GENRE-LOAD-001: a starting song with no tags of its own is shown with what is already known of it.
    const known = this.knownGenres();
    // TAGS-ALWAYS-001: or with genres looked up for it in the background (a starting song nothing knew).
    const found = this.store.get<Record<string, Tag[]>>(SAVED_TAGS_KEY) ?? {};
    const tagged = (this.store.seeds() as Dict[]).map((t) => {
      if (((t['tags'] as unknown[] | undefined) ?? []).length) return t;
      const tags = known(t);
      if (tags.length) return { ...t, tags };
      const looked = found[String(t['key'])];
      return looked?.length ? { ...t, tags: looked } : t;
    }).map((t) => this.withDate(t));
    if (tagged.some((t) => this.savedWants(t))) this.kickSavedGenres();
    // GENRE-ALL-001: and with a main genre and a subgenre, like every row of the queue.
    const fill = this.genreFiller(((this.store.get<Dict>('last_result')?.['items'] ?? []) as Dict[]), tagged);
    const seeds = tagged.map((t) => ({ ...t, characteristics: fill(t, characteristicsOf(t, null)) }));
    return { seeds, playlist: pl ? { id: pl.id, name: pl.name } : null, can_restore: (this.store.get(QUEUE_SAVED_KEY) ?? null) !== null };
  }

  /** Every track the engine holds a copy of, by key: feedback rows, the list, starting songs. */
  private knownTracks(): Map<string, Dict> {
    const byKey = new Map<string, Dict>();
    // Songs a list was made with (an album saved as a list); any fresher copy below replaces them.
    const held = this.store.get<Record<string, Dict>>(LIST_TRACKS_KEY) ?? {};
    for (const [k, t] of Object.entries(held)) byKey.set(k, t);
    // SAVED-GENRES-001: carry an imported copy's confirmed facts through later catalogue copies.
    // IMPORTED-LIST-SOURCE-001: a catalogue match must not replace the file the listener actually
    // added to the list. The list's imported copy owns its source; other copies can lend album facts.
    const put = (k: string, t: Dict) => {
      const prev = byKey.get(k);
      const file = held[k];
      const source = file?.['provider'] === 'imported' && typeof file['url'] === 'string' && file['url'].startsWith('imported:')
        ? withAlbumOf(file, t) : t;
      byKey.set(k, withImportFactsOf(withImportFactsOf(withAlbumOf(source, prev), prev), file));
    };
    for (const r of this.store.feedback()) if (r.track) put(r.key, r.track as Dict);
    for (const it of (this.store.get<Dict>('last_result')?.['items'] ?? []) as { track: Dict }[]) {
      if (it.track) put(String(it.track['key']), it.track);
    }
    for (const s of this.store.seeds() as Dict[]) put(String(s['key']), s);
    return byKey;
  }

  /**
   * PLAYLIST-QUEUE-001: a saved list takes the place of the now playing queue. Every song in it becomes
   * a starting song (in the list's order, equal emphasis), the songs discovered for the old queue go,
   * and the old queue is held so it can be brought back. Switching from one list straight to another
   * keeps the listener's own queue as the one to restore. Nothing changes when the list cannot be used.
   */
  private async queueFromPlaylist(id: string): Promise<LocalResponse> {
    const list = this.storedPlaylists().find((l) => l.id === id);
    if (!list) return fail(404, 'That list no longer exists.');
    const known = this.knownTracks();
    const seeds: Dict[] = [];
    let missing = 0;
    for (const e of list.entries) {
      const t = known.get(e.key);
      if (!t || !t['provider'] || !t['platform_id']) {
        missing++;
        continue;
      }
      seeds.push({ ...cleanTrack(t), key: e.key, emphasis: 1 });
    }
    if (!seeds.length) return fail(400, list.entries.length ? 'None of the songs in this list can be looked up any more.' : 'This list is empty. Save some songs to it first.');
    for (const j of this.jobs.values()) j.token.cancel('a saved list replaced the now playing queue');
    if ((this.store.get(QUEUE_SAVED_KEY) ?? null) === null) {
      await this.store.put(QUEUE_SAVED_KEY, { seeds: this.store.seeds(), last_result: this.store.get('last_result') });
    }
    await this.store.setSeeds(seeds);
    await this.store.put(QUEUE_PLAYLIST_KEY, { id: list.id, name: list.name, at: unixNow() });
    await this.store.put(SEED_CURSOR_KEY, 0);
    this.dropDiscoveries();
    return ok({ ...this.seedsView(), missing });
  }

  /**
   * QUEUE-ADD-001: a song the listener added goes into the now playing queue right after `after` (the
   * song playing), or at the top, and is kept there: the stored list is what a reload brings back, and a
   * discovery batch only appends to it. A song already queued is moved, never repeated.
   */
  private async queueAdd(body: Dict): Promise<LocalResponse> {
    const item = body['item'] as Dict | undefined;
    const track = item?.['track'] as Dict | undefined;
    if (!item || !track || typeof track['key'] !== 'string' || !track['key']) return fail(400, 'Which song?');
    const key = String(track['key']);
    const after = typeof body['after'] === 'string' ? body['after'] : null;
    const last = this.store.get<Dict>('last_result') ?? { phase: 'final', items: [], count: 0, asked: 0, sources: {}, audio: {}, timings: {}, transfer: {} };
    const rest = ((last['items'] ?? []) as Dict[]).filter((x) => String((x['track'] as Dict)['key']) !== key);
    const i = after ? rest.findIndex((x) => String((x['track'] as Dict)['key']) === after) : -1;
    // GENRE-LOAD-001: a song the listener adds never went through a discovery run, so its genres are
    // worked out here from what is already known. What is not known is looked up by /api/queue/genres.
    const added = this.withKnownGenres({ items: [{ ...item, added: true }] })['items'][0] as Dict;
    const items = [...rest.slice(0, i + 1), added, ...rest.slice(i + 1)].map((x, n) => ({ ...x, rank: n + 1 }));
    const next = { ...last, items, count: items.length, saved_at: last['saved_at'] ?? unixNow() };
    await this.store.put('last_result', next);
    return ok(this.completed(next));
  }

  // ---- genres for the rows that have none (GENRE-LOAD-001) -------------------------------
  /** A row is placed once its characteristics name a genre or a family. */
  private static placed(item: Dict): boolean {
    const c = item['characteristics'] as Dict | undefined;
    return Boolean(c && (((c['genres'] as unknown[] | undefined) ?? []).length || c['family']));
  }

  /** Placed by a guess of ours alone ("pop, lent by the starting song"): shown, and still worth asking about. */
  private static guessed(item: Dict): boolean {
    const tags = ((item['track'] as Dict | undefined)?.['tags'] as Tag[] | undefined) ?? [];
    return tags.length > 0 && tags.every((g) => g?.inferred);
  }

  /**
   * What is already known of a song's genres, with no request: its own tags, what the services said
   * when it was a starting song, what MusicBrainz's listeners call its artist, and only then a guess
   * from the artist's other songs.
   */
  private knownGenres(): (t: Dict) => Tag[] {
    const own = this.genresOfTrack();
    return (t: Dict): Tag[] => {
      const got = own(t);
      if (got.some((g) => !g.inferred)) return got;
      const artist = (this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {})[fold(artistName(t))]?.tags ?? [];
      return artist.length ? artist : got;
    };
  }

  /** The row with its genres worked out from `tags`; everything else it carries is kept. */
  private labelled(item: Dict, tags: Tag[], taste: TasteProfile | null): Dict {
    const track = { ...(item['track'] as Dict), tags };
    return { ...item, track, characteristics: { ...((item['characteristics'] as Dict | undefined) ?? {}), ...characteristicsOf(track, taste) } };
  }

  /** A stored queue with every unplaced row given what is already known about it. Asks nothing. */
  private withKnownGenres(result: Dict): Dict {
    const items = (result['items'] ?? []) as Dict[];
    if (items.every((x) => LocalApi.placed(x))) return result;
    const known = this.knownGenres();
    let taste: TasteProfile | undefined;
    const next = items.map((item) => {
      if (LocalApi.placed(item) || !item['track']) return item;
      const tags = known(item['track'] as Dict);
      return tags.length ? this.labelled(item, tags, (taste ??= this.taste())) : item;
    });
    return { ...result, items: next };
  }

  // ---- a main genre and a subgenre on every row (GENRE-ALL-001) --------------------------
  private static yearOf(t: Dict): number | null {
    const d = (t['release'] as Dict | undefined)?.['date'];
    const y = typeof d === 'string' ? Number(d.slice(0, 4)) : NaN;
    return Number.isFinite(y) && y > 1900 ? y : null;
  }

  /**
   * Whether a song has a main genre and nothing finer, and its artist is still worth a look: the
   * artist's subgenres are remembered and not yet on the song, or its style words were never asked
   * for (or were remembered before they were kept; that answer is still in the cache).
   */
  private wantsArtist(track: Dict): boolean {
    const tags = (track['tags'] as Tag[] | undefined) ?? [];
    if (!mainGenre(tags)) return false;
    const name = artistName(track);
    const k = fold(name);
    if (!k || name.length > 80) return false;
    const known = (this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {})[k];
    if (subLabels(tags).length || stylesFor(tags, known?.styles).length) return false;
    if (known?.styles !== undefined) return needsSub(tags) && known.tags.length > 0;
    return !this.store.cacheGet(`styletry:${k}`)?.value;
  }

  /** Whether a song with a main genre and no subgenre has no year yet, and Deezer has not been asked for one. */
  private wantsYear(track: Dict): boolean {
    const tags = (track['tags'] as Tag[] | undefined) ?? [];
    if (!mainGenre(tags) || LocalApi.yearOf(track) || typeof track['year_hint'] === 'number') return false;
    const known = (this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {})[fold(artistName(track))];
    if (subLabels(tags).length || stylesFor(tags, known?.styles).length) return false;
    return !this.store.cacheGet(`yeartry:${String(track['key'] ?? '')}`)?.value;
  }

  /**
   * What each row is shown with beyond its own tags: the style words its artist is known for, and
   * whatever it still lacks of "a main genre and a subgenre", filled from what is known and marked
   * with where it came from (genre-fill.ts). Worked out when a list is sent, never stored, so it
   * always reflects what is known now. `genre_pending` tells the page a lookup can still improve it.
   */
  private genreFiller(items: Dict[], seeds: Dict[] = this.store.seeds() as Dict[]): (track: Dict, chars: Dict) => Dict {
    const subs = this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {};
    const artistGenres = this.store.get<Record<string, Record<string, number>>>('artist_genres') ?? {};
    const tagsOf = (t: Dict): Tag[] => [...currentTags((t['tags'] as Tag[] | undefined) ?? [])];
    const stylesOf = (t: Dict): string[] => stylesFor(tagsOf(t), subs[fold(artistName(t))]?.styles);
    const list = [...seeds, ...items.map((x) => x['track'] as Dict)].filter(Boolean).map((t) => ({ tags: tagsOf(t), styles: stylesOf(t), year: LocalApi.yearOf(t) }));
    return (track, chars) => {
      const tags = tagsOf(track);
      const styles = stylesOf(track);
      const bpm = typeof track['bpm'] === 'number' ? (track['bpm'] as number) : null;
      const yearHint = typeof track['year_hint'] === 'number' ? (track['year_hint'] as number) : null;
      const fill = fillGenres({ tags, styles, year: LocalApi.yearOf(track), yearHint, bpm, artist: artistName(track), artistGenres, list });
      const main = mainGenre(tags);
      const unplaced = !tags.some((g) => g && !g.inferred);
      const pending = unplaced ? !this.store.cacheGet(`genretry:${String(track['key'] ?? '')}`)?.value : this.wantsArtist(track) || this.wantsYear(track);
      return { ...chars, styles, fill, ...(main && !main.onPicker ? { main_off: main.label } : {}), ...(pending ? { genre_pending: true } : {}) };
    };
  }

  /** A list as it is sent to the page: every row with its styles and fills (see genreFiller). */
  private completed(result: Dict): Dict {
    const items = (result['items'] ?? []) as Dict[];
    if (!items.length) return result;
    // NAMESAKE-001: a row saved with a namesake's artist tags, or a subgenre the table has since
    // corrected, is re-read with today's tags; its sound and fit measurements are kept.
    const now = items.map((x) => {
      const t = x['track'] as Dict | undefined;
      const tags = (t?.['tags'] as Tag[] | undefined) ?? [];
      const clean = currentTags(tags);
      if (!t || clean === tags) return x;
      const track = { ...t, tags: clean };
      const fresh = characteristicsOf(track, null);
      const old = (x['characteristics'] as Dict | undefined) ?? {};
      return { ...x, track, characteristics: { ...old, family: fresh['family'], subgenre: fresh['subgenre'], families: fresh['families'], color: fresh['color'], genres: fresh['genres'] } };
    });
    const fill = this.genreFiller(now);
    return { ...result, items: now.map((x) => (x['track'] ? { ...x, characteristics: fill(x['track'] as Dict, (x['characteristics'] as Dict | undefined) ?? {}) } : x)) };
  }

  /** Ask MusicBrainz what its listeners call an artist; a failure is not retried for a while, so the looking ends. */
  private async askArtist(track: Dict, meter: Meter): Promise<void> {
    const artist = artistName(track);
    try {
      await lookupArtistSubs(this.store, this.http, artist, { meter }, (key, fn) => cached(this.store, key, 'metadata', 30 * 24 * 3600, fn) as Promise<never>, unixNow());
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      await this.store.cachePut(`styletry:${fold(artist)}`, 'metadata', true, 6 * 3600);
    }
  }

  // ---- IMPORT-GENRES-001: imported songs' genres, cover and length ------------------------

  /** Pause between two imported songs looked up in the background, so a big folder never floods a service. */
  importedGenresGapMs = 400;
  private importedGenresRun: Promise<void> | null = null;

  /** Imported songs held for saved lists that have no genre yet, can be looked up, and were not tried lately. */
  private importedWanting(): Dict[] {
    const held = this.store.get<Record<string, Dict>>(LIST_TRACKS_KEY) ?? {};
    const inLists = new Set(this.storedPlaylists().flatMap((l) => l.entries.map((e) => e.key)));
    return Object.entries(held)
      .filter(([k, t]) => inLists.has(k) && t?.['provider'] === 'imported' && !t['catalogue_match'] && !statedTags(t).length && canMatch(t) && !this.store.cacheGet(`importtry:${k}`)?.value)
      .map(([, t]) => t);
  }

  /** Start, once, the background lookup of every imported song still without a genre. No route awaits it. */
  private kickImportedGenres(): void {
    if (this.importedGenresRun) return;
    this.importedGenresRun = this.importedGenresLoop()
      .catch(() => undefined)
      .finally(() => { this.importedGenresRun = null; });
  }

  /** Resolves once no background lookup of imported songs is running. */
  async importedGenresSettled(): Promise<void> {
    while (this.importedGenresRun) await this.importedGenresRun;
  }

  /** One song at a time, each answer saved on the list's copy at once, so the page fills in as it goes. */
  private async importedGenresLoop(): Promise<void> {
    for (let n = 0; n < 2000; n++) {
      const next = this.importedWanting()[0];
      if (!next) return;
      const key = String(next['key']);
      let found: Dict | null = null;
      let ttl = 7 * 24 * 3600; // no confident match: not asked again for a week
      try {
        found = await this.lookUpImported(next, this.searchMeter());
        if (found) ttl = 30 * 24 * 3600;
      } catch (e) {
        if (e instanceof BudgetExceeded) return; // the day's allowance is spent: the next start carries on
        ttl = 6 * 3600; // a service failed: try again later
      }
      await this.store.cachePut(`importtry:${key}`, 'metadata', true, ttl);
      if (found) {
        const held = { ...(this.store.get<Record<string, Dict>>(LIST_TRACKS_KEY) ?? {}) };
        if (held[key]) {
          held[key] = found;
          await this.store.put(LIST_TRACKS_KEY, held);
        }
      }
      if (this.importedGenresGapMs > 0) await new Promise((r) => setTimeout(r, this.importedGenresGapMs));
    }
  }

  /**
   * The song as a confident Deezer match describes it, or null when there is none: the album's
   * genres (MusicBrainz's subgenres for the artist when no finer genre is stated, the queue's own
   * GENRE-ALL-001 step), the cover and the length. The playback link stays the file.
   */
  private async lookUpImported(song: Dict, meter: Meter): Promise<Dict | null> {
    const c: Ctx = { meter };
    const q = `${String(((song['artists'] as unknown[]) ?? [])[0] ?? '')} ${String(song['title'] ?? '')}`.trim();
    const hit = confidentMatch(song as never, await this.dz.search(q, 10, c));
    if (!hit) return null;
    const full = await this.dz.withGenres(await this.dz.track(String(hit.match.platform_id), c), c);
    let out: Dict = enrichImported(song, { tags: (full.tags as Tag[]) ?? [], artwork: full.artwork, duration: full.duration }, song['file_genre']);
    out['catalogue_match'] = { provider: 'deezer', id: String(hit.match.platform_id), proven: hit.proven };
    const rel = (full as Dict)['release'] as Dict | undefined;
    out = LocalApi.dated(out, { release: typeof rel?.['date'] === 'string' ? rel : null, proven: hit.proven });
    if (statedTags(out).length && this.wantsArtist(out)) {
      if ((this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {})[fold(artistName(out))]?.styles === undefined) await this.askArtist(out, meter);
      out = withArtistSubs(out, this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {});
      // TAGS-CANON-001: the artist's words may repeat a genre the album named ("hip hop" beside "Rap/Hip Hop").
      out = { ...out, tags: uniqueTags((out['tags'] as Tag[] | undefined) ?? []) };
    }
    return out;
  }

  /**
   * Look up the genres of the queue's rows that still have none, a few at a time: the song's album
   * genre on Deezer (finding the song there first when it came from another service), then what
   * MusicBrainz's listeners call its artist. Every answer is cached and charged to the day's
   * allowance. A song nothing could place is not asked about again for a day, so the looking ends.
   */
  private async queueGenres(body: Dict): Promise<LocalResponse> {
    const last = this.store.get<Dict>('last_result');
    const items = ((last?.['items'] ?? []) as Dict[]).slice();
    const more = (t: Dict): boolean => this.wantsArtist(t) || this.wantsYear(t);
    const settled = (x: Dict): boolean => LocalApi.placed(x) && !LocalApi.guessed(x) && !more((x['track'] as Dict | undefined) ?? {});
    if (!last || items.every(settled)) return ok({ items: [], left: 0 });
    const limit = Math.max(1, Math.min(12, Math.trunc(Number(body['limit'])) || 6));
    const known = this.knownGenres();
    const meter = this.searchMeter();
    const taste = this.taste();
    // What each row shows now, to tell afterwards which rows changed.
    const shown = (list: Dict[]): string[] => {
      const fill = this.genreFiller(list);
      return list.map((x) => {
        const c = x['track'] ? fill(x['track'] as Dict, {}) : {};
        return JSON.stringify([(x['track'] as Dict | undefined)?.['tags'] ?? [], c['styles'], c['fill'], c['main_off'] ?? null, c['genre_pending'] ?? false]);
      });
    };
    const before = shown(items);
    let asked = 0;
    let left = 0;
    let spent = false;
    let stored = false;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const track = item['track'] as Dict | undefined;
      if (settled(item) || !track) continue;
      const key = String(track['key'] ?? '');
      const had = LocalApi.placed(item);
      let counted = false;
      let waiting = false;
      /** One look per row and call, however many services it takes; false when this call may ask no more. */
      const mayAsk = (): boolean => {
        if (counted) return true;
        if (spent || asked >= limit) return false;
        asked += 1;
        counted = true;
        return true;
      };
      let tags = known(track);
      let dated = track;
      try {
        if (!tags.some((g) => !g.inferred) && !this.store.cacheGet(`genretry:${key}`)?.value) {
          if (!mayAsk()) waiting = true;
          else {
            const found = await this.lookUpGenres(track, meter);
            await this.store.cachePut(`genretry:${key}`, 'metadata', true, 24 * 3600);
            await this.store.cachePut(`yeartry:${key}`, 'metadata', true, 30 * 24 * 3600);
            dated = found.track;
            if (found.tags.length) tags = found.tags;
          }
        }
        // GENRE-ALL-001: a main genre and nothing finer. Ask what MusicBrainz's listeners call the
        // artist (once), and put the subgenres they name on the song.
        if (!waiting && this.wantsArtist({ ...dated, tags })) {
          const k = fold(artistName(track));
          if ((this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {})[k]?.styles === undefined) {
            if (!mayAsk()) waiting = true;
            else await this.askArtist(track, meter);
          }
          if (!waiting) tags = ((withArtistSubs({ ...dated, tags }, this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY) ?? {}) as Dict)['tags'] as Tag[]) ?? tags;
        }
        // Still nothing finer: the year the song came out names its era. Deezer states it.
        if (!waiting && this.wantsYear({ ...dated, tags })) {
          if (!mayAsk()) waiting = true;
          else {
            await this.store.cachePut(`yeartry:${key}`, 'metadata', true, 30 * 24 * 3600);
            try {
              dated = LocalApi.dated(dated, await this.deezerFacts(track, { meter }));
            } catch (e) {
              if (e instanceof BudgetExceeded) throw e;
            }
          }
        }
      } catch (e) {
        // The allowance is used up: say what is left rather than guess, and ask no more this time.
        if (!(e instanceof BudgetExceeded)) throw e;
        spent = true;
        waiting = true;
      }
      if (waiting) left += 1;
      const newTags = tags.length > 0 && !(had && !tags.some((g) => !g.inferred)) && JSON.stringify(tags) !== JSON.stringify(track['tags'] ?? []);
      if (!newTags && dated === track) continue;
      // Nothing new in the tags of a row already showing its guess: only its year is kept.
      items[i] = newTags ? this.labelled({ ...item, track: dated }, tags, taste) : this.labelled({ ...item, track: dated }, (track['tags'] as Tag[] | undefined) ?? [], taste);
      stored = true;
    }
    if (stored) await this.store.put('last_result', { ...last, items });
    // Every row that now shows something else: the ones looked up, and any whose estimate moved with them.
    const after = shown(items);
    const fill = this.genreFiller(items);
    const out: Dict[] = [];
    items.forEach((x, i) => {
      const track = x['track'] as Dict | undefined;
      if (!track || after[i] === before[i]) return;
      out.push({ key: String(track['key'] ?? ''), tags: track['tags'] ?? [], characteristics: fill(track, (x['characteristics'] as Dict | undefined) ?? {}) });
    });
    return ok({ items: out, left, ...(spent ? { spent: true } : {}) });
  }

  /**
   * What Deezer states about a song: its album's genres and its release date. `proven` says the
   * Deezer song is this recording; a row with no length can only be matched by title and artist,
   * which is enough for the kind of music and its era but is not claimed as this song's own date.
   */
  private async deezerFacts(track: Dict, c: Ctx): Promise<{ tags: Tag[]; release: Dict | null; proven: boolean }> {
    let did = track['provider'] === 'deezer' ? String(track['platform_id'] ?? '') : String(((track['links'] as Dict | undefined)?.['deezer'] as Dict | undefined)?.['id'] ?? '');
    let proven = Boolean(did);
    if (!did) {
      const found = await this.dz.findMatch(track as never, c);
      proven = Boolean(found.match);
      const same = found.match ?? found.uncertain.find((u) => (u as Dict)['match_note'] === NO_LENGTH) ?? null;
      did = String(same?.platform_id ?? '');
    }
    if (!did) return { tags: [], release: null, proven: false };
    const full = await this.dz.withGenres(await this.dz.track(did, c), c);
    const rel = (full as Dict)['release'] as Dict | undefined;
    return { tags: (full.tags as Tag[]).filter((g) => g && typeof g.name === 'string'), release: typeof rel?.['date'] === 'string' ? rel : null, proven };
  }

  /** The track with a release year Deezer stated: its own date when proven, a marked hint otherwise. */
  private static dated(track: Dict, facts: { release: Dict | null; proven: boolean }): Dict {
    if (!facts.release || LocalApi.yearOf(track)) return track;
    if (facts.proven) return { ...track, release: facts.release };
    const y = Number(String(facts.release['date']).slice(0, 4));
    return Number.isFinite(y) && y > 1900 ? { ...track, year_hint: y } : track;
  }

  /** The genres of a song nothing has placed, and its year: Deezer first, then MusicBrainz's word for the artist. */
  private async lookUpGenres(track: Dict, meter: Meter): Promise<{ tags: Tag[]; track: Dict }> {
    const c: Ctx = { meter };
    let dated = track;
    try {
      const facts = await this.deezerFacts(track, c);
      dated = LocalApi.dated(track, facts);
      if (facts.tags.length) return { tags: facts.tags, track: dated };
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
    }
    const artist = artistName(track);
    if (!artist || artist.length > 80) return { tags: [], track: dated };
    try {
      const tags = await lookupArtistSubs(this.store, this.http, artist, { meter }, (key, fn) => cached(this.store, key, 'metadata', 30 * 24 * 3600, fn) as Promise<never>, unixNow());
      return { tags, track: dated };
    } catch (e) {
      if (e instanceof BudgetExceeded) throw e;
      return { tags: [], track: dated };
    }
  }

  /** Bring back the queue a saved list replaced: its starting songs and the songs discovered for it. */
  private async restoreQueue(): Promise<LocalResponse> {
    const held = this.store.get<{ seeds: Dict[]; last_result: Dict | null }>(QUEUE_SAVED_KEY);
    if (!held) return fail(409, 'There is no earlier queue to bring back.');
    for (const j of this.jobs.values()) j.token.cancel('the earlier queue was restored');
    this.dropDiscoveries();
    await this.store.setSeeds(held.seeds ?? []);
    if (held.last_result) await this.store.put('last_result', held.last_result);
    this.store.drop(QUEUE_SAVED_KEY);
    this.store.drop(QUEUE_PLAYLIST_KEY);
    await this.store.put(SEED_CURSOR_KEY, 0);
    return ok(this.seedsView());
  }

  /** The songs discovered for the current queue, and everything a re-rank would compare against. */
  private dropDiscoveries(): void {
    this.store.drop('last_result');
    this.pool = null;
    this.store.drop('last_pool');
    this.store.drop('discovery_events');
  }

  /**
   * A song's genres from whichever source knows them: its own tags, then what the services said
   * when it was a starting song, then its artist's other songs. [] when none of them does, so a
   * mix can say honestly how much of a list or album it could place.
   */
  private genresOfTrack(): (t: Dict) => Tag[] {
    const artists = this.store.get<Record<string, Record<string, number>>>('artist_genres') ?? {};
    return (t: Dict): Tag[] => {
      const own = ((t['tags'] as Tag[] | undefined) ?? []).filter((g) => g && typeof g.name === 'string');
      if (own.length) return own;
      const prof = this.store.cacheGet(`seedprofile:${t['id']}`, true)?.value as Dict | undefined;
      const dzTags = (((prof?.['dz'] as Dict | null)?.['tags'] as Tag[] | undefined) ?? []).filter((g) => g && typeof g.name === 'string');
      if (dzTags.length) return dzTags;
      const guess = inferFromArtist(t, artists);
      return guess ? [guess] : [];
    };
  }

  /** PLAYLIST-MIX-001: a saved list's own listening mix, for the Sound card. */
  private playlistMixRoute(id: string): LocalResponse {
    const list = this.storedPlaylists().find((l) => l.id === id);
    if (!list) return fail(404, 'That list no longer exists.');
    const known = this.knownTracks();
    const tracks = list.entries.map((e) => known.get(e.key)).filter((t): t is Dict => Boolean(t));
    const ownGenres = this.genresOfTrack();
    // IMPORT-GENRES-001: an imported song counts only with genres of its own (a confident match);
    // no guess from a same-named artist colours a list of the listener's own files.
    const genresOf = (t: Dict): Tag[] => (t['provider'] === 'imported' ? statedTags(t) : ownGenres(t));
    // A song the engine holds no copy of still counts as one of the list's songs, just not placed.
    return ok({ id: list.id, name: list.name, ...playlistMix(tracks, genresOf, unixNow()), songs: list.entries.length });
  }

  private async putSettings(body: Dict): Promise<LocalResponse> {
    const cur = this.settings();
    // ALGO-MANAGER-001: algorithms, active_algorithm and the legacy ranking_formula/weights keys.
    try { Object.assign(cur, applyAlgorithmPatch(cur, body)); }
    catch (e) { return fail(400, (e as Error).message); }
    if ('fresh' in body) cur['fresh'] = Boolean(body['fresh']);
    if ('adventurous' in body) cur['adventurous'] = Math.min(1, Math.max(0, Number(body['adventurous'])));
    for (const k of ['audio', 'sample_mode', 'rank_v2', 'discover_while_listening', 'mood_queue']) if (k in body) cur[k] = Boolean(body[k]);
    if ('daily_mb' in body) cur['daily_mb'] = Math.min(2000, Math.max(5, Number(body['daily_mb'])));
    if ('request_mb' in body) cur['request_mb'] = Math.min(200, Math.max(2, Number(body['request_mb'])));
    if ('similar_percent' in body) {
      if (!isSimilarityPercent(body['similar_percent'])) return fail(400, 'similar_percent must be a whole number between 40 and 95');
      cur['similar_percent'] = body['similar_percent'];
    }
    if ('queue_size' in body) {
      const n = Math.round(Number(body['queue_size']));
      if (!Number.isFinite(n) || n < QUEUE_SIZE_MIN || n > QUEUE_SIZE_MAX) return fail(400, `queue_size must be between ${QUEUE_SIZE_MIN} and ${QUEUE_SIZE_MAX}`);
      cur['queue_size'] = n;
    }
    if ('cache_gb' in body) {
      const gb = Number(body['cache_gb']);
      if (!Number.isFinite(gb) || gb < 0.25 || gb > 20) return fail(400, 'cache_gb must be between 0.25 and 20');
      cur['cache_gb'] = gb;
    }
    // 0 means "let the shell pick its own safe default" (a phone's ceiling is lower than a desktop's).
    if ('dl_parallel' in body) {
      const n = Math.round(Number(body['dl_parallel']));
      if (!Number.isFinite(n) || n < 0 || n > 6) return fail(400, 'dl_parallel must be between 0 and 6');
      cur['dl_parallel'] = n;
    }
    if ('preload_target' in body) {
      const t = String(body['preload_target']);
      if (t !== 'all' && t !== 'count') return fail(400, "preload_target must be 'all' or 'count'");
      cur['preload_target'] = t;
    }
    if ('preload_count' in body) {
      const n = Math.round(Number(body['preload_count']));
      if (!Number.isFinite(n) || n < 1 || n > 500) return fail(400, 'preload_count must be between 1 and 500');
      cur['preload_count'] = n;
    }
    // The EQ and the mixer are stored through their own parsers, so a hand-edited or stale value
    // cannot put an out-of-range gain or a NaN slider into the audio graph.
    if ('eq' in body) cur['eq'] = parseEq(body['eq']);
    if ('mix' in body) cur['mix'] = clampSlider(Number(body['mix']));
    if ('play_through' in body) cur['play_through'] = clampPlayThrough(body['play_through']);
    delete cur['ranking_formula']; // derived from the active algorithm on every read, never stored
    await this.store.put('settings', cur);
    return ok(settingsWithAlgorithms(cur));
  }

  // ---- recommend -----------------------------------------------------------------------
  /**
   * Starts one discovery batch. Searching is one way in; finishing a song from a list that has
   * nearly run out is the other, and both add at most `queue_size` songs the list does not hold.
   */
  private recommend(body: Dict = {}): LocalResponse {
    let seeds = this.store.seeds() as Dict[];
    const settings = this.settings();
    const listening = body['trigger'] === 'listening';
    let moodLead: string[] | undefined;
    if (listening) {
      const guard = this.listeningGuard(body, settings);
      if (guard.skip) return ok({ job: null, reason: guard.reason });
      seeds = guard.seeds;
      moodLead = guard.mood;
    }
    if (!seeds.length) return fail(400, 'Add at least one starting song first.');
    if (this.currentJob) this.jobs.get(this.currentJob)?.token.cancel('superseded by a newer request');
    const job = new Job(newId());
    this.jobs.set(job.id, job);
    this.currentJob = job.id;
    for (const [k, j] of this.jobs) if (j.done && unixNow() - j.started > 900) this.jobs.delete(k);
    void this.runJob(job, seeds, settings, listening ? 'listening' : 'search');
    return ok(moodLead ? { job: job.id, mood: moodLead } : { job: job.id });
  }

  /**
   * NEXT-FAV-CUSTOM-001 (owner, 2026-11-19): Find my next favorite with the listener's own criteria (custom-discovery.ts).
   * Found songs go to the end of Now playing, like Find similar's; nothing already there is repeated.
   */
  private discoverCustom(body: Dict): LocalResponse {
    const crit = normaliseCriteria(body['criteria'] as Dict | undefined);
    const exclude = new Set((Array.isArray(body['exclude']) ? body['exclude'] : []).filter((k): k is string => typeof k === 'string').slice(0, 5000));
    if (this.currentJob) this.jobs.get(this.currentJob)?.token.cancel('superseded by a newer request');
    const job = new Job(newId());
    this.jobs.set(job.id, job); this.currentJob = job.id;
    void this.runCustom(job, crit, exclude, this.settings());
    return ok({ job: job.id, criteria: crit });
  }

  private async runCustom(job: Job, crit: CustomCriteria, exclude: Set<string>, settings: Dict): Promise<void> {
    const p = this.pipeline;
    const meter = p.meter(settings); job.meter = meter;
    const c: Ctx = { token: job.token, meter };
    const lastAtStart = this.store.get<Dict>('last_result');
    try {
      job.phase = 'gathering'; job.progress = 'Starting';
      const taste = this.taste();
      const known = new Set<string>();
      for (const s of this.store.seeds() as Dict[]) for (const a of (s['artists'] as string[] | undefined) ?? []) known.add(fold(a));
      for (const r of this.historyRows()) {
        if (!['like', 'save', 'complete', 'replay', 'qualified'].includes(r.kind) || !r.track) continue;
        for (const a of ((r.track as Dict)['artists'] as string[] | undefined) ?? []) known.add(fold(a));
      }
      const previous = ((lastAtStart?.['items'] as Dict[] | undefined) ?? []);
      const excludeSongs = new Set<string>();
      for (const it of previous) {
        const t = it['track'] as Dict | undefined;
        if (typeof t?.['key'] === 'string') exclude.add(t['key']);
        if (t?.['title']) excludeSongs.add(songIdOf(t as { title: string; artists?: string[]; artist?: string }));
      }
      const providers = [
        ['deezer', this.dz], ['ytmusic', this.ytm], ['soundcloud', this.sc], ['bandcamp', this.bandcamp],
        ['audius', this.audius], ['hearthis', this.hearthis], ['internet-archive', this.archive],
      ] as const;
      const usable = (list: NativeTrack[]) => list.filter((t) => Boolean(t?.['key']) && t['kind'] !== 'video') as unknown as CandidateTrack[];
      // Only the artist with exactly this name: a search for a name Deezer lacks answers someone else entirely.
      const dzTopByName = async (name: string): Promise<CandidateTrack[]> => {
        const who = await this.dz.artistByName(name, c);
        return who ? usable(await this.dz.artistTop(who.id, 10, c)) : [];
      };
      const ports: CustomPorts = {
        progress: (s) => { job.progress = s; },
        check: () => job.token.check(),
        openArtist: async (t) => {
          const v = await this.artists.open({ ...(t.id ? { id: t.id } : {}), name: t.name }, c);
          return { name: v.name, songs: v.songs as unknown as CandidateTrack[], features: v.features as unknown as CandidateTrack[], similar: v.similar ?? [] };
        },
        artistTop: async (name, id) => {
          const dz = id && /^dz:\d{1,15}$/.test(id) ? id.slice(3) : null;
          const own = await p.call(job, `custom-top:${name.slice(0, 24)}`, () => (dz ? this.dz.artistTop(dz, 10, c).then(usable) : dzTopByName(name)), [] as CandidateTrack[]);
          if (own.length) return own;
          // Not on Deezer: YouTube Music by name, keeping only songs the artist leads.
          const yt = await p.call(job, `custom-yt:${name.slice(0, 24)}`, () => this.ytm.search(name, 10, c), [] as NativeTrack[]);
          return usable(yt).filter((t) => fold(t.artists?.[0] ?? t.artist ?? '') === fold(name));
        },
        search: async (term, kind) => {
          // A genre's own words only on the catalogue services: on upload sites they match titles, not genres.
          const asked = kind === 'words' ? providers.filter(([name]) => name === 'deezer' || name === 'ytmusic') : providers;
          const lists = await pmap(asked, 3, async ([name, provider]) =>
            p.call(job, `custom-${name}`, () => provider.search(name === 'deezer' && kind === 'artist' ? `artist:"${term.replace(/"/g, ' ')}"` : term, 8, c), [] as NativeTrack[]));
          const out: NativeTrack[] = [];
          for (let i = 0; i < 8; i++) for (const l of lists) if (l[i]) out.push(l[i] as NativeTrack);
          return usable(out);
        },
        related: async (name) => p.call(job, `custom-rel:${name.slice(0, 24)}`, async () => {
          const who = await this.dz.artistByName(name, c);
          return who ? (await this.dz.relatedArtists(who.id, 6, c)).map((a) => ({ name: a.name, id: `dz:${a.id}` })) : [];
        }, [] as { name: string; id?: string }[]),
        enrichGenres: async (tracks) => { await p.enrich(job, tracks as unknown as Dict[], 60); },
      };
      const tasteGenres = taste.events ? this.colourList(taste).slice(0, 4).map((g) => genreIdentity(g.label || g.name)?.key).filter((k): k is string => Boolean(k)) : [];
      const turn = Number(this.store.get<number>('custom_turn') ?? 0) || 0;
      const res = await runCustomDiscovery(crit, ports, { exclude, excludeSongs, known, taste, year: new Date().getFullYear(), tasteGenres, turn });
      await this.store.put('custom_turn', turn + 1);
      job.token.check();
      const current = this.store.get<Dict>('last_result') ?? lastAtStart ?? { phase: 'final', items: [], count: 0, asked: 0, sources: {}, audio: {}, timings: {}, transfer: {} };
      const before = (current['items'] as Dict[] | undefined) ?? [];
      const have = new Set(before.map((it) => (it['track'] as Dict | undefined)?.['key']));
      const fresh = res.picked.filter((pk) => !have.has(pk.track.key));
      const items = fresh.map((pk, i) => {
        const track = pk.track as unknown as Dict;
        return {
          rank: before.length + i + 1, track: cleanTrack(track), score: round(pk.score, 3), coverage: 1, tier: 'related', evidence: 'moderate',
          reasons: [{ factor: 'custom', weight: round(pk.score, 3), text: pk.reason }],
          uncertainty: [], new_release: false, factors: { custom: round(pk.score, 3) }, weights: { custom: 1 },
          sources: [String(track['provider'])], playback: playbackFor(track), characteristics: characteristicsOf(track, taste), added: true, custom: true,
        };
      });
      const next = this.withKnownGenres({ ...current, phase: 'final', items: [...before, ...items], count: before.length + items.length, saved_at: unixNow() });
      job.token.check();
      if (items.length) await this.store.put('last_result', next);
      job.result = {
        added: items.length, asked: crit.count, candidates: res.candidates, missed: res.missed,
        reason: customOutcome(items.length, crit.count, job.sources as Record<string, { state: string }>, res.missed),
        queue: items.length ? this.completed(next) : null, sources: job.sources,
      };
    } catch (e) { job.error = e instanceof Cancelled ? 'cancelled' : (e as Error).message || 'Custom discovery failed.'; }
    finally { job.done = true; job.phase = job.error ? (job.error === 'cancelled' ? 'cancelled' : 'failed') : 'done'; }
  }

  /** SIMILAR-SOUND-001: one song in a list, one calibrated audio threshold, every full-song source.
   * Unlike a general recommendation, a metadata-only candidate can NEVER pass the match threshold.
   * Only vetted providers supply tracks; their *own* full-song playback link is preserved.
   */
  private similar(body: Dict): LocalResponse {
    const seed = body['track'] as Dict | undefined;
    if (!seed || typeof seed['key'] !== 'string' || !seed['key'] || !seed['title'] || !(seed['artists'] as unknown[])?.length) return fail(400, 'Choose a song from a list first.');
    const settings = this.settings();
    if (!isSimilarityPercent(settings['similar_percent'])) return fail(400, 'Set a whole-number sound match from 40 to 95% in Settings.');
    if (this.currentJob) this.jobs.get(this.currentJob)?.token.cancel('superseded by a newer request');
    // MOOD-QUEUE-001: asking for songs that sound like this one is the strongest mood signal there is.
    this.noteMood(seed, 'similar');
    const job = new Job(newId());
    this.jobs.set(job.id, job); this.currentJob = job.id;
    void this.runSimilar(job, seed, settings);
    return ok({ job: job.id });
  }

  /**
   * Put the found songs at the end of the queue. SIMILAR-MIN-001 (owner, 2026-11-19): "find similar song
   * should at bare minimum find 3 similar songs". Songs at the chosen sound match come first; when fewer
   * than three reach it, the closest measured songs below it make up three, each saying its real
   * percentage; when even that is short (no audio to compare), related songs from the same search fill
   * in, each saying its sound was not compared. Nothing already in the list is repeated.
   */
  private async addSimilar(job: Job, sv: Dict, threshold: number, hits: SoundHit<SoundTrack>[], candidates: Dict[], lastAtStart: Dict | null | undefined, unmeasuredNote: string): Promise<void> {
    const current = this.store.get<Dict>('last_result') ?? lastAtStart ?? { phase: 'final', items: [], count: 0, asked: 0, sources: {}, audio: {}, timings: {}, transfer: {} };
    const previous = (current['items'] as Dict[] | undefined) ?? [];
    const existing = previous.map((it) => it['track'] as SoundTrack);
    const matches: (SoundHit<SoundTrack> & { unmeasured?: boolean })[] = selectSimilar(sv as SoundTrack, existing, hits, threshold);
    if (matches.length < SIMILAR_FLOOR) {
      const taken = [sv as SoundTrack, ...existing, ...matches.map((m) => m.track)];
      for (const t of candidates as SoundTrack[]) {
        if (matches.length >= SIMILAR_FLOOR) break;
        if (taken.some((x) => x.key === t.key || matchRecordings(x, t).verdict === 'same')) continue;
        matches.push({ track: t, match: NaN, unmeasured: true });
        taken.push(t);
      }
    }
    const seedTitle = String(sv['title']);
    const freshItems = matches.map(({ track, match, below, unmeasured }, i) => ({
      rank: previous.length + i + 1, track: cleanTrack(track as Dict), score: unmeasured ? 0 : match / 100, coverage: unmeasured ? 0 : 1,
      tier: 'related', evidence: unmeasured ? 'weak' : below ? 'moderate' : 'strong', best_seed: { key: sv['key'], title: sv['title'], artist: (sv['artists'] as string[])[0] },
      reasons: [{ factor: unmeasured ? 'related' : 'audio', weight: unmeasured ? 0 : match / 100, text: unmeasured
        ? `Related to “${seedTitle}” by ${String(track['provider'])}; its sound could not be compared.`
        : below ? `${match}% calibrated sound match to “${seedTitle}” (DCLAP audio vectors): one of the closest found, below your ${threshold}%.`
        : `${match}% calibrated sound match to “${seedTitle}” (DCLAP audio vectors).` }],
      uncertainty: [], new_release: false, factors: unmeasured ? {} : { audio: match / 100 }, weights: unmeasured ? {} : { audio: 1 },
      sources: [String(track['provider'])], playback: playbackFor(track as Dict), characteristics: characteristicsOf(track as Dict, null),
      added: true, sound_match: unmeasured ? null : match, ...(below ? { sound_below: true } : {}), ...(unmeasured ? { sound_unmeasured: true } : {}),
    }));
    const next = this.withKnownGenres({ ...current, phase: 'final', items: [...previous, ...freshItems], count: previous.length + freshItems.length, saved_at: unixNow() });
    // A list replacement or cancellation in mid-search cannot be undone by this late completion.
    job.token.check();
    await this.store.put('last_result', next);
    const reached = matches.filter((m) => !m.below && !m.unmeasured).length;
    const below = matches.filter((m) => m.below).length;
    const unmeasured = matches.filter((m) => m.unmeasured).length;
    job.result = { added: freshItems.length, reached, below, unmeasured, minimum: threshold,
      matches: freshItems.map((it) => ({ key: (it.track as Dict)['key'], match: it.sound_match, provider: (it.track as Dict)['provider'], ...(it.sound_below ? { below: true } : {}), ...(it.sound_unmeasured ? { unmeasured: true } : {}) })),
      reason: freshItems.length ? (unmeasured ? unmeasuredNote : '') : 'Every song found is already in your list. The list is unchanged.',
      queue: this.completed(next), sources: job.sources, audio: job.audio };
  }

  private async runSimilar(job: Job, seed: Dict, settings: Dict): Promise<void> {
    const p = this.pipeline;
    const start = performance.now();
    const threshold = Number(settings['similar_percent']);
    const lastAtStart = this.store.get<Dict>('last_result');
    const meter = p.meter(settings); job.meter = meter;
    const c: Ctx = { token: job.token, meter };
    try {
      if (settings['audio'] === false) {
        job.result = { added: 0, minimum: threshold, matches: [], reason: 'Audio matching is off in Settings. Turn it on and try again.', sources: {}, audio: {} };
        return;
      }
      job.phase = 'gathering'; job.progress = `Finding candidates from every service for “${seed['title']}”`;
      const seedProf = await p.profileSeed(job, seed);
      job.token.check();
      const sv = p.seedView(seed, seedProf);
      // The normal recommendation graph retrieves Deezer, YouTube Music and SoundCloud relatives.
      // The other four full-song providers have search, not related-song APIs. Query every provider
      // with the seed's real genre if known, else its artist. They only supply candidates: the audio
      // vector still decides what passes, not the search term or the service's own "related" label.
      const cfg = { ...engineFromSettings(settings), perSourceCap: 20, mergedCap: 180, queueSize: SIMILAR_LIMIT };
      const { cands: related } = await p.gather(job, [sv], { [String(sv['key'])]: seedProf }, cfg, false);
      job.token.check();
      const tag = ((sv['tags'] as Tag[] | undefined) ?? []).find((t) => t && !t.inferred)?.name;
      const query = String(tag ?? (sv['artists'] as string[])[0] ?? sv['artist'] ?? '').trim();
      const src = [
        ['deezer', this.dz], ['ytmusic', this.ytm], ['soundcloud', this.sc], ['bandcamp', this.bandcamp],
        ['audius', this.audius], ['hearthis', this.hearthis], ['internet-archive', this.archive],
      ] as const;
      const searched = query ? await pmap(src, 3, async ([name, provider]) =>
        p.call(job, `similar-${name}`, () => provider.search(query, 12, c), [] as NativeTrack[]),
      ) : [];
      job.token.check();
      // Deduplicate BEFORE paying for vectors, but keep every platform represented by actual results.
      // Round-robin is deliberate: sixty early Deezer results must not crowd Bandcamp, Audius,
      // HearThis or Archive out of the bounded audio analysis. Every provider gets its first hits.
      const bySource = [...searched, related];
      const balanced: NativeTrack[] = [];
      for (let i = 0; i < 12; i++) for (const group of bySource) if (group[i]) balanced.push(group[i] as NativeTrack);
      const candidates = newDiscoveryTracks(
        balanced.filter((t) => Boolean(t?.['key']) && t['kind'] !== 'video'),
        [sv] as NativeTrack[],
      ).slice(0, 120) as Dict[];
      job.timings['candidates'] = candidates.length;
      const getVector = async (t: Dict): Promise<Float64Array | null> => {
        const own = this.store.vectorGet(songVectorKey(String(t['key'])), A.MODEL_ID, A.PREPROCESS_ID);
        if (own) return Float64Array.from(own);
        const did = String(t['dz_preview_id'] || t['dz_id'] || (t['provider'] === 'deezer' ? t['platform_id'] : '') || '');
        const cached = did ? this.store.vectorGet(`deezer:${did}`, A.MODEL_ID, A.PREPROCESS_ID) : null;
        if (cached) return Float64Array.from(cached);
        if (did && settings['audio'] !== false && this.encoder) return p.vectorFor(job, did, String(t['preview'] || ''));
        return null;
      };
      job.phase = 'listening'; job.progress = `Comparing real sound vectors at ${threshold}% or higher`;
      let seedVec = await getVector(sv);
      if (!seedVec && settings['audio'] !== false && this.encoder) {
        const dz = seedProf['dz'] as Dict | null;
        const did = String(sv['dz_preview_id'] || (sv['provider'] === 'deezer' ? sv['platform_id'] : '') || '');
        if (did) seedVec = await p.vectorFor(job, did, String(sv['preview'] || dz?.['preview'] || ''));
      }
      if (!seedVec) {
        // SIMILAR-MIN-001: no sound to compare with, but three related songs are still added, said as such.
        const why = settings['audio'] === false ? 'Sound matching is off in Settings' : 'No analysed audio is available for this song';
        await this.addSimilar(job, sv, threshold, [], candidates, lastAtStart, `${why}, so these are related songs whose sound was not compared.`);
        return;
      }
      // Read an existing vector or a known Deezer match; resolve missing platform matches only for
      // the bounded candidate pool. No guessed vector is ever used as a sound match.
      const known = candidates.filter((t) =>
        this.store.vectorGet(songVectorKey(String(t['key'])), A.MODEL_ID, A.PREPROCESS_ID) ||
        this.store.vectorGet(`deezer:${String(t['dz_id'] || (t['provider'] === 'deezer' ? t['platform_id'] : '') || '')}`, A.MODEL_ID, A.PREPROCESS_ID),
      );
      const unknown = candidates.filter((t) => !known.includes(t)).slice(0, 60);
      if (unknown.length) await p.enrich(job, unknown, unknown.length);
      job.token.check();
      let compared = 0;
      const hits = await pmap([...known, ...unknown], 3, async (t, i) => {
        job.token.check(); job.progress = `Comparing song ${i + 1} of ${known.length + unknown.length}`;
        let v: Float64Array | null;
        try { v = await getVector(t); }
        catch (e) { if (!(e instanceof BudgetExceeded)) throw e; job.audio['stopped'] = 'Transfer allowance reached; compared only available sounds.'; v = null; }
        const match = soundMatch(seedVec, v);
        if (match === null) return null;
        compared += 1;
        return { track: t as SoundTrack, match };
      });
      job.token.check();
      job.audio['compared'] = compared;
      await this.addSimilar(job, sv, threshold, hits.filter((h): h is NonNullable<typeof h> => h !== null), candidates, lastAtStart, compared ? '' : 'No candidates had analysable audio, so these are related songs whose sound was not compared.');
      job.timings['total_ms'] = Math.round(performance.now() - start);
    } catch (e) { job.error = e instanceof Cancelled ? 'cancelled' : `${(e as Error).name}: ${(e as Error).message}`; }
    finally { job.done = true; job.phase = job.error ? (job.error === 'cancelled' ? 'cancelled' : 'failed') : 'done'; }
  }

  /**
   * Decides whether a finished song should spend anything on providers. Only a completed song that
   * came from the list counts, and only while the unplayed remainder is nearly gone; a skip, a
   * replay, a pause or a preview from search never starts a search. One listen starts one batch.
   */
  private listeningGuard(body: Dict, settings: Dict): { skip: true; reason: string } | { skip: false; seeds: Dict[]; mood?: string[] } {
    const seeds = this.store.seeds() as Dict[];
    const eventId = String(body['event_id'] ?? '');
    const event = this.store.feedback().find((f) => (f as unknown as Dict)['event_id'] === eventId) as unknown as Dict | undefined;
    if (!event) return { skip: true, reason: 'That listen is not on record yet.' };
    // A saved list is not a discovery queue: it is topped up only once the listener has heard
    // everything already in it, rather than at the queue's low-water mark.
    const listId = String(body['list_id'] ?? event['list_id'] ?? '');
    if (listId) {
      const list = this.storedPlaylists().find((l) => l.id === listId);
      if (!list) return { skip: true, reason: 'That list is gone.' };
      const played = this.playedKeys();
      played.add(String(event['key']));
      if (!playlistFullyPlayed(list, played)) {
        const left = unplayedCount(list, played);
        return { skip: true, reason: `${left} ${left === 1 ? 'song' : 'songs'} in “${list.name}” still to play.` };
      }
    }
    const items = (this.store.get<Dict>('last_result')?.['items'] ?? []) as { track: Dict }[];
    const played = new Set<string>((Array.isArray(body['exclude']) ? body['exclude'] : []).map(String));
    played.add(String(event['key']));
    // Played FROM the list, not merely present in it: a preview started from the search box carries
    // origin 'search' and must not spend anything on providers.
    const origin = String(event['origin'] ?? 'queue');
    const known = items.some((x) => x.track['key'] === event['key']) || seeds.some((s) => s['key'] === event['key']);
    const inList = known && origin === 'queue';
    const remaining = items.filter((x) => !played.has(String(x.track['key']))).length;
    // MOOD-DISCOVER-001: a queue with songs left can still lack any that fit the listening mood; then the
    // mood's own songs seed a search (at most once every ten minutes, never for a saved list).
    const enabled = settings['discover_while_listening'] !== false;
    const low = needsListeningDiscovery(enabled, String(event['kind'] ?? ''), inList, remaining);
    const want = !low && !listId && enabled && inList && event['kind'] === 'complete' ? this.moodWantsMore(items, played, settings) : null;
    if (!low && !want) return { skip: true, reason: 'The list does not need more songs yet.' };
    const active = this.currentJob ? this.jobs.get(this.currentJob) : null;
    if (active && !active.done) return { skip: true, reason: 'Discovery is already running.' };
    const handled = (this.store.get<string[]>('discovery_events') ?? []) as string[];
    if (handled.includes(eventId)) return { skip: true, reason: 'Already discovered for this listen.' };
    void this.store.put('discovery_events', [...handled.slice(-99), eventId]);
    // Follow what was actually heard as well as the original starting songs, without editing them:
    // the listener owns that list.
    const heard = (event['track'] ?? null) as Dict | null;
    if (want) {
      void this.store.put(MOOD_DISCOVERY_AT, unixNow());
      const first = [...want.seeds, ...(heard ? [heard] : [])];
      const firstKeys = new Set(first.map((t) => String(t['key'])));
      return { skip: false, seeds: [...first.filter((t, i) => first.findIndex((u) => u['key'] === t['key']) === i), ...seeds.filter((s) => !firstKeys.has(String(s['key'])))], mood: want.leading };
    }
    return { skip: false, seeds: heard ? [heard, ...seeds.filter((s) => s['key'] !== event['key'])] : seeds };
  }

  /**
   * MOOD-DISCOVER-001: whether the songs left in the queue hold too few for the current mood (fewer than
   * MOOD.lead at the Familiar/Adventurous fit bar), and if so the mood's strongest songs to search from.
   */
  private moodWantsMore(items: { track: Dict }[], played: Set<string>, settings: Dict): { seeds: Dict[]; leading: string[] } | null {
    if (settings['mood_queue'] === false) return null;
    const now = unixNow();
    if (now - Number(this.store.get(MOOD_DISCOVERY_AT) ?? 0) < MOOD_DISCOVERY_EVERY_S) return null;
    const tagsOf = (t: Dict) => moodTags(characteristicsOf(t, null) as never);
    const mood = buildMood(this.moodSignals(now, tagsOf), now);
    if (mood.confidence < 0.5) return null;
    const left = items.filter((x) => x?.track?.['key'] && !played.has(String(x.track['key'])));
    const { fit } = moodFit(left.map((x) => ({ key: String(x.track['key']), tags: tagsOf(x.track), vector: this.moodVector(x.track) })), mood);
    const a = Number(settings['adventurous'] ?? 0.5);
    const bar = 0.65 - 0.3 * Math.max(0, Math.min(1, Number.isFinite(a) ? a : 0.5));
    if (left.filter((x) => (fit[String(x.track['key'])] ?? 0) >= bar).length >= MOOD.lead) return null;
    // The songs the mood rests on: starred, Find similar, finished and replayed, newest first.
    const strong = new Set(['like', 'save', 'similar', 'complete', 'replay']);
    const seeds: Dict[] = [];
    const rows = [
      ...this.store.feedback().filter((r) => strong.has(r.kind) && now - r.ts <= MOOD.maxAgeS && r.track).map((r) => ({ ts: r.ts, track: r.track as Dict, w: r.kind === 'like' || r.kind === 'save' ? 2 : 1 })),
      ...this.moodLog().filter((r) => r['kind'] === 'similar' && now - Number(r['ts']) <= MOOD.maxAgeS && r['track']).map((r) => ({ ts: Number(r['ts']), track: r['track'] as Dict, w: 3 })),
    ].sort((x, y) => y.w - x.w || y.ts - x.ts);
    for (const r of rows) {
      if (seeds.length >= 3) break;
      if (!seeds.some((t) => t['key'] === r.track['key'])) seeds.push(r.track);
    }
    return seeds.length ? { seeds, leading: mood.leading } : null;
  }

  private jobStatus(id: string): LocalResponse {
    const j = this.jobs.get(id);
    if (!j) return fail(404, 'unknown job');
    return ok({ job: j.id, phase: j.phase, progress: j.progress, done: j.done, error: j.error, result: j.result ? this.completed(j.result) : j.result, elapsed_ms: Math.round((unixNow() - j.started) * 1000), sources: j.sources });
  }

  private cancelJob(id: string): LocalResponse {
    this.jobs.get(id)?.token.cancel('cancelled by you');
    return ok({ ok: true });
  }

  private serialise(scored: E.Scored[], ctx: E.Context, phase: string, job: Job): Dict {
    const seeds = new Map(ctx.seeds.map((s) => [s.key, s as Dict]));
    const items = scored.map((x, i) => {
      const c = x.track as Dict;
      const best = x.bestSeed ? seeds.get(x.bestSeed) : undefined;
      const factors: Dict = {};
      for (const [k, v] of Object.entries(x.factors)) factors[k] = typeof v === 'number' && !Number.isInteger(v) ? round(v, 3) : v;
      return {
        rank: i + 1, track: cleanTrack(c), score: round(x.final, 4), coverage: round(x.coverage, 2), tier: x.tier,
        evidence: x.coverage >= 0.6 ? 'strong' : x.coverage >= 0.35 ? 'moderate' : 'thin',
        best_seed: best ? { key: x.bestSeed, title: best['title'], artist: best['artist'] } : null,
        reasons: x.reasons, uncertainty: x.uncertainty, new_release: x.newRelease, factors,
        weights: Object.fromEntries(Object.entries(x.weightsUsed).map(([k, v]) => [k, round(v, 3)])),
        sources: [...new Set(((c['provenance'] as Dict[]) ?? []).map((p) => SOURCE_LABELS[p['source']] ?? p['source']))].sort(),
        playback: playbackFor(c),
        characteristics: characteristicsOf(c, ctx.taste ?? null),
      };
    });
    const cfg = ctx.cfg ?? DEFAULT_ENGINE;
    return {
      phase, items, count: items.length, asked: cfg.queueSize, ranking_formula: cfg.rankingFormula ?? null, fresh: ctx.settings.fresh, adventurous: ctx.settings.adventurous,
      sources: job.sources, audio: { ...job.audio }, timings: job.timings, transfer: job.meter ? { ...job.meter.counts } : {}, candidates: job.timings['candidates'],
    };
  }

  private async runJob(job: Job, seeds: Dict[], settings: Dict, trigger: 'search' | 'listening' = 'search'): Promise<void> {
    const p = this.pipeline;
    const t0 = performance.now();
    const since = () => Math.round(performance.now() - t0);
    // The list as it stands. A batch adds to it; lowering the limit never shortens it.
    const previous = (this.store.get<Dict>('last_result')?.['items'] ?? []) as { track: Dict }[];
    const held = [...(this.store.seeds() as Dict[]), ...previous.map((x) => x.track)];
    const limit = Number(settings['queue_size'] ?? DEFAULT_ENGINE.queueSize);
    const merge = (batch: Dict): Dict => {
      // QUEUE-ADD-001: append to the queue as it stands now, so a song the listener added while this
      // batch was being found is kept rather than overwritten by the queue as it was at the start.
      const now = (this.store.get<Dict>('last_result')?.['items'] ?? previous) as { track: Dict }[];
      const items = appendDiscovery(now, (batch['items'] ?? []) as { track: Dict }[], limit);
      return { ...batch, items, count: items.length, discovery: { added: items.length - now.length, limit, trigger } };
    };
    try {
      const cfg = { ...engineFromSettings(settings), queueSize: Number(settings['queue_size'] ?? DEFAULT_ENGINE.queueSize) };
      const es = E.normaliseSettings({ fresh: Boolean(settings['fresh']), adventurous: settings['adventurous'] });
      job.meter = p.meter(settings);
      job.phase = 'profiling';
      job.progress = 'Looking up your starting songs';
      // PLAYLIST-QUEUE-001: a long list of starting songs (a saved list sent to the queue) is asked
      // about a window at a time; every starting song still counts when the songs found are scored,
      // with its profile from the cache when it has been looked up before.
      const win = seedWindow(seeds, Number(this.store.get(SEED_CURSOR_KEY) ?? 0), trigger === 'listening' ? 1 : 0);
      if (seeds.length > win.window.length) await this.store.put(SEED_CURSOR_KEY, win.next);
      const asked = new Set(win.window.map((sd) => String(sd['key'])));
      const profs = await pmap(win.window, 3, (sd) => p.profileSeed(job, sd));
      const profiles: Record<string, Dict> = {};
      win.window.forEach((sd, i) => (profiles[sd['key']] = profs[i] as Dict));
      for (const sd of seeds) {
        if (asked.has(String(sd['key']))) continue;
        profiles[sd['key']] = (this.store.cacheGet(`seedprofile:${sd['id']}`, true)?.value as Dict | undefined) ?? { dz: null, ytm_vid: null, dz_uncertain: [] };
      }
      const seedViews = seeds.map((sd) => p.seedView(sd, profiles[sd['key']] as Dict));
      const gatherViews = seedViews.filter((sv) => asked.has(String(sv['key'])));
      job.timings['seeds'] = seeds.length;
      job.timings['seeds_asked'] = gatherViews.length;
      job.timings['profile_ms'] = since();
      job.phase = 'gathering';
      job.progress = 'Asking the music services for related songs';
      // Feedback and impressions are ready before gathering so the first wave can be scored honestly.
      const fb = settings['rank_v2'] !== false ? E.withSavedAlbums(E.buildFeedback2(this.store.feedback() as never, unixNow(), cfg), this.savedAlbumKeys()) : E.buildFeedback(this.store.feedback() as never, unixNow(), cfg);
      const imps = this.store.impressions(unixNow() - cfg.exposureWindowDays * 86400);
      const v2 = settings['rank_v2'] !== false;
      const taste = this.taste();
      const taste2 = v2 ? this.taste2() : null;
      const es2 = es;
      // First wave: as soon as a few sources answer, a provisional queue is scored and shown while
      // the remaining sources, genres and audio comparisons keep loading. Same scorer, same honesty
      // rules — only the evidence is thinner, and the phase says so.
      const onPartial = (quick: Dict[], relPartial: Map<string, Set<string>>) => {
        try {
          const relMapQ = new Map([...relPartial].filter(([, v]) => v.size));
          const ctxQ: E.Context = {
            seeds: seedViews as never, vectors: new Map(), relatedArtists: relMapQ, feedback: fb, impressions: imps,
            settings: es2, now: new Date(), cfg, taste, rankV2: v2, taste2,
          };
          const quickChosen = E.select(E.scoreAll(newDiscoveryTracks(quick, held) as never, ctxQ), ctxQ);
          if (quickChosen.length) {
            job.result = merge(this.serialise(quickChosen, ctxQ, 'gathering', job));
            job.progress = `First ${quickChosen.length} songs found; still asking the other services`;
          }
        } catch {
          /* a failed provisional wave never fails the request */
        }
      };
      // ALBUM-TASTE-001: albums the listener keeps playing are fetched whole for a starting song on them.
      const deepAlbums = new Set(Object.entries(fb.album ?? {}).filter(([, v]) => v >= E.ALBUM_DEEP_MIN).map(([k]) => k));
      // COLOR-DISCOVERY-001: the colours the Sound card draws are handed to the gather step as a
      // source of their own, and the cursor moves on, so the next run asks for music this one did
      // not. This is what lets discovery keep going once every starting song's sources are spent.
      const colourCursor = Math.max(0, Math.trunc(Number(this.store.get(TASTE_CURSOR_KEY) ?? 0)));
      const colours = this.colourList(taste);
      if (colours.length) await this.store.put(TASTE_CURSOR_KEY, colourCursor + 1);
      job.timings['taste_colours'] = colours.length;
      const gathered = await p.gather(job, gatherViews, profiles, cfg, es.fresh, onPartial, deepAlbums, { colours, cursor: colourCursor });
      const related = gathered.related;
      // Only songs the list does not already hold can take a slot in this batch.
      const cands = newDiscoveryTracks(gathered.cands, held);
      job.timings['gather_ms'] = since() - job.timings['profile_ms'];
      job.timings['candidates'] = cands.length;
      if (!cands.length) {
        job.result = merge({
          phase: 'final', items: [], count: 0, asked: cfg.queueSize, sources: job.sources, audio: job.audio, timings: job.timings,
          transfer: { ...job.meter.counts },
          empty_reason: previous.length
            ? colours.length
              ? 'No new songs this time. Your list is unchanged; the next run reads further into your sound.'
              : 'No new songs this time. Your list is unchanged. Finish or like a few songs and your sound starts finding more on its own.'
            : 'No service returned related songs for these starting songs.',
        });
        return;
      }
      const vectors = new Map<string, Float64Array>();
      const dzIdOf = (sv: Dict): string | null => sv['dz_preview_id'] || sv['dz_id'] || (sv['provider'] === 'deezer' ? sv['platform_id'] : null) || null;
      for (const sv of [...seedViews, ...cands]) {
        const did = dzIdOf(sv);
        // The full song first: it is the better description, and it is the only one a song with no
        // Deezer match ever gets.
        const v =
          this.store.vectorGet(songVectorKey(String(sv['key'])), A.MODEL_ID, A.PREPROCESS_ID) ??
          (did ? this.store.vectorGet(`deezer:${did}`, A.MODEL_ID, A.PREPROCESS_ID) : null);
        if (v) vectors.set(sv['key'], Float64Array.from(v));
      }
      const relMap = new Map([...related].filter(([, v]) => v.size));
      const ctx: E.Context = { seeds: seedViews as never, vectors, relatedArtists: relMap, feedback: fb, impressions: imps, settings: es, now: new Date(), cfg, taste, rankV2: v2, taste2 };
      let scored = E.scoreAll(cands as never, ctx);
      let chosen = E.select(scored, ctx);
      job.timings['metadata_ms'] = since();
      job.result = merge(this.serialise(chosen, ctx, 'metadata', job));

      job.token.check();
      job.phase = 'enriching';
      job.progress = 'Reading genres and tempo for the leading songs';
      const leadKeys = scored.slice(0, 40).map((x) => x.track.key);
      const lead = leadKeys.map((k) => cands.find((c) => c['key'] === k)).filter((c): c is Dict => Boolean(c));
      await p.enrich(job, lead, 40);
      if (settings['audio'] !== false && this.encoder) {
        job.phase = 'listening';
        job.progress = 'Comparing how the songs sound (30-second previews)';
        const ta = performance.now();
        try {
          // Previews are fetched only for the songs asked about this run; the rest use a stored vector.
          for (const sv of gatherViews) {
            const did = sv['dz_preview_id'] || (sv['provider'] === 'deezer' ? sv['platform_id'] : null);
            const prof = (profiles[sv['key']] as Dict)['dz'] as Dict | null;
            if (did && !vectors.has(sv['key'])) {
              const v = await p.vectorFor(job, did, sv['preview'] || prof?.['preview'] || null);
              if (v) vectors.set(sv['key'], v);
            }
          }
          if (seedViews.some((sv) => vectors.has(sv['key']))) {
            const rescored = E.scoreAll(cands as never, ctx);
            const pool0 = rescored.map((x) => x.track as Dict).filter((t) => !vectors.has(t['key']) && t['dz_id'] && t['preview']);
            const budgetN = cfg.audioCandidatesPerRequest;
            // v2: sample across provisional ranking bands instead of only the current top, so audio
            // evidence is not handed exclusively to the songs metadata already favoured.
            // Top 8 as-is, then every 4th of the next 32, then every 8th of the next 80.
            let todo = pool0;
            if (settings['rank_v2'] !== false && pool0.length > budgetN) {
              const picks: Dict[] = [];
              const take = (xs: Dict[], stride: number) => xs.filter((_, i) => i % stride === 0);
              picks.push(...pool0.slice(0, 8));
              picks.push(...take(pool0.slice(8, 40), 4));
              picks.push(...take(pool0.slice(40, 120), 8));
              for (const t of pool0) {
                if (picks.length >= budgetN) break;
                if (!picks.includes(t)) picks.push(t);
              }
              todo = picks.slice(0, budgetN);
            }
            // Three at a time: the next previews download while the worker analyses one.
            await pmap(todo.slice(0, budgetN), 3, async (c) => {
              job.token.check();
              job.progress = `Comparing how the songs sound (${(job.audio['embedded'] ?? 0) + 1} of ${Math.min(budgetN, todo.length)})`;
              const v = await p.vectorFor(job, c['dz_id'], c['preview']);
              if (v) vectors.set(c['key'], v);
            });
          } else {
            job.audio['skipped'] = 'No starting song has a legitimately available preview, so there is nothing to compare against.';
          }
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) throw e;
          const dayLeft = job.meter.remaining();
          job.audio['stopped'] = dayLeft < 2_000_000 ? "Stopped listening early: today's transfer allowance is nearly used (Settings → Daily allowance)." : "Stopped listening early: this request's transfer allowance is used.";
        }
        job.audio['ms'] = Math.round(performance.now() - ta);
        job.audio['compared'] = cands.filter((c) => vectors.has(c['key'])).length;
        if (job.audio['embedded'] && job.audio['compared'] && seedViews.some((sv) => vectors.has(sv['key']))) {
          this.audioCheck = { state: 'working', detail: `Compared ${job.audio['compared']} songs on real previews in the last request`, infer_ms: job.audio['infer_ms'], checked: unixNow() };
        }
      } else if (!this.encoder) {
        job.audio['skipped'] = 'Audio model not available on this device.';
      } else {
        job.audio['skipped'] = 'Audio matching is turned off in Settings.';
      }
      job.token.check();
      // Tempo for leading songs the embedding did not reach: a few preview downloads, so a song
      // with no genre tag can still be placed on the map by how fast it is.
      if (settings['audio'] !== false) {
        const needTempo = E.scoreAll(cands as never, ctx)
          .map((x) => cands.find((cd) => cd['key'] === x.track.key))
          .filter((t): t is Dict => Boolean(t && !t['bpm'] && t['dz_id'] && t['preview']))
          .slice(0, 10);
        try {
          for (const t of needTempo) await p.tempoFor(job, String(t['dz_id']), String(t['preview']));
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) throw e;
        }
      }
      this.fillMeasuredBpm([...seedViews, ...cands]);
      // GENRE-LOAD-001: the songs about to be shown that still have no genre are read first, so a
      // guess is only made for a song no service could place.
      {
        const byKey = new Map(cands.map((c) => [String(c['key']), c]));
        job.progress = 'Reading genres for the songs found';
        await p.genresForShown(job, E.select(E.scoreAll(cands as never, ctx), ctx).map((x) => byKey.get(x.track.key)).filter((c): c is Dict => Boolean(c)));
      }
      // Genre inference for songs no provider labeled: the artist's other songs, then the sound,
      // then the recommending seed. Inferred tags are marked and never overwrite real metadata.
      await recordArtistGenres(this.store, [...seedViews, ...cands]);
      {
        const amap = this.store.get<Record<string, Record<string, number>>>('artist_genres') ?? {};
        const labeled = [...seedViews, ...cands].filter((t) => ((t['tags'] as { inferred?: boolean }[] | undefined) ?? []).some((g) => !g.inferred));
        scored = E.scoreAll(cands as never, ctx);
        const bestOf = new Map(scored.map((x) => [x.track.key, x.bestSeed]));
        for (const cand of cands) {
          if (((cand['tags'] as unknown[] | undefined) ?? []).length) continue;
          const seed = seedViews.find((sv) => sv['key'] === bestOf.get(String(cand['key'])));
          const tag = inferFromArtist(cand, amap) ?? inferFromSound(cand, vectors, labeled) ?? inferFromSeed(seed);
          if (tag) cand['tags'] = [tag];
        }
      }
      // A song placed in hip-hop only by inference (its artist's other songs) had no tag when enrich
      // asked for subgenres, so it was skipped. Ask again now that every song has its family.
      job.progress = 'Naming hip-hop subgenres';
      scored = E.scoreAll(cands as never, ctx);
      chosen = E.select(scored, ctx);
      // Ask about the songs the person will see, in ranked order, not the raw gathering order.
      const byKey = new Map(cands.map((c) => [String(c['key']), c]));
      const shown = chosen.map((x) => byKey.get(x.track.key)).filter((c): c is Dict => Boolean(c));
      await p.subgenresFromMusicBrainz(job, shown, 12);
      scored = E.scoreAll(cands as never, ctx);
      chosen = E.select(scored, ctx);
      job.timings['total_ms'] = since();
      job.result = merge(this.serialise(chosen, ctx, 'final', job));
      // The pool keeps every song the list holds, so a later re-rank can reorder all of them.
      const poolCands = [...previous.map((x) => x.track), ...cands];
      this.pool = { cands: poolCands, ctx, job };
      await this.store.put('last_pool', {
        cands: poolCands, seeds: seedViews, related: [...relMap].map(([k, v]) => [k, [...v]]), settings: es, weights: settings['weights'] ?? null,
      });
      await this.store.put('last_result', { ...job.result, saved_at: unixNow() });
    } catch (e) {
      job.error = e instanceof Cancelled ? 'cancelled' : `${(e as Error).name}: ${(e as Error).message}`;
    } finally {
      job.done = true;
      job.phase = job.error ? (job.error === 'cancelled' ? 'cancelled' : 'failed') : 'done';
    }
  }

  // ---- live re-rank --------------------------------------------------------------------
  /**
   * Re-score the last run's candidate pool with the feedback and listening taste as they are now.
   * The player calls this after every skip or full listen, so the upcoming songs change at once
   * without asking any service again. `exclude` holds keys already played in this session.
   */
  private async rerank(body: Dict): Promise<LocalResponse> {
    const pool = this.pool ?? this.restorePool();
    if (!pool) return fail(409, 'Find recommendations first; there is no song pool to re-rank yet.');
    this.pool = pool;
    const cfg = pool.ctx.cfg ?? DEFAULT_ENGINE;
    const settings = this.settings();
    const exclude = new Set(((body['exclude'] as unknown[]) ?? []).map((k) => String(k)).slice(0, 500));
    const v2 = settings['rank_v2'] !== false;
    // Re-ranking reorders the songs the list already holds and adds nothing, so the discovery limit
    // must not trim it here: a smaller limit would otherwise drop songs the listener still has.
    const ctx: E.Context = {
      ...pool.ctx,
      // ALGO-MANAGER-001: the algorithm active NOW ranks the pool, over the run's own engine base.
      cfg: { ...engineFromSettings(settings, cfg), queueSize: Math.max(pool.cands.length, 1) },
      feedback: v2 ? E.withSavedAlbums(E.buildFeedback2(this.store.feedback() as never, unixNow(), cfg), this.savedAlbumKeys()) : E.buildFeedback(this.store.feedback() as never, unixNow(), cfg),
      impressions: this.store.impressions(unixNow() - cfg.exposureWindowDays * 86400),
      taste: this.taste(),
      rankV2: v2,
      taste2: v2 ? this.taste2() : null,
      now: new Date(),
    };
    const cands = pool.cands.filter((c) => !exclude.has(String(c['key'])));
    const chosen = E.select(E.scoreAll(cands as never, ctx), ctx);
    const out = this.serialise(chosen, ctx, 'live', pool.job) as Dict;
    out['taste'] = tasteSummary(ctx.taste);
    out['pool'] = pool.cands.length;
    return ok(this.completed(out));
  }

  // ---- listening mood (MOOD-QUEUE-001) -----------------------------------------------------
  /** Signals that are not feedback rows ("Find similar sound"), newest last, at most a window's worth. */
  private noteMood(track: Dict, kind: MoodKind): void {
    const log = this.moodLog().filter((r) => unixNow() - Number(r['ts']) <= MOOD.maxAgeS);
    log.push({ kind, ts: unixNow(), track: cleanTrack(track as never) });
    // The write lands asynchronously; the answer to the same request must already count this press.
    this.moodLogNow = log.slice(-MOOD.window);
    void this.store.put('mood_log', this.moodLogNow);
  }

  private moodLogNow: Dict[] | null = null;
  private moodLog(): Dict[] { return [...(this.moodLogNow ?? this.store.get<Dict[]>('mood_log') ?? [])]; }

  /**
   * Every listening signal of the last 90 minutes: saved judgements and plays, then the presses kept
   * only for the mood (Find similar, and car presses made with the phone closed). A car press the page
   * later saves as feedback is the same press: a logged one within ten minutes of a matching
   * feedback row is not counted again.
   */
  private moodSignals(now: number, tagsOf: (t: Dict, c?: Dict | null) => ReturnType<typeof moodTags>): MoodSignal[] {
    const signals: MoodSignal[] = [];
    const kinds: Record<string, MoodKind> = { complete: 'complete', replay: 'replay', like: 'like', dislike: 'dislike', hide: 'dislike', skip: 'skip', save: 'like' };
    const saved: { key: string; kind: MoodKind; ts: number }[] = [];
    for (const r of this.store.feedback()) {
      const kind = kinds[r.kind];
      if (!kind || now - r.ts > MOOD.maxAgeS || String(r.origin ?? '').startsWith('import:') || !r.track) continue;
      const t = r.track as Dict;
      saved.push({ key: r.key, kind, ts: r.ts });
      signals.push({ key: r.key, kind, ts: r.ts, tags: tagsOf(t), vector: this.moodVector(t), listened: r.listened, duration: r.duration ?? (typeof t['duration'] === 'number' ? (t['duration'] as number) : null) });
    }
    for (const r of this.moodLog()) {
      const t = r['track'] as Dict | undefined;
      const ts = Number(r['ts']);
      if (!t?.['key'] || now - ts > MOOD.maxAgeS) continue;
      const key = String(t['key']);
      const kind = r['kind'] as MoodKind;
      if (saved.some((s) => s.key === key && s.kind === kind && Math.abs(s.ts - ts) <= 600)) continue;
      signals.push({ key, kind, ts, tags: tagsOf(t), vector: this.moodVector(t) });
    }
    return signals;
  }

  /** For tests: the signals the mood is built from right now. */
  moodSignalsForTest(): { key: string; kind: string }[] {
    return this.moodSignals(unixNow(), (t) => moodTags(characteristicsOf(t, null) as never)).map((s) => ({ key: s.key, kind: s.kind }));
  }

  /** The measured sound of a song, when the app has analysed it (full song first, then the preview). */
  private moodVector(t: Dict): Float32Array | null {
    const did = t['dz_preview_id'] || t['dz_id'] || (t['provider'] === 'deezer' ? t['platform_id'] : null);
    return this.store.vectorGet(songVectorKey(String(t['key'] ?? '')), A.MODEL_ID, A.PREPROCESS_ID)
      ?? (did ? this.store.vectorGet(`deezer:${did}`, A.MODEL_ID, A.PREPROCESS_ID) : null);
  }

  /**
   * MOOD-QUEUE-001: the order the songs still to come should play in for the current listening mood.
   * Body: `upcoming` (the movable songs, engine order: {track, characteristics?}), `shown` (their keys
   * as on screen now), `current` (the song playing: {track, characteristics?}). The caller decides
   * what may move (played, current and hand-added songs never do; albums and saved lists only with
   * shuffle on). Off in Settings = the order given, unchanged.
   */
  private mood(body: Dict): LocalResponse {
    const settings = this.settings();
    const list = (Array.isArray(body['upcoming']) ? (body['upcoming'] as Dict[]) : []).slice(0, 500)
      .filter((u) => u && typeof u === 'object' && typeof (u['track'] as Dict | undefined)?.['key'] === 'string');
    const keys = list.map((u) => String((u['track'] as Dict)['key']));
    if (settings['mood_queue'] === false) return ok({ order: keys, changed: false, moved: [], off: true, leading: [], confidence: 0 });
    // CAR-MOOD-001: the car's press, sent with the question while the phone app is closed.
    const sig = body['signal'] as Dict | undefined;
    const sigTrack = sig?.['track'] as Dict | undefined;
    if (sigTrack && typeof sigTrack['key'] === 'string' && CAR_MOOD_KINDS.has(String(sig!['kind']))) this.noteMood(sigTrack, String(sig!['kind']) as MoodKind);
    const now = unixNow();
    const tagsOf = (t: Dict, c?: Dict | null) => moodTags((c && (c['genres'] || c['family'] || c['families']) ? c : characteristicsOf(t, null)) as never);
    const signals = this.moodSignals(now, tagsOf);
    const cur = body['current'] as Dict | undefined;
    const curTrack = cur?.['track'] as Dict | undefined;
    if (curTrack?.['key']) signals.push({ key: String(curTrack['key']), kind: 'current', ts: now, tags: tagsOf(curTrack, cur?.['characteristics'] as Dict | undefined), vector: this.moodVector(curTrack) });
    const mood = buildMood(signals, now);
    const cands: MoodCandidate[] = list.map((u) => {
      const t = u['track'] as Dict;
      return { key: String(t['key']), tags: tagsOf(t, u['characteristics'] as Dict | undefined), vector: this.moodVector(t) };
    });
    const shown = Array.isArray(body['shown']) ? (body['shown'] as unknown[]).map(String).slice(0, 500) : undefined;
    const adventurous = Number(settings['adventurous'] ?? 0.5);
    const plan = moodOrder(cands, mood, Number.isFinite(adventurous) ? adventurous : 0.5, { shown });
    // MOOD-SHUFFLE-001: how well each song fits, for the shuffle's weighted pick. `score` adds songs that
    // may not move (hand-added, or a list played in shuffle) but are still picked from.
    const extra = (Array.isArray(body['score']) ? (body['score'] as Dict[]) : []).slice(0, 500)
      .filter((u) => u && typeof u === 'object' && typeof (u['track'] as Dict | undefined)?.['key'] === 'string')
      .filter((u) => !keys.includes(String((u['track'] as Dict)['key'])))
      .map((u) => { const t = u['track'] as Dict; return { key: String(t['key']), tags: tagsOf(t, u['characteristics'] as Dict | undefined), vector: this.moodVector(t) }; });
    const { fit } = moodFit([...cands, ...extra], mood);
    return ok({ ...plan, fit, leading: mood.leading, confidence: round(mood.confidence, 2) });
  }

  /** Songs the catalogue gave no tempo for get the one measured from their preview, when there is one. */
  private fillMeasuredBpm(list: Dict[]): void {
    for (const sv of list) {
      if (sv['bpm']) continue;
      const did = sv['dz_preview_id'] || sv['dz_id'] || (sv['provider'] === 'deezer' ? sv['platform_id'] : null);
      const m = did ? this.store.get<number>(`bpm:${did}`) : undefined;
      if (typeof m === 'number' && m > 0) {
        sv['bpm'] = m;
        sv['bpm_measured'] = true;
      }
    }
  }

  /** Rebuild the live pool after an app restart from what the last finished run stored. */
  private restorePool(): { cands: Dict[]; ctx: E.Context; job: Job } | null {
    const saved = this.store.get<Dict>('last_pool');
    if (!saved || !Array.isArray(saved['cands']) || !Array.isArray(saved['seeds'])) return null;
    let cfg;
    try {
      cfg = engineWithWeights(saved['weights'] ?? undefined);
    } catch {
      cfg = DEFAULT_ENGINE;
    }
    const cands = saved['cands'] as Dict[];
    const seeds = saved['seeds'] as Dict[];
    this.fillMeasuredBpm([...seeds, ...cands]);
    const vectors = new Map<string, Float64Array>();
    for (const sv of [...seeds, ...cands]) {
      const did = sv['dz_preview_id'] || sv['dz_id'] || (sv['provider'] === 'deezer' ? sv['platform_id'] : null);
      // Same order as the discovery path: the full song wins over the 30-second preview.
      const v =
        this.store.vectorGet(songVectorKey(String(sv['key'])), A.MODEL_ID, A.PREPROCESS_ID) ??
        (did ? this.store.vectorGet(`deezer:${did}`, A.MODEL_ID, A.PREPROCESS_ID) : null);
      if (v) vectors.set(sv['key'], Float64Array.from(v));
    }
    const related = new Map<string, Set<string>>(((saved['related'] as [string, string[]][]) ?? []).map(([k, v]) => [k, new Set(v)]));
    const es = E.normaliseSettings((saved['settings'] as Dict) ?? {});
    const ctx: E.Context = {
      seeds: seeds as never, vectors, relatedArtists: related, feedback: E.buildFeedback([], unixNow(), cfg), impressions: {}, settings: es, now: new Date(), cfg,
    };
    const job = new Job('restored');
    const last = this.store.get<Dict>('last_result');
    if (last) {
      job.sources = (last['sources'] as never) ?? {};
      job.audio = (last['audio'] as never) ?? {};
    }
    return { cands, ctx, job };
  }

  // ---- feedback ------------------------------------------------------------------------
  private async feedback(body: Dict): Promise<LocalResponse> {
    const kind = String(body['kind']);
    if (!FEEDBACK_KINDS.has(kind)) return fail(400, 'unknown feedback kind');
    const t: Dict = body['track'] ?? {};
    const key = t['key'];
    if (!key) return fail(400, 'track.key required');
    if (kind.startsWith('un')) return ok({ removed: this.store.removeFeedback(key, [kind.slice(2)]) });
    const eventId = String(body['event_id'] ?? '').slice(0, 80);
    if (!eventId) return fail(400, 'event_id required (used to deduplicate)');
    const listened = body['listened'] ?? null;
    if (['complete', 'skip', 'replay'].includes(kind) && (listened === null || !(Number(listened) >= 0 && Number(listened) <= 3600))) return fail(400, 'playback events need the listened duration');
    // RADIO-TASTE-001: a radio programme is not a song; whatever reports it, nothing is learned from it.
    if (t['kind'] === 'radio-programme' && FEEDBACK_KINDS.has(kind)) return ok({ recorded: false, duplicate: false });
    const onRadio = body['medium'] === 'radio';
    // The phone page and the service page can both follow one station. Once the full listen is
    // stored, a late thirty-second note for the same listen is the same listen, not a second one.
    if (onRadio && kind === 'qualified' && this.store.hasFeedback(`${eventId}:full`.slice(0, 80))) return ok({ recorded: false, duplicate: true });
    if (kind === 'like') this.store.removeFeedback(key, ['dislike']);
    if (kind === 'dislike') this.store.removeFeedback(key, ['like']);
    const artist = (t['artists'] as string[] | undefined)?.[0]?.toLowerCase() ?? '';
    // v2 telemetry: optional, validated, stored alongside the event (old callers simply omit it).
    const num = (x: unknown, lo: number, hi: number): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
    const str = (x: unknown, allowed?: string[]): string | null => (typeof x === 'string' && x.length > 0 && x.length <= 64 && (!allowed || allowed.includes(x)) ? x : null);
    const meta = {
      duration: num(body['duration'], 1, 36000),
      coverage: num(body['coverage'], 0, 36000),
      medium: str(body['medium'], ['preview', 'full', 'embed', 'radio']),
      session: str(body['session']),
      origin: str(body['origin']),
      confidence: num(body['confidence'], 0, 1),
    };
    const hasMeta = Object.values(meta).some((v) => v !== null);
    // RADIO-TASTE-001: one radio listen is one event, kept at its fullest. Most of the song heard
    // replaces the thirty-second note; a later report of the same full listen with more heard
    // replaces the earlier one. The listen keeps the time it happened.
    let heardAt: number | undefined;
    if (onRadio && kind === 'complete') {
      const same = { key: String(key), medium: 'radio' };
      const replaces = typeof body['supersedes'] === 'string' ? body['supersedes'].slice(0, 80) : '';
      const earlier = this.store.hasFeedback(eventId)
        ? (meta.coverage !== null ? this.store.replaceFeedback(eventId, { ...same, kind: 'complete', coverageBelow: meta.coverage - 1 }) : null)
        : (replaces ? this.store.replaceFeedback(replaces, { ...same, kind: 'qualified' }) : null);
      heardAt = earlier?.ts;
    }
    const stored = t['album'] ? cleanTrack(t) : cleanTrack(withAlbumOf(t, this.knownTracks().get(String(key))));
    const added = await this.store.addFeedback(eventId, key, kind, artist, stored, listened === null ? null : Number(listened), heardAt, hasMeta ? meta : undefined);
    return ok({ recorded: added, duplicate: !added });
  }

  /** Import a parsed history file: pre-validated events from engine/import.ts, original timestamps kept. */
  private async importHistory(body: Dict): Promise<LocalResponse> {
    const events = body['events'];
    if (!Array.isArray(events) || events.length === 0) return fail(400, 'events[] required (parse the file with engine/import first)');
    if (events.length > 2500) return fail(400, 'too many events in one call (cap 2500)');
    let recorded = 0;
    let duplicates = 0;
    const now = unixNow();
    for (const raw of events) {
      const e = raw as Dict;
      const eventId = String(e['event_id'] ?? '').slice(0, 80);
      const key = String(e['key'] ?? '');
      const kind = String(e['kind'] ?? '');
      const ts = Number(e['ts']);
      // imports may only carry playback kinds; explicit judgements stay a live-user action
      if (!eventId.startsWith('imp-') || !key || key.length > 512 || !['complete', 'skip', 'qualified'].includes(kind)) continue;
      if (!Number.isFinite(ts) || ts <= 0 || ts > now + 86400) continue;
      const origin = e['origin'];
      if (origin !== 'import:spotify' && origin !== 'import:listenbrainz') continue;
      const listened = typeof e['listened'] === 'number' && Number.isFinite(e['listened']) ? Math.max(0, Math.min(36000, e['listened'])) : null;
      const confidence = typeof e['confidence'] === 'number' ? Math.max(0, Math.min(1, e['confidence'])) : 0.6;
      const track = { key, title: String(e['title'] ?? '').slice(0, 300), artists: [String(e['artist'] ?? '').slice(0, 300)] };
      const added = await this.store.addFeedback(eventId, key, kind, track.artists[0]!.toLowerCase(), track, listened, ts, { duration: null, medium: null, session: null, origin, confidence });
      if (added) recorded += 1;
      else duplicates += 1;
    }
    return ok({ recorded, duplicates, skipped: events.length - recorded - duplicates });
  }

  private feedbackState(): Dict {
    const rows = this.store.feedback();
    const state: Record<string, Dict> = {};
    for (const r of rows) (state[r.key] ??= {})[r.kind] = true;
    return { state, events: rows.length, taste: tasteSummary(this.taste()) };
  }

  /** Saved plays with each hip-hop artist's remembered subgenres added to a track that only names the family. */
  private historyRows() {
    const map = this.store.get<ArtistSubsMap>(ARTIST_SUBS_KEY);
    return this.store.feedback().map((r) => (r.track ? { ...r, track: withArtistSubs(r.track as Dict, map, r.artist ?? undefined) } : r));
  }

  /** The listening taste as of now, from every stored playback and feedback event. */
  /** The colours the Sound card draws, as the gather step wants them (COLOR-DISCOVERY-001). */
  private colourList(taste: TasteProfile): Colour[] {
    const sum = tasteSummary(taste);
    const list = (sum?.['genres'] ?? []) as { name: string; label: string; score: number }[];
    return list.filter((g) => g.score > 0).map((g) => ({ name: g.name, label: g.label || g.name, score: g.score }));
  }

  taste(): TasteProfile {
    return buildTaste(this.historyRows().map((r) => ({ key: r.key, kind: r.kind, ts: r.ts, track: r.track })), unixNow());
  }

  /** One id per LocalApi lifetime: "current session" for the session taste horizon. */
  private readonly sessionId = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  /** v2 three-horizon taste (long / recent / this session), confidence-aware. */
  taste2(): TasteBlend {
    const rows = this.historyRows().map((r) => ({
      key: r.key, kind: r.kind, ts: r.ts, track: r.track,
      event_id: r.event_id, medium: r.medium ?? null, confidence: r.confidence ?? null, session: r.session ?? null,
    }));
    return buildTasteBlend(rows, unixNow(), this.sessionId);
  }

  /** Everything the recommender tracks and how it uses it, for the "Your profile" screen. */
  private profile(): Dict {
    const settings = this.settings();
    const cfg = { ...engineFromSettings(settings), queueSize: Number(settings['queue_size'] ?? DEFAULT_ENGINE.queueSize) };
    const now = unixNow();
    return buildProfile({
      events: this.store.feedback(),
      seeds: this.store.seeds() as Dict[],
      settings,
      impressions: this.store.impressions(now - cfg.exposureWindowDays * 86400),
      lastResult: this.store.get<Dict>('last_result') ?? null,
      poolSize: this.pool?.cands.length ?? ((this.store.get<Dict>('last_pool')?.['cands'] as Dict[] | undefined)?.length ?? null),
      vectors: this.store.vectorCount(),
      cfg,
      nowTs: now,
    });
  }

  private async impressions(body: Dict): Promise<LocalResponse> {
    const keys = ((body['keys'] as unknown[]) ?? []).map((k) => String(k).slice(0, 300)).slice(0, 60);
    if (keys.length) await this.store.addImpressions(keys);
    return ok({ recorded: keys.length });
  }

  private saved(): Dict {
    const rows = this.store.feedback();
    const removed = new Set(rows.filter((r) => r.kind === 'dislike').map((r) => r.key));
    const seen = new Set<string>();
    const items: Dict[] = [];
    for (const r of [...rows].reverse()) {
      if ((r.kind === 'like' || r.kind === 'save') && !seen.has(r.key) && !removed.has(r.key) && r.track) {
        seen.add(r.key);
        items.push({ track: r.track, kind: r.kind, ts: r.ts });
      }
    }
    // TAGS-ALWAYS-001 (owner, 2026-11-19): every saved row shows its genres and subgenres, worked out as
    // a Discover row's are: the song's own tags (or a fresher copy's, or ones looked up for it), then
    // what genre-fill estimates for what it still lacks. Songs with no stated genre are looked up once.
    const fresher = this.knownTracks();
    const found = this.store.get<Record<string, Tag[]>>(SAVED_TAGS_KEY) ?? {};
    const known = this.knownGenres();
    const placed = items.map((x) => {
      const t = x['track'] as Dict;
      const key = String(t['key']);
      const own = statedTags(t).length ? (t['tags'] as Tag[]) : statedTags(fresher.get(key) ?? {}).length ? (fresher.get(key)!['tags'] as Tag[]) : found[key]?.length ? found[key]! : known(t);
      return { ...x, track: this.withDate(own.length ? { ...t, tags: own } : t) };
    });
    const fill = this.genreFiller(placed);
    if (placed.some((x) => this.savedWants(x['track'] as Dict))) this.kickSavedGenres();
    return { items: placed.map((x) => ({ ...x, characteristics: fill(x['track'] as Dict, characteristicsOf(x['track'] as Dict, null)) })) };
  }

  /**
   * TAGS-ALWAYS-001 (owner, 2026-11-19: "all music should be tagged"): genres for songs shown outside the
   * lists the engine keeps, such as search results. What is already known is used at once; up to ten songs
   * nothing knows are looked up per request (each once a day, inside the allowance) and remembered like saved songs.
   */
  private async genresFor(tracks: Dict[]): Promise<Dict> {
    const found = () => this.store.get<Record<string, Tag[]>>(SAVED_TAGS_KEY) ?? {};
    const known = this.knownGenres();
    const tagged = (t: Dict): Dict => {
      if (statedTags(t).length) return this.withDate(t);
      const own = found()[String(t['key'])] ?? known(t);
      return this.withDate(own.length ? { ...t, tags: own } : t);
    };
    const list = tracks.filter((t) => t && typeof t === 'object' && t['key'] && t['kind'] !== 'radio-programme').slice(0, 30).map((t) => cleanTrack(t));
    // Answer at once with what is known; songs nothing knows are looked up in the background and the
    // page asks again (a lookup can take seconds per song on a phone).
    const unknown = list.filter((t) => !statedTags(tagged(t)).length && !this.store.cacheGet(`genretry:${String(t['key'])}`)?.value);
    if (unknown.length) {
      // The queue takes its last entry first: put this list's first row last, so lookups go top down.
      for (const t of [...unknown].reverse()) { const k = String(t['key']); this.genreQueue.delete(k); this.genreQueue.set(k, t); }
      this.kickGenreQueue();
    }
    const rows = list.map((t) => ({ track: tagged(t) }));
    const fill = this.genreFiller(rows, []);
    const items: Record<string, Dict | null> = {};
    const pending = new Set(unknown.map((t) => String(t['key'])));
    // A song still being looked up answers null (the page asks again); one no service knows is
    // estimated from the artist's other rows, the era or the list (GENRE-ALL-001, drawn dashed).
    for (const r of rows) {
      const key = String(r.track['key']);
      items[key] = pending.has(key) ? null : fill(r.track, characteristicsOf(r.track, null) ?? {});
    }
    return { items, pending: [...pending] };
  }

  /** Songs from search results waiting for a genre lookup, newest request last (TAGS-ALWAYS-001). */
  private genreQueue = new Map<string, Dict>();
  private genreQueueRun: Promise<void> | null = null;
  private kickGenreQueue(): void {
    if (this.genreQueueRun) return;
    this.genreQueueRun = (async () => {
      for (let n = 0; n < 60 && this.genreQueue.size; n++) {
        // The newest results first: they are the ones on screen.
        const [key, t] = [...this.genreQueue.entries()].at(-1)!;
        this.genreQueue.delete(key);
        if (this.store.cacheGet(`genretry:${key}`)?.value) continue;
        try {
          const { tags } = await this.lookUpGenres(t, this.searchMeter());
          if (tags.length) await this.store.put(SAVED_TAGS_KEY, { ...(this.store.get<Record<string, Tag[]>>(SAVED_TAGS_KEY) ?? {}), [key]: tags });
          await this.store.cachePut(`genretry:${key}`, 'metadata', true, 24 * 3600);
        } catch (e) {
          if (e instanceof BudgetExceeded) { this.genreQueue.clear(); return; }
          await this.store.cachePut(`genretry:${key}`, 'metadata', true, 6 * 3600);
        }
      }
    })().catch(() => undefined).finally(() => { this.genreQueueRun = null; });
  }

  /** Resolves once no background genre lookup for search results is running (tests). */
  async genreQueueSettled(): Promise<void> {
    while (this.genreQueueRun) await this.genreQueueRun;
  }

  /** A saved or starting song with no stated genre, or a main genre and no subgenre, not looked up today. */
  private savedWants(t: Dict): boolean {
    const key = String(t['key'] ?? '');
    if (!statedTags(t).length) return !this.store.cacheGet(`genretry:${key}`)?.value;
    if (this.wantsArtist(t) && !this.store.cacheGet(`substry:${key}`)?.value) return true;
    // Still nothing finer once the artist was asked: the year it came out names its era.
    return this.wantsYear(this.withDate(t));
  }

  /** A saved song with the release date looked up for it, when it had none (TAGS-ALWAYS-001). */
  private withDate(t: Dict): Dict {
    if (LocalApi.yearOf(t) || typeof t['year_hint'] === 'number') return t;
    const d = (this.store.get<Record<string, Dict>>(SAVED_DATES_KEY) ?? {})[String(t['key'] ?? '')];
    return d ? { ...t, ...d } : t;
  }

  private savedGenresRun: Promise<void> | null = null;
  private kickSavedGenres(): void {
    if (this.savedGenresRun) return;
    this.savedGenresRun = this.savedGenresLoop().catch(() => undefined).finally(() => { this.savedGenresRun = null; });
  }

  /** Resolves once no background lookup of saved songs' genres is running. */
  async savedGenresSettled(): Promise<void> {
    while (this.savedGenresRun) await this.savedGenresRun;
  }

  /** One saved song at a time; each answer is kept so the next read of Saved shows it. */
  private async savedGenresLoop(): Promise<void> {
    for (let n = 0; n < 200; n++) {
      const items = (this.savedRaw());
      const next = items.find((t) => this.savedWants(t));
      if (!next) return;
      const key = String(next['key']);
      const unplaced = !statedTags(next).length;
      const artistAsk = !unplaced && this.wantsArtist(next) && !this.store.cacheGet(`substry:${key}`)?.value;
      const mark = unplaced ? `genretry:${key}` : artistAsk ? `substry:${key}` : `yeartry:${key}`;
      try {
        if (unplaced) {
          const { tags } = await this.lookUpGenres(next, this.searchMeter());
          if (tags.length) await this.store.put(SAVED_TAGS_KEY, { ...(this.store.get<Record<string, Tag[]>>(SAVED_TAGS_KEY) ?? {}), [key]: tags });
        } else if (artistAsk) {
          // A main genre and no subgenre: what MusicBrainz's listeners call the artist (GENRE-ALL-001).
          await this.askArtist(next, this.searchMeter());
        } else {
          // Still nothing finer: the year the song came out (Deezer), so its era names the subgenre.
          const dated = LocalApi.dated(next, await this.deezerFacts(next, { meter: this.searchMeter() }));
          const date = dated['release'] ? { release: dated['release'] } : typeof dated['year_hint'] === 'number' ? { year_hint: dated['year_hint'] } : null;
          if (date) await this.store.put(SAVED_DATES_KEY, { ...(this.store.get<Record<string, Dict>>(SAVED_DATES_KEY) ?? {}), [key]: date });
        }
        await this.store.cachePut(mark, 'metadata', true, mark.startsWith('yeartry') ? 30 * 24 * 3600 : 24 * 3600);
      } catch (e) {
        if (e instanceof BudgetExceeded) return;
        await this.store.cachePut(mark, 'metadata', true, 6 * 3600);
      }
    }
  }

  /** The saved songs' tracks with whatever tags are already known for them (no lookups). */
  private savedRaw(): Dict[] {
    const found = this.store.get<Record<string, Tag[]>>(SAVED_TAGS_KEY) ?? {};
    const fresher = this.knownTracks();
    const out: Dict[] = [];
    const seen = new Set<string>();
    const rows = this.store.feedback();
    const removed = new Set(rows.filter((r) => r.kind === 'dislike').map((r) => r.key));
    for (const r of [...rows].reverse()) {
      if ((r.kind !== 'like' && r.kind !== 'save') || !r.track || seen.has(r.key) || removed.has(r.key)) continue;
      seen.add(r.key);
      const t = r.track as Dict;
      const tags = statedTags(t).length ? t['tags'] : statedTags(fresher.get(r.key) ?? {}).length ? fresher.get(r.key)!['tags'] : found[r.key] ?? [];
      out.push(this.withDate({ ...t, tags }));
    }
    // TAGS-ALWAYS-001: starting songs nothing knows the genre of are looked up the same way.
    const known = this.knownGenres();
    for (const s of this.store.seeds() as Dict[]) {
      const key = String(s['key'] ?? '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const tags = statedTags(s).length ? s['tags'] : known(s).length ? known(s) : found[key] ?? [];
      out.push(this.withDate({ ...s, tags }));
    }
    // And the songs of saved lists and albums (imported files have their own lookup; programmes are not songs).
    for (const l of this.storedPlaylists()) for (const e of l.entries) {
      if (seen.has(e.key)) continue;
      const t = fresher.get(e.key);
      if (!t || t['kind'] === 'radio-programme' || t['provider'] === 'imported') continue;
      seen.add(e.key);
      const tags = statedTags(t).length ? t['tags'] : known(t).length ? known(t) : found[e.key] ?? [];
      out.push(this.withDate({ ...t, tags }));
    }
    return out;
  }

  // ---- saved lists ---------------------------------------------------------------------

  private storedPlaylists(): Playlist[] {
    return parsePlaylists(this.store.get('playlists'));
  }

  /** Every song the listener has actually finished, which is what gates a list's own discovery. */
  private playedKeys(): Set<string> {
    return new Set(this.store.feedback().filter((r) => r.kind === 'complete').map((r) => r.key));
  }

  /**
   * The lists, each with the songs it holds resolved back to tracks. A song whose track was never
   * recorded still counts towards the list's length, so the discovery gate cannot be fooled by it.
   */
  private playlists(): Dict {
    const lists = this.storedPlaylists();
    const played = this.playedKeys();
    const byKey = this.knownTracks();
    // IMPORT-GENRES-001: imported songs still waiting for their genres are looked up in the background;
    // opening the app (which reads the lists) starts it, so nothing waits for a song to be queued.
    const wanting = new Set(this.importedWanting().map((t) => String(t['key'])));
    if (wanting.size) this.kickImportedGenres();
    // TAGS-ALWAYS-001 / RADIO-GENRES-001 (owner, 2026-11-19): a list's songs show genres like Saved's do:
    // their own tags, a fresher copy's, ones looked up for them, or what is known of them already.
    const found = this.store.get<Record<string, Tag[]>>(SAVED_TAGS_KEY) ?? {};
    const known = this.knownGenres();
    const withTags = (t: Dict | null): Dict | null => {
      if (!t || t['kind'] === 'radio-programme' || (t['provider'] === 'imported' && !t['catalogue_match'])) return t;
      if (statedTags(t).length) return this.withDate(t);
      const key = String(t['key']);
      const own = found[key]?.length ? found[key]! : known(t);
      return this.withDate(own.length ? { ...t, tags: own } : t);
    };
    if (lists.some((l) => l.entries.some((e) => { const t = withTags(byKey.get(e.key) ?? null); return t && t['kind'] !== 'radio-programme' && t['provider'] !== 'imported' && this.savedWants(t); }))) this.kickSavedGenres();
    return {
      lists: lists.map((l) => {
        const pending = l.entries.filter((e) => wanting.has(e.key)).length;
        const items = l.entries.map((e) => ({ key: e.key, added: e.added, track: withTags(byKey.get(e.key) ?? null), played: played.has(e.key) }));
        return {
          id: l.id,
          name: l.name,
          created: l.created,
          count: l.entries.length,
          unplayed: unplayedCount(l, played),
          discovery_ready: playlistFullyPlayed(l, played),
          album: l.album ?? null,
          items: this.importedCharacteristics(items),
          ...(pending ? { genre_pending: pending } : {}),
        };
      }),
    };
  }

  /**
   * IMPORT-GENRES-001 / GENRE-ALL-001: an imported song a confident match placed is shown like any
   * other row: its stated genres, then what genre-fill.ts estimates for what it still lacks (drawn as
   * an estimate). A song with no confident identity gets nothing, so it shows no genre at all.
   */
  private importedCharacteristics<T extends { track: Dict | null }>(items: T[]): T[] {
    // SAVED-GENRES-001: any saved song with stated tags is shown with its genres (GENRE-ALL-001); an
    // imported one only once a confident match confirmed who it is.
    // TAGS-ALWAYS-001: a list song with no stated genre is filled too (drawn as an estimate) once it is known who it is.
    const placed = (t: Dict | null): t is Dict => Boolean(t && t['kind'] !== 'radio-programme' && (t['provider'] !== 'imported' || t['catalogue_match']));
    if (!items.some((x) => placed(x.track))) return items;
    const fill = this.genreFiller(items.filter((x) => x.track) as unknown as Dict[]);
    return items.map((x) => (placed(x.track) ? { ...x, characteristics: fill(x.track, characteristicsOf(x.track, null)) } : x));
  }

  private async savePlaylists(lists: Playlist[]): Promise<void> {
    await this.store.put('playlists', lists);
    // The copies of songs held for lists are kept exactly as long as some list holds the song.
    const held = this.store.get<Record<string, Dict>>(LIST_TRACKS_KEY) ?? {};
    const wanted = new Set(lists.flatMap((l) => l.entries.map((e) => e.key)));
    const kept = Object.fromEntries(Object.entries(held).filter(([k]) => wanted.has(k)));
    if (Object.keys(kept).length !== Object.keys(held).length) await this.store.put(LIST_TRACKS_KEY, kept);
    // IMPORT-GENRES-001: a list just saved with imported songs starts their lookup in the background.
    if (this.importedWanting().length) this.kickImportedGenres();
  }

  /** ALBUM-SAVE-001: the saved albums as album-taste keys (primary artist and title, folded). */
  private savedAlbumKeys(): { key: string; name: string }[] {
    return this.storedPlaylists().flatMap((l) => {
      const key = l.album ? albumKeyOf({ album: l.name, artists: [l.album.artist], title: '' }) : null;
      return key ? [{ key, name: l.name }] : [];
    });
  }

  /** The songs a list was made with, newest kept when the store would grow past its bound. */
  private async rememberListTracks(tracks: Dict[]): Promise<void> {
    const held = { ...(this.store.get<Record<string, Dict>>(LIST_TRACKS_KEY) ?? {}) };
    for (const t of tracks) {
      const k = String(t['key']);
      const before = held[k];
      delete held[k];
      const clean = cleanTrack(t);
      // IMPORT-GENRES-001: the file's own genre word, kept only to use once the song's identity is confirmed.
      if (t['provider'] === 'imported' && typeof t['file_genre'] === 'string' && t['file_genre']) clean['file_genre'] = t['file_genre'].slice(0, 100);
      held[k] = withImportFactsOf(clean, before);
    }
    await this.store.put(LIST_TRACKS_KEY, held);
  }

  /** One POST for every list edit, so the engine keeps its flat exact-path routing. */
  private async playlistAction(body: Dict): Promise<LocalResponse> {
    const action = String(body['action'] ?? '');
    const ids = (Array.isArray(body['ids']) ? body['ids'] : body['id'] ? [body['id']] : []).map(String);
    const key = String(body['key'] ?? '');
    let lists = this.storedPlaylists();
    try {
      if (action === 'create') {
        lists = createPlaylist(lists, body['name'], unixNow(), newId());
        // Creating a list straight from the like menu puts the song in it in the same step.
        if (key) lists = addToPlaylists(lists, [lists[lists.length - 1]!.id], key, unixNow());
        // ALBUM-OPEN-001: a list made from an album brings its songs, kept so the list can show and
        // play every one of them, not only the songs the listener has already played.
        const tracks = (Array.isArray(body['tracks']) ? (body['tracks'] as unknown[]) : [])
          .filter((t): t is Dict => Boolean(t) && typeof t === 'object' && typeof (t as Dict)['key'] === 'string' && Boolean((t as Dict)['key']))
          .slice(0, PLAYLIST_TRACKS_MAX);
        if (tracks.length) {
          const id = lists[lists.length - 1]!.id;
          for (const t of tracks) lists = addToPlaylists(lists, [id], String(t['key']), unixNow());
          await this.rememberListTracks(tracks);
        }
      } else if (action === 'save_album') {
        // ALBUM-SAVE-001: keep a whole album in Saved, its songs in album order, found again by its id.
        const a = (body['album'] && typeof body['album'] === 'object' ? body['album'] : {}) as Dict;
        const tracks = (Array.isArray(a['tracks']) ? (a['tracks'] as unknown[]) : [])
          .filter((t): t is Dict => Boolean(t) && typeof t === 'object' && typeof (t as Dict)['key'] === 'string' && Boolean((t as Dict)['key']))
          .slice(0, PLAYLIST_TRACKS_MAX);
        const id = typeof a['id'] === 'string' ? a['id'].slice(0, 80) : '';
        if (!id) return fail(400, 'Which album?');
        if (!tracks.length) return fail(400, 'None of this album\u2019s songs can be saved.');
        const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
        lists = saveAlbum(lists, {
          id, title: a['title'], provider: str(a['provider'], 20) ?? 'deezer', artist: str(a['artist'], 200) ?? '',
          artwork: str(a['artwork'], 500), year: str(a['year'], 10), kind: str(a['kind'], 20) ?? 'album', url: str(a['url'], 500) ?? '',
        }, tracks.map((t) => String(t['key'])), unixNow(), newId());
        await this.rememberListTracks(tracks);
      } else if (action === 'rename') {
        lists = renamePlaylist(lists, ids[0] ?? '', body['name']);
      } else if (action === 'delete') {
        lists = deletePlaylist(lists, ids[0] ?? '');
      } else if (action === 'add') {
        if (!key) return fail(400, 'Which song?');
        lists = addToPlaylists(lists, ids, key, unixNow());
        // Radio/programme bookmarks may never have been liked or heard to completion. Retain the
        // actual selected entry so its station and metadata still resolve after reopening the app.
        const snapshot = (Array.isArray(body['tracks']) ? body['tracks'] : [])
          .find((t): t is Dict => Boolean(t) && typeof t === 'object' && (t as Dict)['key'] === key);
        if (snapshot) await this.rememberListTracks([snapshot]);
      } else if (action === 'remove') {
        if (!key) return fail(400, 'Which song?');
        lists = removeFromPlaylists(lists, ids, key);
      } else if (action === 'set') {
        // The like menu sends the whole ticked set, so unticking removes in the same call.
        if (!key) return fail(400, 'Which song?');
        const wanted = new Set(ids);
        const holding = playlistsHolding(lists, key);
        lists = addToPlaylists(lists, [...wanted], key, unixNow());
        lists = removeFromPlaylists(lists, holding.filter((id) => !wanted.has(id)), key);
      } else {
        return fail(400, `Unknown list action “${action}”.`);
      }
    } catch (e) {
      if (e instanceof PlaylistError) return fail(400, e.message);
      throw e;
    }
    await this.savePlaylists(lists);
    return ok(this.playlists());
  }

  // ---- playback ------------------------------------------------------------------------
  private async previewUrl(tid: string): Promise<LocalResponse> {
    try {
      const hit = this.store.cacheGet(`dz:track:${tid}`);
      const url = await this.dz.freshPreview(tid, ((hit?.value as Dict | undefined)?.['preview'] as string | undefined) ?? null, { meter: this.playbackMeter() });
      return url ? ok({ url }) : fail(404, 'Deezer offers no preview for this track');
    } catch (e) {
      return fail(502, `Deezer did not answer: ${(e as Error).message}`);
    }
  }

  /**
   * Embed the complete song the shell already holds for this track (FULL-SONG-EMBED-001).
   *
   * The audio model has only ever analysed Deezer's 30-second preview, so a song with no Deezer
   * match was scored with no audio at all. The queue cache holds the whole track, which is both a
   * better description and the only one those songs can have.
   *
   * The bytes come off the device's own disk through the shell, so this is deliberately not metered:
   * the daily allowance is about network transfer and none happens here. Already-embedded songs are
   * reported rather than re-run, so playing a song twice costs nothing.
   */
  /** RADIO-001: a bounded acoustic SAMPLE, never labelled a complete song. No raw audio leaves
   * this device. A full-song vector already held is never overwritten by a radio clip. */
  private async radioAnalyse(body: Dict): Promise<LocalResponse> {
    let raw = String(body['pcm'] ?? ''); const t = body['track'] as Dict | undefined;
    const sessionId = String(body['sessionId'] ?? '');
    if (/^[a-f0-9-]{36}$/i.test(sessionId)) {
      const sample = await fetch('/radio-native?q=' + encodeURIComponent(JSON.stringify({ op: 'sample', id: sessionId }))).then(r => r.json()) as { pcm?: string };
      raw = sample.pcm || '';
    }
    if (!t?.['key'] || !raw || raw.length > 600000 || !/^[A-Za-z0-9+/=]+$/.test(raw)) return fail(400, 'A recognised track and a bounded PCM sample are required.');
    if (!this.encoder) return ok({ embedded: false, bpm: null, note: 'Acoustic model unavailable on this device' });
    const bytes = atob(raw); if (bytes.length % 2 || bytes.length < 16000 * 2 * 4) return fail(400, 'At least four seconds of 16 kHz PCM are required.');
    const n = bytes.length / 2, y = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { let v = bytes.charCodeAt(i * 2) | bytes.charCodeAt(i * 2 + 1) << 8; if (v >= 32768) v -= 65536; let next = i + 1 < n ? bytes.charCodeAt((i + 1) * 2) | bytes.charCodeAt((i + 1) * 2 + 1) << 8 : v; if (next >= 32768) next -= 65536; for (let k = 0; k < 3; k++) y[i * 3 + k] = (v + (next - v) * k / 3) / 32768; }
    const r = await this.encoder.analyse(y, true, 2); const rec = songVectorKey(String(t['key']));
    if (r.tooShort) return ok({ embedded: false, bpm: r.bpm, note: 'Not enough usable broadcast audio' });
    if (r.vector && !this.store.vectorSource(rec, A.MODEL_ID, A.PREPROCESS_ID)) await this.store.vectorPut(rec, A.MODEL_ID, A.PREPROCESS_ID, r.vector, 'radio-clip-12s');
    if (r.bpm) await this.store.put(`bpm:${rec}`, r.bpm);
    return ok({ embedded: !!r.vector, bpm: r.bpm, note: 'Measured from a short live broadcast sample' });
  }

  private async embedLocal(body: Dict): Promise<LocalResponse> {
    if (!this.encoder) return fail(409, 'The audio model is not available on this device.');
    const t = body['track'] as Dict | undefined;
    const url = String(body['source_url'] ?? '');
    const key = String(t?.['key'] ?? '');
    if (!t || !url || !key) return fail(400, 'A track with its key and its local source link are both needed.');
    const rec = songVectorKey(key);
    const had = this.store.vectorSource(rec, A.MODEL_ID, A.PREPROCESS_ID);
    if (had && !had.startsWith('radio-clip')) return ok({ embedded: false, already: true, source: had, segments: null, seconds: null });
    // TASTE-FULL-BOUND-001: the whole file is decoded to raw audio in the page (~0.8 MB a second of
    // song) before its few segments are picked, so a long song is left out rather than risk the page.
    const seconds = Number(t['duration']);
    if (Number.isFinite(seconds) && seconds > FULL_SONG_MAX_SECONDS) {
      return ok({ embedded: false, already: false, skipped: 'long', source: null, segments: null, seconds: null });
    }
    let data: Uint8Array | null;
    try {
      const res = await fetch(localAudioUrl(url));
      if (!res.ok) return fail(404, `That song is not in the queue cache yet (HTTP ${res.status}).`);
      data = await readAtMost(res, FULL_SONG_MAX_BYTES);
    } catch (e) {
      return fail(502, `The queue cache could not be read: ${(e as Error).message}`);
    }
    if (data === null) return ok({ embedded: false, already: false, skipped: 'large', source: null, segments: null, seconds: null });
    const job = new Job('embed-local');
    const r = await this.pipeline.embedFullSong(job, rec, data);
    if (!r) return fail(422, 'That song could not be analysed.', { audio: job.audio });
    return ok({ embedded: true, already: false, source: r.source, segments: r.segments, seconds: Math.round(r.seconds), bytes: data.length });
  }

  private async fullSong(body: Dict): Promise<LocalResponse> {
    const raw: Dict | undefined = body['track'];
    if (!raw || typeof raw !== 'object' || !raw['title'] || !Array.isArray(raw['artists'] ?? [])) return fail(400, 'A track with a title is needed.');
    const t: Dict = { ...raw, artists: ((raw['artists'] as unknown[]) ?? []).map(String).slice(0, 6), title: String(raw['title']).slice(0, 200) };
    const exclude = (Array.isArray(body['exclude']) ? (body['exclude'] as unknown[]).map(String) : []).slice(0, 8);
    // FOLDER-IMPORT-PLAY-001: an imported file is its own full song. Answer from the track itself,
    // before the cache key (whose duration part differs between import and saved-list copies).
    if (t['provider'] === 'imported' && typeof t['url'] === 'string' && t['url'].startsWith('imported:') && t['url'].length <= 2000) {
      return ok({ id: null, url: t['url'], source: 'imported' });
    }
    const own = t['provider'] === 'ytmusic' && t['platform_id'] ? String(t['platform_id']) : null;
    if (own && !exclude.includes(`https://music.youtube.com/watch?v=${own}`)) return ok({ id: own, source: 'own' });
    const key = `fullsong:${t['title']}|${(t['artists'] as string[]).join('|')}|${t['duration']}`;
    const hit = this.store.cacheGet(key);
    // PASSIVE-CACHE-001: retry a miss against the provider, not the six-hour negative cache.
    // Positive matches are reusable; passive retry must not discard working source identities.
    const retry = body['retry'] === true;
    const cached = hit?.value as Dict | undefined;
    // Older builds cached uncertain `close` matches for seven days. Never resurrect them as full
    // songs even when their link once downloaded; refresh the source chain instead.
    // SC-NOLINK-001: a site match is fetched by its link; one cached without a link cannot play.
    const siteWithoutLink = ['soundcloud', 'bandcamp', 'audius', 'hearthis', 'archive'].includes(String(cached?.['source'])) && !cached?.['url'];
    const cachedPlayable = cached?.['source'] !== 'close' && !siteWithoutLink;
    // SOURCE-HEARTHIS-002: a cached HearThis link is permission that can be withdrawn. Re-read the
    // creator's own public JSON and re-gate license/download/identity before reusing the link.
    if (cachedPlayable && !exclude.length && hit && cached?.['source'] === 'hearthis' && typeof cached['url'] === 'string') {
      const still = await this.hearthis.revalidate(String(cached['url']), { meter: this.playbackMeter() });
      if (!still || matchRecordings(t as never, still).verdict !== 'same') {
        const out: FullSongResult = { id: null, source: 'none' };
        await this.store.cachePut(key, 'meta', out, NO_SOURCE_TTL);
        return ok(out);
      }
      return ok(hit.value);
    }
    // SOURCE-SWAP-001: a caller naming dead links already knows the cached answer does not work,
    // so the cache is skipped entirely rather than handing back the link that just failed.
    if (cachedPlayable && !exclude.length && hit && (!retry || cached?.['id'] || cached?.['url'])) return ok(hit.value);
    const ctx = { meter: this.playbackMeter(), refresh: retry };
    // SOURCE-CHAIN-001: ask every source that can produce a downloadable link, in order of
    // confidence, rather than recording "no source" after one YouTube Music query.
    let out: FullSongResult;
    try {
      out = await findFullSong(t as never, {
        ytm: this.ytm as never,
        sc: this.sc as never,
        videos: { search: (q: string, limit: number, c: unknown) => this.ytm.searchVideos(q, limit, c as never) } as never,
        bandcamp: this.bandcamp as never,
        audius: this.audius as never,
        hearthis: this.hearthis as never,
        archive: this.archive as never,
      }, { ctx, exclude });
    } catch (e) {
      if (e instanceof FetchError || e instanceof ProviderError) return fail(502, `No source answered: ${e.message}`);
      throw e;
    }
    const got = out.id || out.url;
    // A miss expires quickly: uploads appear over time, and the owner wants the list to fill in.
    await this.store.cachePut(key, 'meta', out, got ? 7 * 86400 : NO_SOURCE_TTL);
    return ok(out);
  }

  /**
   * FOLDER-IMPORT-001: register imported local songs with the source chain. Each one is written
   * into the full-song cache as its own answer ({ url: 'imported:<path>' }), under EXACTLY the key
   * fullSong() builds for the track, so playing an imported song resolves to its own file without
   * ever searching the music services. Idempotent: the settings page re-registers on each import
   * and whenever it opens, which also heals an entry the LRU cache evicted.
   */
  private async importLocal(body: Dict): Promise<LocalResponse> {
    const songs = Array.isArray(body['songs']) ? (body['songs'] as unknown[]).slice(0, 2000) : [];
    let registered = 0;
    for (const raw of songs) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Dict;
      const url = typeof s['url'] === 'string' ? s['url'] : '';
      if (!url.startsWith('imported:') || url.length > 2000 || !s['title']) continue;
      // The same normalisation fullSong() applies to the track it is asked about.
      const t: Dict = { ...s, artists: ((s['artists'] as unknown[]) ?? []).map(String).slice(0, 6), title: String(s['title']).slice(0, 200) };
      const key = `fullsong:${t['title']}|${(t['artists'] as string[]).join('|')}|${t['duration']}`;
      await this.store.cachePut(key, 'meta', { id: null, url, source: 'imported' }, IMPORTED_SOURCE_TTL);
      registered++;
    }
    return ok({ registered });
  }

  // ---- status / reset / self-test --------------------------------------------------------
  private async status(): Promise<Dict> {
    const settings = this.settings();
    let free = 0;
    let quota = 0;
    let usage = 0;
    try {
      const est = await navigator.storage?.estimate?.();
      usage = est?.usage ?? 0;
      quota = est?.quota ?? 0;
      free = Math.max(0, quota - usage);
    } catch {
      /* storage estimates are optional */
    }
    const cache = this.store.cacheBytes();
    // STORAGE-TRUTH-001: `navigator.storage.estimate()` only sees this origin's own data. The full
    // songs the app downloads live in the native shell's private audio cache, so the honest answer
    // has to be asked for over the bridge, and it is what the owner's size limit actually governs.
    let queueAudio: { bytes: number; limit: number } | null = null;
    if (downloadsAvailable()) {
      try {
        const h = await dl.health();
        if (Number.isFinite(h.cache_bytes) && Number.isFinite(h.cache_limit_bytes)) queueAudio = { bytes: Number(h.cache_bytes), limit: Number(h.cache_limit_bytes) };
      } catch {
        /* an older shell has no cache figures; report app data alone rather than inventing one */
      }
    }
    return {
      storage: { areas: { cache, other: Math.max(0, usage - cache) }, queue_audio: queueAudio, app_data: usage, limits: { cache: 150_000_000 }, total: usage + (queueAudio?.bytes ?? 0), hard_cap: quota, target: quota, free_disk: free, not_counted: 'Songs you Download are copied to your music folder and are not counted here.' },
      transfer_today: this.store.transferToday(), transfer_daily_cap: Math.trunc(Number(settings['daily_mb']) * 1e6), transfer_request_cap: Math.trunc(Number(settings['request_mb']) * 1e6),
      transfer_note: 'Network the page itself read today. Songs fetched by the built-in downloader do not pass through the page and are not counted here.',
      cache: { hits: this.store.cacheHits, misses: this.store.cacheMisses, bytes: cache, vectors: this.store.vectorCount() },
      startup_ms: Math.round(this.started), memory: { rss: null, peak: null }, audio: this.audioState(), health_checked_at: this.healthAt, telemetry: 'none',
    };
  }

  private reset(clearCache: boolean): LocalResponse {
    this.store.reset(!clearCache);
    for (const j of this.jobs.values()) j.token.cancel('the app was reset');
    this.pool = null;
    return ok({ ok: true, cache_kept: !clearCache });
  }

  /** Forget the learned taste only: plays, likes, dislikes, skips and impressions. Starting songs, settings and cache stay. */
  private resetTaste(): LocalResponse {
    this.store.resetTaste();
    return ok({ ok: true });
  }

  /** Empty the song list: starting songs and the remembered queue. Taste, history and settings stay. */
  private async clearQueue(): Promise<LocalResponse> {
    for (const j of this.jobs.values()) j.token.cancel('the list was cleared');
    await this.store.setSeeds([]);
    // Forget the pool too, or the next batch would compare against a list that no longer exists
    // and a re-rank could bring the cleared songs back.
    this.dropDiscoveries();
    // A cleared queue is no longer a saved list's, and there is nothing to go back to.
    this.store.drop(QUEUE_PLAYLIST_KEY);
    this.store.drop(QUEUE_SAVED_KEY);
    return ok({ ok: true });
  }

  private async selftest(): Promise<LocalResponse> {
    if (!this.encoder) return fail(409, 'Audio model is not available on this device.');
    const job = new Job('selftest');
    const daily = Math.trunc(Number(this.settings()['daily_mb']) * 1e6);
    job.meter = new Meter(5_000_000, Math.max(0, daily - Object.values(this.store.transferToday()).reduce((a, b) => a + b, 0)), (c, n) => this.store.addTransfer(c, n));
    const t0 = performance.now();
    try {
      const pairs: [string, Float64Array][] = [];
      for (const q of ['daft punk around the world', 'chopin nocturne op 9 no 2 rubinstein']) {
        const res = await this.dz.search(q, 3, { meter: job.meter });
        const t = res.find((x) => x.preview);
        if (!t) throw new ProviderError(`Deezer returned no preview for “${q}”`);
        const v = await this.pipeline.vectorFor(job, t.platform_id, t.preview);
        if (!v) throw new ProviderError(`could not embed “${t.title}”: ${JSON.stringify(job.audio)}`);
        pairs.push([`${t.title} — ${t.artist}`, v]);
      }
      const [[na, va], [nb, vb]] = pairs as [[string, Float64Array], [string, Float64Array]];
      this.audioCheck = {
        state: 'working', detail: `Compared two real previews: ${na} vs ${nb}`, cosine: round(A.cosine(va, vb), 3), self: round(A.cosine(va, va), 3),
        infer_ms: job.audio['infer_ms'], bytes: { ...job.meter.counts }, ms: Math.round(performance.now() - t0), checked: unixNow(),
      };
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        const prev = this.audioCheck['state'] === 'working' ? this.audioCheck : { state: 'not_tested' };
        const real = prev['real_detail'] ?? prev['detail'];
        this.audioCheck = { ...prev, real_detail: real, checked: unixNow(), detail: "Not tested now: today's download allowance is nearly used (Settings → Daily download allowance)." + (real ? ` Last real test: ${real}` : '') };
      } else {
        this.audioCheck = { state: 'unavailable', detail: `${(e as Error).name}: ${String((e as Error).message).slice(0, 160)}`, checked: unixNow() };
      }
    }
    return ok(this.audioCheck);
  }
}

export { fold };
