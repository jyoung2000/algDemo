/**
 * Spotify search with no developer account and no spotDL, ported from IdontHaveSpotify
 * (src/adapters/spotify.ts, MIT). It uses the anonymous web-player token: the player bundle holds a
 * TOTP secret, the token endpoint answers with a short-lived anonymous access token, and the
 * search GraphQL operation (searchDesktop) returns tracks. Plain fetch only, so it runs in the
 * Windows shell and the Android WebView alike.
 *
 * Every request goes through the engine's Http client, so it honours the host allowlist (net.ts)
 * and the per-host pacing. The Spotify CDN host the bundle is served from must be on that list.
 */
import type { Http, Meter, CancelToken } from './net';
import { makeTrack, type Track } from './track';
import { ProviderError } from './deezer';

const BASE = 'https://open.spotify.com';
const PARTNER = 'https://api-partner.spotify.com/pathfinder/v1/query';
const SEARCH_HASH = '75bbf6bfcfdf85b8fc828417bfad92b7cd66bf7f556d85670f4da8292373ebec';
const PLAYER_JS = /"(https:\/\/[^" ]+\/(?:mobile-)?web-player\.[0-9a-f]+\.js)"/;
const SECRETS = /\{\s*secret\s*:\s*["']([^"']+)["']\s*,\s*version\s*:\s*(\d+)\s*\}/g;

interface Token { accessToken: string; expiresAt: number }
interface Ctx { meter?: Meter; token?: CancelToken }
/** Per-response byte caps: the player bundle is the largest thing read here. */
const JSON_MAX = 1_000_000;
const BUNDLE_MAX = 8_000_000;
const HTML_MAX = 2_000_000;
/**
 * Spotify serves the full web player (whose bundle holds the token secret) only to a desktop
 * browser. Android's native HTTP sends a Dalvik user agent and gets a 5 KB page with no bundle, so
 * every Spotify request names a desktop browser.
 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** WebCrypto TOTP over the transformed secret, the same bytes IDHS produces. */
export async function totpFor(serverTime: number, secret: string): Promise<string> {
  const transformed = [...secret].map((c, i) => c.charCodeAt(0) ^ ((i % 33) + 9));
  const keyBytes = new TextEncoder().encode(transformed.join(''));
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(serverTime / 30)));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const o = (h[h.length - 1] ?? 0) & 0xf;
  const b = (i: number) => h[o + i] ?? 0;
  const code = (((b(0) & 0x7f) << 24) | ((b(1) & 0xff) << 16) | ((b(2) & 0xff) << 8) | (b(3) & 0xff)) % 1_000_000;
  return String(code).padStart(6, '0');
}

export class SpotifySearch {
  private token: Token | null = null;

  constructor(private readonly http: Http) {}

  /** Search Spotify tracks for `query`. Throws ProviderError when the anonymous path is unavailable. */
  async searchTracks(query: string, limit: number, c: Ctx = {}): Promise<Track[]> {
    const q = query.trim().slice(0, 200);
    if (!q) return [];
    const access = await this.accessToken(c);
    const url = new URL(PARTNER);
    url.searchParams.set('operationName', 'searchDesktop');
    url.searchParams.set('variables', JSON.stringify({ searchTerm: q, offset: 0, limit: Math.max(1, Math.min(10, limit)), numberOfTopResults: 5 }));
    url.searchParams.set('extensions', JSON.stringify({ persistedQuery: { version: 1, sha256Hash: SEARCH_HASH } }));
    const body = await this.json<{ data?: { searchV2?: unknown; search?: unknown } }>(url.toString(), c, {
      Authorization: `Bearer ${access}`,
      'app-platform': 'WebPlayer',
    });
    const search = (body.data?.searchV2 ?? body.data?.search) as { tracks?: { items?: Array<{ track?: unknown }> } } | undefined;
    const out: Track[] = [];
    for (const it of search?.tracks?.items ?? []) {
      const t = it.track as Record<string, unknown> | undefined;
      const tr = t ? trackFromSearchItem(t) : null;
      if (tr) out.push(tr);
      if (out.length >= limit) break;
    }
    return out;
  }

  private async json<T>(url: string, c: Ctx, headers: Record<string, string> = {}): Promise<T> {
    const { response } = await this.http.get(url, { maxBytes: JSON_MAX, meter: c.meter, token: c.token, category: 'metadata', headers: { 'User-Agent': BROWSER_UA, ...headers } });
    if (response.status >= 400) throw new ProviderError(`Spotify answered HTTP ${response.status}.`);
    try {
      return JSON.parse(new TextDecoder().decode(response.body)) as T;
    } catch {
      throw new ProviderError('Spotify sent a reply that is not JSON.');
    }
  }

  private async text(url: string, c: Ctx, maxBytes: number): Promise<string> {
    const { response } = await this.http.get(url, { maxBytes, meter: c.meter, token: c.token, category: 'metadata', headers: { 'User-Agent': BROWSER_UA } });
    if (response.status >= 400) throw new ProviderError(`Spotify answered HTTP ${response.status}.`);
    return new TextDecoder().decode(response.body);
  }

  private async accessToken(c: Ctx): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.accessToken;
    const st = await this.json<{ serverTime: number }>(`${BASE}/api/server-time`, c);
    const html = await this.text(BASE, c, HTML_MAX);
    const m = PLAYER_JS.exec(html);
    if (!m?.[1]) throw new ProviderError('Spotify’s web player page changed; the search token could not be read.');
    const js = await this.text(m[1], c, BUNDLE_MAX);
    let best = { v: 0, s: '' };
    for (const x of js.matchAll(SECRETS)) {
      const v = Number(x[2]);
      if (v > best.v) best = { v, s: x[1] ?? '' };
    }
    if (!best.s) throw new ProviderError('Spotify’s web player has no token secret; search is unavailable right now.');
    const totp = await totpFor(st.serverTime, best.s);
    const u = new URL(`${BASE}/api/token`);
    u.searchParams.set('reason', 'init');
    u.searchParams.set('productType', 'web-player');
    u.searchParams.set('totp', totp);
    u.searchParams.set('totpVer', String(best.v));
    u.searchParams.set('ts', String(st.serverTime));
    const tk = await this.json<{ accessToken?: string; accessTokenExpirationTimestampMs?: number }>(u.toString(), c, {
      Accept: 'application/json',
      Referer: `${BASE}/`,
      Origin: BASE,
    });
    if (!tk.accessToken) throw new ProviderError('Spotify did not issue a search token.');
    this.token = { accessToken: tk.accessToken, expiresAt: tk.accessTokenExpirationTimestampMs ?? Date.now() + 3_600_000 };
    return tk.accessToken;
  }
}

/** A searchDesktop track item (spotify:track:<id>) mapped to the engine's track shape. */
export function trackFromSearchItem(t: Record<string, unknown>): Track | null {
  const uri = typeof t['uri'] === 'string' ? t['uri'] : '';
  const m = /^spotify:track:([A-Za-z0-9]{22})$/.exec(uri);
  const title = typeof t['name'] === 'string' ? t['name'].trim() : '';
  if (!m || !title) return null;
  const items = ((t['artists'] as { items?: Array<{ profile?: { name?: string } }> } | undefined)?.items) ?? [];
  const artists = items.map((a) => a.profile?.name ?? '').filter(Boolean);
  const ms = (t['duration'] as { totalMilliseconds?: number } | undefined)?.totalMilliseconds;
  return makeTrack({
    provider: 'spotify',
    platformId: m[1] as string,
    title,
    artists,
    duration: typeof ms === 'number' && ms > 0 ? ms / 1000 : null,
    url: `https://open.spotify.com/track/${m[1]}`,
    extra: { found_by: 'anonymous-search' },
  });
}
