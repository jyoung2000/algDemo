/**
 * The app's own API (port of server/airwave_discovery/app.py), answered in-process so the Android APK
 * needs no server. `handle()` takes what the UI would have sent to /api/* and returns what the server
 * would have answered, status code included. Jobs run as async tasks; the browser polls them as before.
 */
import * as A from './audio';
import { DEFAULT_ENGINE, TRANSFER, engineWithWeights } from './config';
import { EQ_DEFAULTS, parseEq } from './eq';
import { PLAY_THROUGH_DEFAULT, clampPlayThrough, clampSlider } from './crossfade';
import { appendDiscovery, needsListeningDiscovery, newDiscoveryTracks } from './discovery';
import {
  PlaylistError,
  addToPlaylists,
  createPlaylist,
  deletePlaylist,
  parsePlaylists,
  playlistFullyPlayed,
  playlistsHolding,
  removeFromPlaylists,
  renamePlaylist,
  unplayedCount,
  type Playlist,
} from './playlists';
import { Deezer, NeedsChoice, ProviderError, type Ctx } from './deezer';
import * as E from './engine';
import { buildTaste, tasteSummary, tasteFit, type TasteProfile } from './taste';
import { buildTasteBlend, type TasteBlend } from './taste2';
import { ARTIST_SUBS_KEY, withArtistSubs, type ArtistSubsMap } from './artist-subs';
import { fold, matchRecordings } from './identity';
import { buildProfile } from './profile';
import { classify } from './classify';
import { makeTag } from './genres';
import { inferFromArtist, inferFromSeed, inferFromSound, recordArtistGenres } from './infer';
import { BlockedUrl, BudgetExceeded, Cancelled, FetchError, Http, type HttpPort, Meter } from './net';
import { Job, Pipeline, pmap, type Embedder } from './pipeline';
import { SOURCE_LABELS, cleanTrack, playbackFor, round, type Dict } from './shape';
import { AppleMusic } from './apple';
import { SoundCloud } from './soundcloud';
import { Spotify, looksLikeUrl, normaliseUrl, providerForUrl } from './spotify';
import type { Store } from './store';
import { YouTubeMusic } from './ytmusic';
import { Genius, Shazam } from './listen/providers';
import { resolveHits, type Evidence } from './listen/identify';

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
  let tags = (c['tags'] as Dict[] | undefined) ?? [];
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
  const lead = [...tags].sort((a, b) => Number(b['confidence'] ?? 0) - Number(a['confidence'] ?? 0))[0];
  return {
    family: cls?.family ?? null,
    subgenre: cls?.subgenre ?? null,
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
const DEFAULT_SETTINGS = { fresh: false, adventurous: 0.5, audio: true, daily_mb: TRANSFER.daily / 1e6, request_mb: TRANSFER.perRequest / 1e6, sample_mode: false, queue_size: DEFAULT_ENGINE.queueSize, discover_while_listening: true, rank_v2: true, eq: EQ_DEFAULTS, mix: 0, local_mix: true, play_through: PLAY_THROUGH_DEFAULT };
/** How many songs one discovery run adds to the list: the user's choice in Settings. */
export const QUEUE_SIZE_MIN = 5;
export const QUEUE_SIZE_MAX = 60;
const FEEDBACK_KINDS = new Set(['like', 'dislike', 'hide', 'save', 'replay', 'complete', 'skip', 'unlike', 'unsave', 'undislike', 'unhide']);
const CAPS = ['search', 'resolve_link', 'related_candidates', 'artist_candidates', 'recent_candidates', 'playback_link'];

const ok = (body: unknown, status = 200): LocalResponse => ({ status, body });
const fail = (status: number, message: string, extra: Dict = {}): LocalResponse => ({ status, body: { message, detail: message, ...extra } });
const unixNow = (): number => Date.now() / 1000;
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

export class LocalApi {
  readonly store: Store;
  readonly http: Http;
  readonly dz: Deezer;
  readonly ytm: YouTubeMusic;
  readonly sc: SoundCloud;
  readonly apple: AppleMusic;
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
    this.apple = new AppleMusic(this.http, this.store);
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
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  /**
   * The allowance for the lookups that start a song (which YouTube video to play, a fresh preview address).
   * They read a few kilobytes and the song itself streams from YouTube's player, so a spent daily discovery
   * allowance must not stop a song from playing. What they read still counts toward the day's total.
   */
  private playbackMeter(): Meter {
    return new Meter(3_000_000, 3_000_000, (c, n) => this.store.addTransfer(c, n));
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
      if (m === 'POST' && path === '/api/identify/audio') return await this.identifyAudio(body ?? {});
      if (m === 'POST' && path === '/api/resolve') return await this.resolve(String(body?.['url'] ?? ''));
      if (m === 'POST' && path === '/api/complete-spotify') return ok(await this.completeSpotify(String(body?.['title'] ?? ''), String(body?.['artist'] ?? '')));
      if (path === '/api/seeds') return m === 'PUT' ? await this.putSeeds(body ?? {}) : ok({ seeds: this.store.seeds() });
      if (path === '/api/settings') return m === 'PUT' ? await this.putSettings(body ?? {}) : ok(this.settings());
      if (m === 'POST' && path === '/api/recommend') return this.recommend(body ?? {});
      const job = /^\/api\/jobs\/([A-Za-z0-9]+)$/.exec(path);
      if (job) return m === 'DELETE' ? this.cancelJob(job[1]!) : this.jobStatus(job[1]!);
      if (m === 'POST' && path === '/api/feedback') return await this.feedback(body ?? {});
      if (m === 'POST' && path === '/api/import/history') return await this.importHistory(body ?? {});
      if (m === 'GET' && path === '/api/feedback/state') return ok(this.feedbackState());
      if (m === 'POST' && path === '/api/impressions') return await this.impressions(body ?? {});
      if (m === 'POST' && path === '/api/full-song') return await this.fullSong(body ?? {});
      if (m === 'GET' && path === '/api/saved') return ok(this.saved());
      if (m === 'GET' && path === '/api/playlists') return ok(this.playlists());
      if (m === 'POST' && path === '/api/playlists') return await this.playlistAction(body ?? {});
      if (m === 'GET' && path === '/api/status') return ok(await this.status());
      if (m === 'POST' && path === '/api/reset') return this.reset(Boolean(body?.['clear_cache']));
      if (m === 'POST' && path === '/api/reset/taste') return this.resetTaste();
      if (m === 'POST' && path === '/api/queue/clear') return await this.clearQueue();
      if (m === 'POST' && path === '/api/model/install') return ok({ installed: this.encoder !== null, downloaded: 0 });
      if (m === 'POST' && path === '/api/model/selftest') return await this.selftest();
      if (m === 'POST' && path === '/api/rerank') return await this.rerank(body ?? {});
      if (m === 'GET' && path === '/api/profile') return ok(this.profile());
      if (m === 'GET' && path === '/api/last') {
        const r = this.store.get<Dict>('last_result');
        return r ? ok(r) : fail(404, 'No earlier recommendations yet.');
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
    const caps = (names: string[], h: Dict): Dict => Object.fromEntries(names.map((n) => [n, h]));
    const out: Dict = {
      deezer: caps(['search', 'resolve_link', 'related_candidates', 'artist_candidates', 'recent_candidates', 'playback_link'], dz),
      ytmusic: { ...caps(['search', 'resolve_link', 'playback_link'], yt), ...caps(['related_candidates', 'artist_candidates'], ytRadio) },
      soundcloud: { ...caps(['search', 'resolve_link', 'related_candidates'], sc), playback_link: sc },
      spotify: { resolve_link: spm, playback_link: spm },
    };
    for (const p of Object.keys(out)) for (const cap of CAPS) out[p][cap] ??= unsupported;
    out['spicetify'] = { companion: { state: 'not_tested', detail: 'Optional Spotify desktop bridge; not part of the phone app.', checked: unixNow(), latency_ms: null } };
    this.health = out;
    this.healthAt = unixNow();
    return out;
  }

  private async healthRoute(refresh: boolean): Promise<Dict> {
    if (refresh || !Object.keys(this.health).length || unixNow() - this.healthAt > 600) {
      this.healthRun ??= this.refreshHealth().finally(() => (this.healthRun = null));
      await this.healthRun;
    }
    return { providers: this.health, checked_at: this.healthAt, audio: this.audioState() };
  }

  private audioState(): Dict {
    return {
      model: A.MODEL_ID, preprocess: A.PREPROCESS_ID, dim: A.DIM, installed: this.encoder !== null, download_bytes: 0,
      source: 'Deezer 30-second previews', license: 'AGPL-3.0 (AudioMuse-AI-DCLAP)', check: this.audioCheck, vectors: this.store.vectorCount(),
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
          status[name] = { state: 'failed', detail: `${(e as Error).name}: ${String((e as Error).message).slice(0, 120)}`, ms: Math.trunc(performance.now() - t) };
          return [] as Dict[];
        }
      }),
    );
    const results = this.dedupe(lists).map((t) => ({ ...cleanTrack(t), also_on: t['also_on'] ?? [] }));
    const ms = performance.now() - t0;
    return { query: q, results, sources: status, ms: Math.round(ms), bytes: meter.total };
  }

  // ---- identify by lyrics / audio ------------------------------------------------------
  /** What went wrong with a Genius/Shazam call, in terms the UI has copy for. */
  private identifyFailure(e: unknown, what: 'lyrics' | 'audio'): LocalResponse {
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
    return ok({ seeds: this.store.seeds() });
  }

  private async putSettings(body: Dict): Promise<LocalResponse> {
    const cur = this.settings();
    if ('fresh' in body) cur['fresh'] = Boolean(body['fresh']);
    if ('adventurous' in body) cur['adventurous'] = Math.min(1, Math.max(0, Number(body['adventurous'])));
    for (const k of ['audio', 'sample_mode', 'rank_v2', 'discover_while_listening']) if (k in body) cur[k] = Boolean(body[k]);
    if ('daily_mb' in body) cur['daily_mb'] = Math.min(2000, Math.max(5, Number(body['daily_mb'])));
    if ('request_mb' in body) cur['request_mb'] = Math.min(200, Math.max(2, Number(body['request_mb'])));
    if ('queue_size' in body) {
      const n = Math.round(Number(body['queue_size']));
      if (!Number.isFinite(n) || n < QUEUE_SIZE_MIN || n > QUEUE_SIZE_MAX) return fail(400, `queue_size must be between ${QUEUE_SIZE_MIN} and ${QUEUE_SIZE_MAX}`);
      cur['queue_size'] = n;
    }
    if ('weights' in body) {
      try {
        engineWithWeights(body['weights']);
      } catch (e) {
        return fail(400, (e as Error).message);
      }
      cur['weights'] = body['weights'];
    }
    // The EQ and the mixer are stored through their own parsers, so a hand-edited or stale value
    // cannot put an out-of-range gain or a NaN slider into the audio graph.
    if ('eq' in body) cur['eq'] = parseEq(body['eq']);
    if ('mix' in body) cur['mix'] = clampSlider(Number(body['mix']));
    if ('play_through' in body) cur['play_through'] = clampPlayThrough(body['play_through']);
    await this.store.put('settings', cur);
    return ok(cur);
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
    if (listening) {
      const guard = this.listeningGuard(body, settings);
      if (guard.skip) return ok({ job: null, reason: guard.reason });
      seeds = guard.seeds;
    }
    if (!seeds.length) return fail(400, 'Add at least one starting song first.');
    if (this.currentJob) this.jobs.get(this.currentJob)?.token.cancel('superseded by a newer request');
    const job = new Job(newId());
    this.jobs.set(job.id, job);
    this.currentJob = job.id;
    for (const [k, j] of this.jobs) if (j.done && unixNow() - j.started > 900) this.jobs.delete(k);
    void this.runJob(job, seeds, settings, listening ? 'listening' : 'search');
    return ok({ job: job.id });
  }

  /**
   * Decides whether a finished song should spend anything on providers. Only a completed song that
   * came from the list counts, and only while the unplayed remainder is nearly gone; a skip, a
   * replay, a pause or a preview from search never starts a search. One listen starts one batch.
   */
  private listeningGuard(body: Dict, settings: Dict): { skip: true; reason: string } | { skip: false; seeds: Dict[] } {
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
    if (!needsListeningDiscovery(settings['discover_while_listening'] !== false, String(event['kind'] ?? ''), inList, remaining))
      return { skip: true, reason: 'The list does not need more songs yet.' };
    const active = this.currentJob ? this.jobs.get(this.currentJob) : null;
    if (active && !active.done) return { skip: true, reason: 'Discovery is already running.' };
    const handled = (this.store.get<string[]>('discovery_events') ?? []) as string[];
    if (handled.includes(eventId)) return { skip: true, reason: 'Already discovered for this listen.' };
    void this.store.put('discovery_events', [...handled.slice(-99), eventId]);
    // Follow what was actually heard as well as the original starting songs, without editing them:
    // the listener owns that list.
    const heard = (event['track'] ?? null) as Dict | null;
    return { skip: false, seeds: heard ? [heard, ...seeds.filter((s) => s['key'] !== event['key'])] : seeds };
  }

  private jobStatus(id: string): LocalResponse {
    const j = this.jobs.get(id);
    if (!j) return fail(404, 'unknown job');
    return ok({ job: j.id, phase: j.phase, progress: j.progress, done: j.done, error: j.error, result: j.result, elapsed_ms: Math.round((unixNow() - j.started) * 1000), sources: j.sources });
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
      phase, items, count: items.length, asked: cfg.queueSize, fresh: ctx.settings.fresh, adventurous: ctx.settings.adventurous,
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
      const items = appendDiscovery(previous, (batch['items'] ?? []) as { track: Dict }[], limit);
      return { ...batch, items, count: items.length, discovery: { added: items.length - previous.length, limit, trigger } };
    };
    try {
      const cfg = { ...engineWithWeights(settings['weights']), queueSize: Number(settings['queue_size'] ?? DEFAULT_ENGINE.queueSize) };
      const es = E.normaliseSettings({ fresh: Boolean(settings['fresh']), adventurous: settings['adventurous'] });
      job.meter = p.meter(settings);
      job.phase = 'profiling';
      job.progress = 'Looking up your starting songs';
      const profs = await pmap(seeds, 3, (sd) => p.profileSeed(job, sd));
      const profiles: Record<string, Dict> = {};
      seeds.forEach((sd, i) => (profiles[sd['key']] = profs[i] as Dict));
      const seedViews = seeds.map((sd) => p.seedView(sd, profiles[sd['key']] as Dict));
      job.timings['profile_ms'] = since();
      job.phase = 'gathering';
      job.progress = 'Asking the music services for related songs';
      // Feedback and impressions are ready before gathering so the first wave can be scored honestly.
      const fb = settings['rank_v2'] !== false ? E.buildFeedback2(this.store.feedback() as never, unixNow(), cfg) : E.buildFeedback(this.store.feedback() as never, unixNow(), cfg);
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
      const gathered = await p.gather(job, seedViews, profiles, cfg, es.fresh, onPartial);
      const related = gathered.related;
      // Only songs the list does not already hold can take a slot in this batch.
      const cands = newDiscoveryTracks(gathered.cands, held);
      job.timings['gather_ms'] = since() - job.timings['profile_ms'];
      job.timings['candidates'] = cands.length;
      if (!cands.length) {
        job.result = merge({
          phase: 'final', items: [], count: 0, asked: cfg.queueSize, sources: job.sources, audio: job.audio, timings: job.timings,
          transfer: { ...job.meter.counts },
          empty_reason: previous.length ? 'No new songs this time. Your list is unchanged.' : 'No service returned related songs for these starting songs.',
        });
        return;
      }
      const vectors = new Map<string, Float64Array>();
      const dzIdOf = (sv: Dict): string | null => sv['dz_preview_id'] || sv['dz_id'] || (sv['provider'] === 'deezer' ? sv['platform_id'] : null) || null;
      for (const sv of [...seedViews, ...cands]) {
        const did = dzIdOf(sv);
        const v = did ? this.store.vectorGet(`deezer:${did}`, A.MODEL_ID, A.PREPROCESS_ID) : null;
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
          for (const sv of seedViews) {
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
      cfg: { ...cfg, queueSize: Math.max(pool.cands.length, 1) },
      feedback: v2 ? E.buildFeedback2(this.store.feedback() as never, unixNow(), cfg) : E.buildFeedback(this.store.feedback() as never, unixNow(), cfg),
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
    return ok(out);
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
      const v = did ? this.store.vectorGet(`deezer:${did}`, A.MODEL_ID, A.PREPROCESS_ID) : null;
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
    if (kind === 'like') this.store.removeFeedback(key, ['dislike']);
    if (kind === 'dislike') this.store.removeFeedback(key, ['like']);
    const artist = (t['artists'] as string[] | undefined)?.[0]?.toLowerCase() ?? '';
    // v2 telemetry: optional, validated, stored alongside the event (old callers simply omit it).
    const num = (x: unknown, lo: number, hi: number): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);
    const str = (x: unknown, allowed?: string[]): string | null => (typeof x === 'string' && x.length > 0 && x.length <= 64 && (!allowed || allowed.includes(x)) ? x : null);
    const meta = {
      duration: num(body['duration'], 1, 36000),
      coverage: num(body['coverage'], 0, 36000),
      medium: str(body['medium'], ['preview', 'full', 'embed']),
      session: str(body['session']),
      origin: str(body['origin']),
      confidence: num(body['confidence'], 0, 1),
    };
    const hasMeta = Object.values(meta).some((v) => v !== null);
    const added = await this.store.addFeedback(eventId, key, kind, artist, cleanTrack(t), listened === null ? null : Number(listened), undefined, hasMeta ? meta : undefined);
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
    const cfg = { ...engineWithWeights(settings['weights']), queueSize: Number(settings['queue_size'] ?? DEFAULT_ENGINE.queueSize) };
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
    return { items };
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
    const byKey = new Map<string, Dict>();
    for (const r of this.store.feedback()) if (r.track) byKey.set(r.key, r.track as Dict);
    for (const it of (this.store.get<Dict>('last_result')?.['items'] ?? []) as { track: Dict }[]) {
      if (it.track) byKey.set(String(it.track['key']), it.track);
    }
    for (const s of this.store.seeds() as Dict[]) byKey.set(String(s['key']), s);
    return {
      lists: lists.map((l) => ({
        id: l.id,
        name: l.name,
        created: l.created,
        count: l.entries.length,
        unplayed: unplayedCount(l, played),
        discovery_ready: playlistFullyPlayed(l, played),
        items: l.entries.map((e) => ({ key: e.key, added: e.added, track: byKey.get(e.key) ?? null, played: played.has(e.key) })),
      })),
    };
  }

  private async savePlaylists(lists: Playlist[]): Promise<void> {
    await this.store.put('playlists', lists);
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
      } else if (action === 'rename') {
        lists = renamePlaylist(lists, ids[0] ?? '', body['name']);
      } else if (action === 'delete') {
        lists = deletePlaylist(lists, ids[0] ?? '');
      } else if (action === 'add') {
        if (!key) return fail(400, 'Which song?');
        lists = addToPlaylists(lists, ids, key, unixNow());
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

  private async fullSong(body: Dict): Promise<LocalResponse> {
    const raw: Dict | undefined = body['track'];
    if (!raw || typeof raw !== 'object' || !raw['title'] || !Array.isArray(raw['artists'] ?? [])) return fail(400, 'A track with a title is needed.');
    const t: Dict = { ...raw, artists: ((raw['artists'] as unknown[]) ?? []).map(String).slice(0, 6), title: String(raw['title']).slice(0, 200) };
    if (t['provider'] === 'ytmusic' && t['platform_id']) return ok({ id: t['platform_id'], source: 'own' });
    const key = `fullsong:${t['title']}|${(t['artists'] as string[]).join('|')}|${t['duration']}`;
    const hit = this.store.cacheGet(key);
    if (hit) return ok(hit.value);
    let found: Dict | null;
    try {
      found = (await this.ytm.findMatch(t as never, { meter: this.playbackMeter() })).match as Dict | null;
    } catch (e) {
      if (e instanceof FetchError || e instanceof ProviderError) return fail(502, `YouTube Music did not answer: ${e.message}`);
      throw e;
    }
    const out = found ? { id: found['platform_id'], source: 'match' } : { id: null, source: 'none' };
    await this.store.cachePut(key, 'meta', out, found ? 7 * 86400 : 6 * 3600);
    return ok(out);
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
    return {
      storage: { areas: { cache, other: Math.max(0, usage - cache) }, limits: { cache: 150_000_000 }, total: usage, hard_cap: quota, target: quota, free_disk: free, not_counted: 'Songs played in the embedded players are streamed by the player and not stored.' },
      transfer_today: this.store.transferToday(), transfer_daily_cap: Math.trunc(Number(settings['daily_mb']) * 1e6), transfer_request_cap: Math.trunc(Number(settings['request_mb']) * 1e6),
      transfer_note: 'Downloads made by the app itself. Playing songs in the embedded players streams directly and is not counted here.',
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
    this.store.drop('last_result');
    // Forget the pool too, or the next batch would compare against a list that no longer exists
    // and a re-rank could bring the cleared songs back.
    this.pool = null;
    this.store.drop('last_pool');
    this.store.drop('discovery_events');
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
