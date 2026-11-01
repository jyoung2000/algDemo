/**
 * SoundCloud adapter. Python uses yt-dlp, which gets a client id from SoundCloud's own web bundle and
 * calls api-v2; this does the same two steps directly (no developer key). Mapping mirrors
 * providers.py SoundCloud.to_track and yt-dlp's extractor (genre, tags, publisher artist, release vs
 * upload date). Verified against responses recorded live from api-v2.soundcloud.com.
 */
import type { CancelToken, Http, Meter } from './net';
import { fold, splitArtists } from './identity';
import * as G from './genres';
import { makeTrack, release, type Track } from './track';
import { cached, ProviderError } from './deezer';
import type { Store } from './store';

type Json = Record<string, any>;
export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

const HOME = 'https://soundcloud.com/';
const API = 'https://api-v2.soundcloud.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0';
const SC_PATH = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/;
const SC_RESERVED = new Set(['discover', 'stream', 'search', 'you', 'charts', 'upload', 'settings', 'messages', 'notifications', 'pages', 'terms-of-use']);
const NOT_A_TRACK = new Set(['tracks', 'likes', 'reposts', 'albums', 'sets', 'popular-tracks']);
const CLIENT_ID = /client_id\s*:\s*"([0-9a-zA-Z]{32})"/;
const DAY = 86400;

/** yt-dlp's tag_list grammar: quoted phrases or bare words. */
export function parseTags(list: string | null | undefined): string[] {
  const out: string[] = [];
  for (const m of (list ?? '').matchAll(/"([^"]+)"|([^ ]+)/g)) {
    const v = m[1] ?? m[2];
    if (v) out.push(v);
  }
  return out;
}

export class SoundCloud {
  readonly name = 'soundcloud';
  readonly label = 'SoundCloud';
  private clientId: string | null = null;

  constructor(private readonly http: Http, private readonly store?: Store) {}

  /** The web app's public client id, from its newest script bundle that contains one. */
  private async fetchClientId(c: Ctx): Promise<string> {
    const base: Parameters<Http['get']>[1] = { category: 'metadata', maxBytes: 4_000_000, headers: { 'user-agent': UA } };
    if (c.meter) base.meter = c.meter;
    if (c.token) base.token = c.token;
    const { response } = await this.http.get(HOME, { ...base, maxBytes: 600_000 });
    const page = new TextDecoder().decode(response.body);
    const srcs = [...page.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!).filter((u) => /^https:\/\/[a-z0-9-]+\.sndcdn\.com\//.test(u));
    for (const src of srcs.reverse()) {
      try {
        const { response: r } = await this.http.get(src, { ...base, retries: 1 });
        const m = CLIENT_ID.exec(new TextDecoder().decode(r.body));
        if (m) return m[1]!;
      } catch {
        /* the next bundle may have it, as yt-dlp does */
      }
    }
    throw new ProviderError('SoundCloud did not hand out a client id; its site may have changed.');
  }

  private async getClientId(c: Ctx, refresh = false): Promise<string> {
    if (!refresh) {
      if (this.clientId) return this.clientId;
      const hit = this.store?.cacheGet('sc:client_id');
      if (hit) return (this.clientId = hit.value as string);
    }
    const id = await this.fetchClientId(c);
    this.clientId = id;
    await this.store?.cachePut('sc:client_id', 'meta', id, DAY);
    return id;
  }

  private async get(path: string, c: Ctx): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      const cid = await this.getClientId(c, attempt > 0);
      const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 1_500_000, headers: { 'user-agent': UA } };
      if (c.meter) o.meter = c.meter;
      if (c.token) o.token = c.token;
      try {
        return await this.http.getJson<Json>(`${API}${path}${path.includes('?') ? '&' : '?'}client_id=${cid}`, o);
      } catch (e) {
        // An expired client id answers 401/403: fetch a fresh one once, as yt-dlp does.
        if (attempt === 0 && /HTTP 40[13]\b/.test((e as Error).message)) continue;
        throw e;
      }
    }
  }

  toTrack(e: Json): Track {
    const userName: string = e.user?.username ?? '';
    const publisher: string = e.publisher_metadata?.artist ?? '';
    let artist = publisher || userName;
    let title: string = e.title ?? '';
    // Uploader-only titles are often "Artist - Title"; keep the uploader as artist unless that pattern is explicit.
    const m = /^(.{1,60}?)\s+[-–—]\s+(.+)$/.exec(e.title ?? '');
    if (m && !publisher && fold(m[1]!) !== fold(title)) {
      artist = m[1]!;
      title = m[2]!;
    }
    const tags: (G.Tag | null)[] = [];
    if (e.genre) tags.push(G.makeTag(e.genre, 'SoundCloud uploader genre', 'track', 0.6));
    for (const tg of parseTags(e.tag_list).slice(0, 6)) tags.push(G.makeTag(tg, 'SoundCloud uploader tag', 'track', 0.4));
    const day = (s: string | undefined) => (s ? s.slice(0, 10) : null);
    const rel = release(day(e.release_date), 'release', 'SoundCloud') ?? release(day(e.created_at), 'upload', 'SoundCloud');
    const art: string | null = e.artwork_url ? String(e.artwork_url).replace(/-large\.(jpg|png)$/, '-t300x300.$1') : (e.user?.avatar_url ?? null);
    const url: string = e.permalink_url ?? '';
    return makeTrack({
      provider: 'soundcloud', platformId: String(e.id ?? url), title, artists: splitArtists(artist).length ? [artist] : ['Unknown artist'],
      duration: e.duration ? e.duration / 1000 : null, artwork: art, url, rel, tags, extra: { license: e.license ?? null },
    });
  }

  search(q: string, limit = 10, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `sc:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const d = await this.get(`/search/tracks?q=${encodeURIComponent(q)}&limit=${limit}&offset=0`, c);
      return ((d.collection as Json[]) ?? []).filter((e) => e && e.kind === 'track').slice(0, limit).map((e) => this.toTrack(e));
    });
  }

  async resolveLink(url: string, c: Ctx = {}): Promise<Track> {
    let u = new URL(url);
    if (u.hostname === 'on.soundcloud.com') u = new URL(await this.http.resolveRedirects(url, c));
    if (u.pathname.includes('/sets/')) throw new ProviderError('That is a SoundCloud playlist (set). Paste a link to one track.');
    const m = SC_PATH.exec(u.pathname);
    if (!m || SC_RESERVED.has(m[1]!) || NOT_A_TRACK.has(m[2]!)) throw new ProviderError('That SoundCloud link is a profile or page, not a track.');
    const clean = `https://soundcloud.com/${m[1]}/${m[2]}`;
    return cached(this.store, `sc:track:${clean}`, 'track', 7 * DAY, async () => {
      let d: Json;
      try {
        d = await this.get(`/resolve?url=${encodeURIComponent(clean)}`, c);
      } catch (e) {
        if (/HTTP 404\b/.test((e as Error).message)) throw new ProviderError('SoundCloud says that track does not exist or is private.');
        throw e;
      }
      if (d.kind !== 'track') throw new ProviderError('That SoundCloud link is a profile or page, not a track.');
      return this.toTrack(d);
    });
  }

  related(t: Track, limit: number, c: Ctx = {}): Promise<Track[]> {
    return cached(this.store, `sc:related:${t.url.replace(/\/$/, '')}:${limit}`, 'related', 12 * 3600, async () => {
      const d = await this.get(`/tracks/${encodeURIComponent(t.platform_id)}/related?limit=${limit}`, c);
      return ((d.collection as Json[]) ?? []).filter((e) => e && e.kind === 'track').slice(0, limit).map((e) => this.toTrack(e));
    });
  }

  playbackLink(t: Track): { kind: 'embed'; embed: string; open: string; label: string } {
    return {
      kind: 'embed',
      embed: `https://w.soundcloud.com/player/?url=${encodeURIComponent(t.url)}&auto_play=true&visual=false&show_comments=false`,
      open: t.url,
      label: 'Open in SoundCloud',
    };
  }
}
