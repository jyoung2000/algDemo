/**
 * Candidate generation, enrichment and audio refinement for one recommendation request. TypeScript
 * port of server/airwave_discovery/candidates.py; the Python file is the reference for behaviour.
 *
 * Python's thread pools become bounded-concurrency maps. Order of results is kept, so the merge and the
 * round-robin across seeds give the same candidates as the server would.
 */
import * as A from './audio';
import { type EngineConfig, TRANSFER } from './config';
import { decodeToMono48k } from './decode';
import { type Ctx, type Deezer, ProviderError, cached } from './deezer';
import { fold, matchRecordings } from './identity';
import { tagsFromMusicBrainz } from './infer';
import { BudgetExceeded, CancelToken, Cancelled, type Http, Meter } from './net';
import type { SoundCloud } from './soundcloud';
import type { AppleMusic } from './apple';
import type { Track } from './track';
import type { Store } from './store';
import type { YouTubeMusic } from './ytmusic';
import type { Dict } from './shape';

export interface Embedder {
  embedAudio(y: Float32Array): Promise<{ vector: Float32Array; inferMs: number }>;
}

export class Job {
  token = new CancelToken();
  phase = 'starting';
  progress = '';
  result: Dict | null = null;
  error: string | null = null;
  started = Date.now() / 1000;
  timings: Dict = {};
  sources: Record<string, Dict> = {};
  audio: Dict = {};
  meter: Meter | null = null;
  done = false;
  constructor(readonly id: string) {}
}

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function pmap<T, R>(items: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type Rel = [Dict, string, string | null]; // track, relation, via
const NO_MATCH: { match: Track | null; uncertain: Track[] } = { match: null, uncertain: [] };
const DAY_MS = 86_400_000;

export class Pipeline {
  constructor(
    private readonly store: Store,
    private readonly http: Http,
    private readonly dz: Deezer,
    private readonly ytm: YouTubeMusic,
    private readonly sc: SoundCloud,
    private readonly apple: AppleMusic,
    private readonly spotifySearch: ((q: string, limit: number) => Promise<Dict[]>) | null,
    private readonly encoder: Embedder | null,
  ) {}

  installed(): boolean {
    return this.encoder !== null;
  }

  meter(settings: Dict): Meter {
    const daily = Math.trunc(Number(settings['daily_mb'] ?? TRANSFER.daily / 1e6) * 1e6);
    const perReq = Math.trunc(Number(settings['request_mb'] ?? TRANSFER.perRequest / 1e6) * 1e6);
    const used = Object.values(this.store.transferToday()).reduce((a, b) => a + b, 0);
    return new Meter(perReq, Math.max(0, daily - used), (c, n) => this.store.addTransfer(c, n));
  }

  private ctx(job: Job): Ctx {
    const c: Ctx = { token: job.token };
    if (job.meter) c.meter = job.meter;
    return c;
  }

  /** Run one source: degrade to `dflt` on any failure, record how it went, never fabricate. */
  async call<T>(job: Job, label: string, fn: () => Promise<T>, dflt: T): Promise<T> {
    job.token.check();
    const t = performance.now();
    const ms = () => Math.trunc(performance.now() - t);
    try {
      const out = await fn();
      job.sources[label] = { state: 'ok', count: Array.isArray(out) ? out.length : null, ms: ms() };
      return out;
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      if (e instanceof BudgetExceeded) {
        job.sources[label] = { state: 'budget', detail: e.message, ms: ms() };
        return dflt;
      }
      const err = e as Error;
      job.sources[label] = { state: 'failed', detail: `${err.name}: ${String(err.message).slice(0, 140)}`, ms: ms() };
      return dflt;
    }
  }

  // ---------------------------------------------------------------------------------------
  /** Find the seed on Deezer (preview, ISRC, BPM, album genres) and YouTube Music (radio). */
  async profileSeed(job: Job, seed: Dict): Promise<Dict> {
    const hit = this.store.cacheGet(`seedprofile:${seed['id']}`);
    if (hit) return hit.value as Dict;
    const c = this.ctx(job);
    const prof: Dict = { dz: null, ytm_vid: null, dz_uncertain: [] };
    const detail = (id: string) => this.call<Dict | null>(job, `seed-deezer:${seed['title']}`, async () => this.dz.withGenres(await this.dz.track(id, c), c) as Dict, null);
    if (seed['provider'] === 'deezer') {
      prof['dz'] = await detail(String(seed['platform_id']));
    } else {
      const res = await this.call(job, `seed-deezer-match:${seed['title']}`, () => this.dz.findMatch(seed as never, c), NO_MATCH);
      if (res.match) {
        const full = await detail(String(res.match.platform_id));
        prof['dz'] = full ?? res.match;
      }
      prof['dz_uncertain'] = res.uncertain.map((u) => u['title']);
    }
    if (seed['provider'] === 'ytmusic') {
      prof['ytm_vid'] = seed['platform_id'];
    } else {
      const res = await this.call(job, `seed-ytm-match:${seed['title']}`, () => this.ytm.findMatch(seed as never, c), NO_MATCH);
      if (res.match) prof['ytm_vid'] = res.match.platform_id;
    }
    await this.store.cachePut(`seedprofile:${seed['id']}`, 'seed', prof, 86400);
    return prof;
  }

  /** The seed as the engine sees it: its own identity with Deezer's tags/BPM when matched. */
  seedView(seed: Dict, prof: Dict): Dict {
    const s: Dict = { ...seed };
    const dz = prof['dz'] as Dict | null;
    if (dz) {
      s['tags'] = (s['tags']?.length ? s['tags'] : null) || dz['tags'] || [];
      s['bpm'] = s['bpm'] || dz['bpm'];
      s['isrc'] = s['isrc'] || dz['isrc'];
      s['dz_preview_id'] = dz['platform_id'];
    }
    return s;
  }

  // ---------------------------------------------------------------------------------------
  async gather(job: Job, seeds: Dict[], profiles: Record<string, Dict>, cfg: EngineConfig, fresh: boolean): Promise<{ cands: Dict[]; related: Map<string, Set<string>> }> {
    const n = Math.max(1, seeds.length);
    const perSeed = Math.max(6, Math.ceil(cfg.perSourceCap / n));
    const c = this.ctx(job);
    const tasks: { source: string; seedKey: string; fn: () => Promise<Rel[]> }[] = [];
    const relatedNames = new Map<string, Set<string>>(seeds.map((s) => [String(s['key']), new Set<string>()]));
    const add = (source: string, seed: Dict, fn: () => Promise<Rel[]>) => tasks.push({ source, seedKey: String(seed['key']), fn });
    const rel = (ts: Dict[], relation: string, via: string | null = null): Rel[] => ts.map((t) => [t, relation, via]);

    for (const s of seeds) {
      const prof = profiles[String(s['key'])] as Dict;
      const vid = prof['ytm_vid'] as string | null;
      const dz = prof['dz'] as Dict | null;
      if (vid) {
        add('ytmusic-related', s, async () => rel((await this.ytm.related(vid, c)).songs, 'related_song'));
        add('ytmusic-radio', s, async () => rel(await this.ytm.radio(vid, perSeed + 1, c), 'radio'));
      }
      // Apple's catalogue is searched by the seed's own title and artist (the iTunes search is keyless and cached).
      const term = [s['artists']?.[0], s['title']].filter(Boolean).join(' ');
      if (term.trim()) add('apple-search', s, async () => rel(await this.apple.search(term, perSeed, c), 'search_match'));
      // Spotify, through the anonymous web-player search on every platform (spotDL as the Windows
      // fallback). A failure just leaves this source empty.
      const spotify = this.spotifySearch;
      if (term.trim() && spotify) add('spotify-search', s, async () => rel(await spotify(term, perSeed), 'search_match'));
      if (s['provider'] === 'soundcloud') {
        add('soundcloud-recommended', s, async () => rel(await this.sc.related(s as never, Math.min(perSeed, 20), c), 'sc_recommended'));
      }
      const dzArtist = (dz?.['artist_ids'] as Dict | undefined)?.['deezer'] as string | undefined;
      if (dzArtist) {
        add('deezer-artist-radio', s, async () => rel(await this.dz.artistRadio(dzArtist, perSeed, c), 'artist_radio'));
        add('deezer-artist-top', s, async () => rel(await this.dz.artistTop(dzArtist, 5, c), 'seed_artist_top'));
        const k = fresh ? 6 : 4;
        add('deezer-related-artists', s, () => this.relatedArtistTracks(dzArtist, k, job));
        add('deezer-recent', s, () => this.recent(dzArtist, fresh ? 6 : 3, cfg, job));
      }
    }

    // exploration pool from the seeds' own platform-stated genres. The Python builds this list by
    // appending (name, seed) pairs after testing a bare name against it, so it never de-duplicates;
    // the same is kept here so the candidates match.
    const tagNames: { name: string; s: Dict }[] = [];
    for (const s of seeds) {
      const dz = (profiles[String(s['key'])] as Dict)['dz'] as Dict | null;
      for (const g of (dz?.['tags'] as Dict[] | undefined) ?? []) tagNames.push({ name: g['name'], s });
    }
    if (tagNames.length) {
      const ids = await this.call<Record<string, number>>(job, 'deezer-genre-ids', () => this.dz.genreIds(c), {});
      for (const { name, s } of tagNames.slice(0, 2)) {
        const gid = ids[name];
        if (gid) add('deezer-genre-chart', s, async () => rel(await this.dz.genreChart(gid, 10, c), 'genre_chart', name));
      }
    }

    // similar-artist names from YT Music feed the artist factor
    const similar: { seedKey: string; fn: () => Promise<string[]> }[] = [];
    for (const s of seeds) {
      const vid = (profiles[String(s['key'])] as Dict)['ytm_vid'] as string | null;
      if (vid) similar.push({ seedKey: String(s['key']), fn: async () => (await this.ytm.related(vid, c)).artists.map((a) => a.name) });
    }

    const results = new Map<string, Map<string, Rel[]>>();
    const done = await pmap(tasks, 4, async (t) => ({ ...t, out: await this.call(job, `${t.source}:${(t.seedKey.split('|')[1] ?? '').slice(0, 30)}`, t.fn, [] as Rel[]) }));
    for (const t of done) {
      const bySeed = results.get(t.source) ?? new Map<string, Rel[]>();
      results.set(t.source, bySeed);
      bySeed.set(t.seedKey, [...(bySeed.get(t.seedKey) ?? []), ...t.out]);
    }
    const sims = await pmap(similar, 4, async (t) => ({ ...t, out: await this.call(job, `ytmusic-similar-artists:${(t.seedKey.split('|')[1] ?? '').slice(0, 30)}`, t.fn, [] as string[]) }));
    for (const t of sims) for (const name of t.out) relatedNames.get(t.seedKey)?.add(fold(name));

    // per-source cap, filled round-robin across seeds so the first seed cannot dominate
    const merged = new Map<string, Dict>();
    const order: string[] = [];
    for (const [source, bySeed] of results) {
      const lists = seeds.map((s) => bySeed.get(String(s['key'])) ?? []);
      let taken = 0;
      for (let i = 0; taken < cfg.perSourceCap && lists.some((l) => i < l.length); i++) {
        lists.forEach((lst, si) => {
          if (i < lst.length && taken < cfg.perSourceCap) {
            const [t, relation, via] = lst[i] as Rel;
            if (relation === 'related_artist_top') relatedNames.get(String((seeds[si] as Dict)['key']))?.add(fold(String((t['artists'] as string[])[0] ?? '')));
            this.merge(merged, order, t, { seed: (seeds[si] as Dict)['key'], relation, rank: i, source, via });
            taken += 1;
          }
        });
      }
    }
    // user uploads / mixes are not songs
    const cands = order.map((k) => merged.get(k) as Dict).filter((x) => x['kind'] !== 'video');
    return { cands: cands.slice(0, cfg.mergedCap), related: relatedNames };
  }

  private async relatedArtistTracks(artistId: string, k: number, job: Job): Promise<Rel[]> {
    const c = this.ctx(job);
    const out: Rel[] = [];
    for (const a of (await this.dz.relatedArtists(artistId, k, c)).slice(0, k)) {
      job.token.check();
      for (const t of await this.dz.artistTop(a.id, 3, c)) out.push([t, 'related_artist_top', a.name]);
    }
    return out;
  }

  /** Albums released inside the rolling window by the seed artist and its related artists. */
  private async recent(artistId: string, k: number, cfg: EngineConfig, job: Job): Promise<Rel[]> {
    const c = this.ctx(job);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const artists: { id: string; name: string | null }[] = [{ id: artistId, name: null }, ...(await this.dz.relatedArtists(artistId, k, c)).slice(0, k)];
    const out: Rel[] = [];
    for (const a of artists) {
      job.token.check();
      for (const alb of await this.dz.recentAlbums(a.id, 5, c)) {
        const rd = String(alb['release_date'] ?? '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(rd)) continue;
        const when = Date.parse(`${rd}T00:00:00Z`);
        if (Number.isNaN(when)) continue;
        const age = Math.floor((today - when) / DAY_MS);
        if (!(age >= -7 && age <= cfg.newReleaseDays)) continue;
        const full = await this.dz.album(String(alb['id']), c);
        for (const t of ((full['tracks'] as Dict[]) ?? []).slice(0, 3)) {
          if (t['readable'] === false) continue;
          out.push([this.dz.toTrack(t, full) as Dict, 'recent', a.name]);
        }
      }
    }
    return out;
  }

  private merge(merged: Map<string, Dict>, order: string[], t: Dict, prov: Dict): void {
    let key = String(t['key']);
    let existing = merged.get(key);
    if (existing && matchRecordings(existing as never, t as never).verdict === 'different') {
      key = `${key}#${t['provider']}:${t['platform_id']}`;
      existing = merged.get(key);
    }
    if (!existing) {
      merged.set(key, { ...t, key, provenance: [prov], links: { [t['provider']]: { url: t['url'], id: t['platform_id'] } } });
      order.push(key);
      return;
    }
    const provs = existing['provenance'] as Dict[];
    if (!provs.some((p) => p['seed'] === prov['seed'] && p['relation'] === prov['relation'])) provs.push(prov);
    const links = existing['links'] as Dict;
    links[t['provider']] ??= { url: t['url'], id: t['platform_id'] };
    for (const f of ['preview', 'bpm', 'isrc', 'duration', 'artwork', 'album']) if (!existing[f] && t[f]) existing[f] = t[f];
    if (!(existing['tags'] as unknown[] | undefined)?.length && (t['tags'] as unknown[] | undefined)?.length) existing['tags'] = t['tags'];
    const rNew = t['release'] as Dict | null;
    const rOld = existing['release'] as Dict | null;
    const rank: Record<string, number> = { day: 3, month: 2, year: 1 };
    if (rNew && (!rOld || (rank[rNew['precision']] ?? 0) > (rank[rOld['precision']] ?? 0))) existing['release'] = rNew;
    if (t['provider'] === 'deezer' && existing['dz_id'] === undefined) existing['dz_id'] = t['platform_id'];
  }

  // ---------------------------------------------------------------------------------------
  /** Deezer details for the leading candidates: confident match, BPM, ISRC, album genres. */
  async enrich(job: Job, cands: Dict[], limit = 40): Promise<void> {
    const c = this.ctx(job);
    await pmap(cands.slice(0, limit), 3, async (cand) => {
      if (job.token.cancelled) return;
      const links = cand['links'] as Dict;
      if (!links['deezer']) {
        const res = await this.call(job, `match:${String(cand['title']).slice(0, 24)}`, () => this.dz.findMatch(cand as never, c), NO_MATCH);
        if (!res.match) return;
        links['deezer'] = { url: res.match.url, id: res.match.platform_id };
      }
      const did = String(links['deezer'].id);
      const full = await this.call<Dict | null>(job, `detail:${String(cand['title']).slice(0, 24)}`, async () => this.dz.withGenres(await this.dz.track(did, c), c) as Dict, null);
      if (!full) return;
      for (const f of ['preview', 'bpm', 'isrc', 'artwork']) if (!cand[f] && full[f]) cand[f] = full[f];
      if (!(cand['tags'] as unknown[] | undefined)?.length && (full['tags'] as unknown[] | undefined)?.length) cand['tags'] = full['tags'];
      const fr = full['release'] as Dict | null;
      const cr = cand['release'] as Dict | null;
      if (fr && (!cr || cr['precision'] !== 'day')) cand['release'] = fr;
      cand['dz_id'] = did;
    });
    await this.genresFromMusicBrainz(job, cands.slice(0, limit));
  }

  /**
   * Last metadata rung: songs Deezer could not label but that carry an ISRC ask MusicBrainz, whose
   * listeners tag recordings. Capped per run and cached for a month; a failure labels nothing.
   */
  private async genresFromMusicBrainz(job: Job, cands: Dict[], cap = 5): Promise<void> {
    const MONTH = 30 * 24 * 3600;
    let asked = 0;
    for (const cand of cands) {
      if ((cand['tags'] as unknown[] | undefined)?.length || !cand['isrc'] || asked >= cap) continue;
      const isrc = String(cand['isrc']).replace(/[^A-Za-z0-9]/g, '').slice(0, 15);
      if (!isrc) continue;
      asked += 1;
      const url = `https://musicbrainz.org/ws/2/recording?query=isrc:${isrc}&fmt=json&limit=1`;
      const body = await this.call<Dict | null>(job, `mb:${isrc}`, () =>
        cached(this.store, `mb:isrc:${isrc}`, 'metadata', MONTH, () => this.http.getJson<Dict>(url, { maxBytes: 200_000, ...(job.meter ? { meter: job.meter } : {}), category: 'metadata', token: job.token })), null);
      const tags = body ? tagsFromMusicBrainz(body) : [];
      if (tags.length) {
        cand['tags'] = tags;
        job.sources['musicbrainz'] = { labeled: Number((job.sources['musicbrainz'] as Dict | undefined)?.['labeled'] ?? 0) + 1 };
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  async vectorFor(job: Job, dzId: string | null, preview: string | null): Promise<Float64Array | null> {
    if (!dzId) return null;
    const vkey = `deezer:${dzId}`;
    const v = this.store.vectorGet(vkey, A.MODEL_ID, A.PREPROCESS_ID);
    if (v) {
      job.audio['cached'] = (job.audio['cached'] ?? 0) + 1;
      return Float64Array.from(v);
    }
    if (!preview) return null;
    return this.embedPreview(job, vkey, dzId, preview);
  }

  /**
   * Tempo only, for a song the embedding budget did not reach (or a device without the model):
   * download the preview, decode, measure, remember. The embedding path measures tempo as a side
   * effect; this one exists so a song can still be placed by tempo when no vector will ever come.
   */
  async tempoFor(job: Job, dzId: string, preview: string): Promise<number | null> {
    const known = this.store.get<number>(`bpm:${dzId}`);
    if (typeof known === 'number') return known;
    const c = this.ctx(job);
    try {
      const url = await this.dz.freshPreview(dzId, preview, c);
      if (!url) return null;
      const { response } = await this.http.get(url, { maxBytes: TRANSFER.perAudioFile, ...(job.meter ? { meter: job.meter } : {}), category: 'audio', token: job.token, retries: 0 });
      const y = A.trimSilence(await decodeToMono48k(response.body));
      if (y.length < A.SR * 5) return null;
      const bpm = A.estimateBpm(y);
      if (bpm) {
        await this.store.put(`bpm:${dzId}`, bpm);
        job.audio['tempo'] = (job.audio['tempo'] ?? 0) + 1;
      }
      return bpm;
    } catch (e) {
      if (e instanceof Cancelled || e instanceof BudgetExceeded) throw e;
      return null;
    }
  }

  private async embedPreview(job: Job, vkey: string, dzId: string, preview: string): Promise<Float64Array | null> {
    job.token.check();
    if (!this.encoder) return null;
    const c = this.ctx(job);
    const t0 = performance.now();
    let data: Uint8Array;
    try {
      // Preview URLs are signed for ~15 minutes but track metadata is cached for days: re-sign first.
      const url = await this.dz.freshPreview(dzId, preview, c);
      if (!url) throw new ProviderError('Deezer no longer offers a preview for this track');
      const { response } = await this.http.get(url, { maxBytes: TRANSFER.perAudioFile, ...(job.meter ? { meter: job.meter } : {}), category: 'audio', token: job.token, retries: 1 });
      // an expired or refused signature answers with a small HTML page; never decode that as audio
      if (response.status >= 400) throw new ProviderError(`preview HTTP ${response.status}`);
      data = response.body;
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      if (e instanceof BudgetExceeded) {
        job.audio['budget_stops'] = (job.audio['budget_stops'] ?? 0) + 1;
        job.audio['last_budget'] = e.message;
        throw e;
      }
      job.audio['failed'] = (job.audio['failed'] ?? 0) + 1;
      (job.audio['errors'] ??= []).push(String((e as Error).message).slice(0, 120));
      return null;
    }
    const dlMs = performance.now() - t0;
    try {
      const y = A.trimSilence(await decodeToMono48k(data));
      if (y.length < A.SR * 5) {
        job.audio['too_short'] = (job.audio['too_short'] ?? 0) + 1;
        return null;
      }
      // Deezer reports 0 BPM for many songs; the decoded preview is already here, so measure it.
      const bpm = A.estimateBpm(y);
      if (bpm) {
        await this.store.put(`bpm:${dzId}`, bpm);
        job.audio['tempo'] = (job.audio['tempo'] ?? 0) + 1;
      }
      job.token.check();
      const r = await this.encoder.embedAudio(y);
      await this.store.vectorPut(vkey, A.MODEL_ID, A.PREPROCESS_ID, r.vector, 'deezer-preview-30s');
      job.audio['embedded'] = (job.audio['embedded'] ?? 0) + 1;
      (job.audio['infer_ms'] ??= []).push(Math.round(r.inferMs));
      (job.audio['download_ms'] ??= []).push(Math.round(dlMs));
      return Float64Array.from(r.vector);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      job.audio['failed'] = (job.audio['failed'] ?? 0) + 1;
      (job.audio['errors'] ??= []).push(`${(e as Error).name}: ${String((e as Error).message).slice(0, 100)}`);
      return null;
    }
  }
}
