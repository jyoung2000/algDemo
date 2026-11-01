/**
 * Deezer public API adapter, ported from server/airwave_discovery/providers.py (class Deezer).
 * Keyless JSON; every request goes through the guarded Http (net.ts), so only api.deezer.com and
 * the Deezer CDNs are reachable. Results are cached in the Store with the same TTLs as Python.
 */
import type { CancelToken, Http, Meter } from './net';
import * as G from './genres';
import { fold, matchRecordings } from './identity';
import { makeTrack, release, previewExpiry, type Track } from './track';
import type { Store } from './store';

export const DZ = 'https://api.deezer.com';

export class ProviderError extends Error {}

/** A link resolved to something the user must choose from (an ambiguous match, a playlist). */
export class NeedsChoice extends Error {
  constructor(readonly kind: string, message: string, readonly payload: Record<string, unknown>) {
    super(message);
  }
}

type Json = Record<string, any>;
export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

const H = 3600;
const DAY = 86400;

/** Cache hit, else compute and store; a stale entry answers when the fetch fails (Provider.cached). */
export async function cached<T>(store: Store | undefined, key: string, kind: string, ttl: number, fn: () => Promise<T>): Promise<T> {
  const hit = store?.cacheGet(key);
  if (hit) return hit.value as T;
  try {
    const value = await fn();
    await store?.cachePut(key, kind, value, ttl);
    return value;
  } catch (e) {
    const stale = store?.cacheGet(key, true);
    if (stale) return stale.value as T;
    throw e;
  }
}

export class Deezer {
  readonly name = 'deezer';
  readonly label = 'Deezer';

  constructor(private readonly http: Http, private readonly store?: Store) {}

  private async get(path: string, c: Ctx = {}): Promise<Json> {
    const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 1_500_000 };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    const data = await this.http.getJson<Json>(DZ + path, o);
    if (data && typeof data === 'object' && data.error) {
      const err = data.error;
      throw new ProviderError(`Deezer: ${err.type}: ${err.message}`);
    }
    return data;
  }

  /** Mirrors Deezer.to_track: contributors first, then the artist name; album genres as tags. */
  toTrack(x: Json, album?: Json | null): Track {
    const alb: Json = album || x.album || {};
    const contributors: string[] = (x.contributors || []).map((c: Json) => c.name).filter(Boolean);
    const artists = (contributors.length ? contributors : [x.artist?.name ?? '']).filter((a: string) => a);
    const rel = release(x.release_date || alb.release_date, 'release', 'Deezer');
    const tags = ((alb.genres?.data as Json[]) ?? []).map((g) => G.makeTag(g.name ?? '', 'Deezer album genre', 'album', 0.8));
    return makeTrack({
      provider: 'deezer',
      platformId: String(x.id),
      title: x.title || x.title_short || '',
      version: x.title_version || '',
      artists,
      album: alb.title ?? null,
      duration: x.duration ?? null,
      artwork: alb.cover_medium || alb.cover || null,
      url: x.link || `https://www.deezer.com/track/${x.id}`,
      isrc: x.isrc ?? null,
      rel,
      tags,
      artistIds: { deezer: String(x.artist?.id ?? '') },
      preview: x.preview || null,
      explicit: x.explicit_lyrics ?? null,
      bpm: x.bpm ?? null,
      extra: { album_id: String(alb.id ?? ''), popularity: x.rank ?? null },
    });
  }

  search(q: string, limit = 15, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `dz:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const d = await this.get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`, c);
      return ((d.data as Json[]) ?? []).filter((x) => (x.type ?? 'track') === 'track' && (x.readable ?? true)).map((x) => this.toTrack(x));
    });
  }

  track(tid: string, c: Ctx = {}): Promise<Track> {
    return cached(this.store, `dz:track:${tid}`, 'track', 7 * DAY, async () => this.toTrack(await this.get(`/track/${tid}`, c)));
  }

  /** Deezer preview URLs are signed for ~15 min. Return `url` while it still has a minute left. */
  async freshPreview(tid: string, url: string | null, c: Ctx = {}): Promise<string | null> {
    if (url && previewExpiry(url) > Date.now() / 1000 + 60) return url;
    const fresh = this.toTrack(await this.get(`/track/${tid}`, c));
    await this.store?.cachePut(`dz:track:${tid}`, 'track', fresh, 7 * DAY);
    return fresh.preview;
  }

  album(aid: string, c: Ctx = {}): Promise<Json> {
    return cached(this.store, `dz:album:${aid}`, 'album', 7 * DAY, async () => {
      const d = await this.get(`/album/${aid}`, c);
      return {
        id: String(d.id),
        title: d.title,
        release_date: d.release_date,
        genres: d.genres,
        cover_medium: d.cover_medium,
        record_type: d.record_type,
        tracks: (((d.tracks ?? {}).data as Json[]) ?? []).slice(0, 40).map((t) => ({
          id: t.id, title: t.title, title_version: t.title_version, duration: t.duration, artist: t.artist,
          preview: t.preview, link: t.link, rank: t.rank, explicit_lyrics: t.explicit_lyrics, readable: t.readable ?? true,
        })),
      };
    });
  }

  async resolveLink(url: string, c: Ctx = {}): Promise<Track> {
    let u = new URL(url);
    if (u.hostname === 'deezer.page.link' || u.hostname === 'link.deezer.com') {
      u = new URL(await this.http.resolveRedirects(url, c));
    }
    const m = /\/(track|album|playlist|artist)\/(\d+)/.exec(u.pathname);
    if (!m) throw new ProviderError('That Deezer link is not a track link.');
    const [, kind, ident] = m;
    if (kind !== 'track') throw new ProviderError(`That is a Deezer ${kind}; paste a link to a single track.`);
    return this.track(ident!, c);
  }

  /** Album genres (and a release date) for a track that has none yet. */
  async withGenres(t: Track, c: Ctx = {}): Promise<Track> {
    if (t.tags.length || !t['album_id']) return t;
    const alb = await this.album(String(t['album_id']), c);
    const tags = ((alb.genres?.data as Json[]) ?? []).map((g) => G.makeTag(g.name ?? '', 'Deezer album genre', 'album', 0.8)).filter((x): x is G.Tag => !!x);
    const out: Track = { ...t, tags };
    if (!out.release) out.release = release(alb.release_date, 'release', 'Deezer');
    return out;
  }

  private tracksOf(path: string, c: Ctx): Promise<Track[]> {
    return this.get(path, c).then((d) => ((d.data as Json[]) ?? []).map((x) => this.toTrack(x)));
  }

  artistRadio(artistId: string, limit: number, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `dz:artradio:${artistId}:${limit}`, 'related', 6 * H, () => this.tracksOf(`/artist/${artistId}/radio?limit=${limit}`, c));
  }

  artistTop(artistId: string, limit: number, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `dz:arttop:${artistId}:${limit}`, 'artist', 6 * H, () => this.tracksOf(`/artist/${artistId}/top?limit=${limit}`, c));
  }

  relatedArtists(artistId: string, limit: number, c: Ctx = {}): Promise<{ id: string; name: string }[]> {
    return cached(this.store, `dz:artrel:${artistId}:${limit}`, 'related', 24 * H, async () => {
      const d = await this.get(`/artist/${artistId}/related?limit=${limit}`, c);
      return ((d.data as Json[]) ?? []).map((a) => ({ id: String(a.id), name: a.name as string }));
    });
  }

  recentAlbums(artistId: string, limit: number, c: Ctx = {}): Promise<Json[]> {
    return cached(this.store, `dz:artalb:${artistId}:${limit}`, 'recent', 12 * H, async () => {
      const d = await this.get(`/artist/${artistId}/albums?limit=${limit}`, c);
      return ((d.data as Json[]) ?? []).map((a) => ({ id: String(a.id), title: a.title, release_date: a.release_date ?? null, record_type: a.record_type ?? null, cover_medium: a.cover_medium ?? null }));
    });
  }

  genreChart(genreId: number, limit: number, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `dz:chart:${genreId}:${limit}`, 'related', 12 * H, () => this.tracksOf(`/chart/${genreId}/tracks?limit=${limit}`, c));
  }

  genreIds(c: Ctx = {}): Promise<Record<string, number>> {
    return cached(this.store, 'dz:genres', 'meta', 7 * DAY, async () => {
      const d = await this.get('/genre', c);
      const out: Record<string, number> = {};
      for (const g of (d.data as Json[]) ?? []) {
        const canon = G.normalize(g.name ?? '');
        if (canon && g.id && !(canon in out)) out[canon] = Number(g.id);
      }
      return out;
    });
  }

  /** Deezer recording for a track from another provider: a confident match, or uncertain options. */
  async findMatch(t: Track, c: Ctx = {}): Promise<{ match: Track | null; uncertain: Track[] }> {
    if (t.provider === 'deezer') return { match: t, uncertain: [] };
    const q = `${t.artists[0] ?? ''} ${t.title}`.trim();
    const uncertain: Track[] = [];
    for (const r of await this.search(q, 10, c)) {
      const v = matchRecordings(t, r);
      if (v.verdict === 'same') return { match: r, uncertain: [] };
      if (v.verdict === 'uncertain') uncertain.push({ ...r, match_note: v.reason });
    }
    return { match: null, uncertain: uncertain.slice(0, 5) };
  }
}
