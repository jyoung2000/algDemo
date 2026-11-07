/**
 * HearThis source: keyless public search, creator-enabled downloads and a declared Creative Commons
 * license only. HearThis's own JSON says whether the creator enabled a download; yt-dlp's official
 * HearThisAt extractor resolves the public track page to that file. A completed native download is
 * still required before playback/shuffle readiness, and strict recording identity remains upstream.
 */
import type { CancelToken, Http, Meter } from './net';
import { cached } from './deezer';
import * as G from './genres';
import { fold } from './identity';
import type { Store } from './store';
import { makeTrack, release, type Track } from './track';

type Json = Record<string, any>;
export interface Ctx { meter?: Meter; token?: CancelToken; refresh?: boolean }
const API = 'https://api-v2.hearthis.at';
const LIMIT = 20;
const CC_LICENSES = new Set([
  'Attribution', 'AttributionShareAlike', 'AttributionNoDerivatives',
  'Noncommercial', 'NoncommercialShareAlike', 'NoncommercialNoDerivatives', 'PublicDomain',
]);

function safeTrackPage(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'hearthis.at' || u.username || u.password || u.port || u.search || u.hash) return null;
    const canonical = `https://hearthis.at${u.pathname}`;
    return raw === canonical && /^\/[A-Za-z0-9][A-Za-z0-9._-]{0,100}\/[A-Za-z0-9][A-Za-z0-9._-]{0,180}\/$/.test(u.pathname) ? raw : null;
  } catch { return null; }
}

function creatorDownload(raw: unknown, trackPage: string): boolean {
  if (typeof raw !== 'string' || raw.length > 700) return false;
  try {
    const u = new URL(raw);
    const keys = [...u.searchParams.keys()];
    const queryOk = !u.search || (keys.length === 1 && keys[0] === 'secret' && /^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get('secret') ?? ''));
    const page = new URL(trackPage);
    return u.protocol === 'https:' && u.hostname === 'hearthis.app' && !u.username && !u.password && !u.port && !u.hash && queryOk &&
      u.pathname === `${page.pathname}download/`;
  } catch { return false; }
}

function toTrack(e: Json): Track | null {
  if (!e || typeof e !== 'object' || e.private !== '0' || String(e.type ?? '') !== 'Original' || String(e.downloadable ?? '0') !== '1') return null;
  if (!CC_LICENSES.has(String(e.license ?? ''))) return null;
  const id = String(e.id ?? '');
  const title = String(e.title ?? '').trim();
  const artist = String(e.user?.username ?? '').trim();
  const duration = Number(e.duration);
  const url = safeTrackPage(e.permalink_url);
  if (!url || !creatorDownload(e.download_url, url)) return null;
  if (!/^\d{1,20}$/.test(id) || !title || title.length > 240 || !artist || artist.length > 160 ||
      !Number.isFinite(duration) || duration < 60 || duration > 3600) return null;
  const tags: (G.Tag | null)[] = [];
  if (e.genre) tags.push(G.makeTag(String(e.genre), 'HearThis creator genre', 'track', 0.5));
  return makeTrack({
    provider: 'hearthis', platformId: id, title, artists: [artist], duration, url,
    artwork: typeof e.artwork_url === 'string' ? e.artwork_url : null,
    rel: release(String(e.release_date ?? '').slice(0, 10), 'upload', 'HearThis'), tags,
    preview: null, extra: { license: String(e.license) },
  });
}

/** Search-result rows to whole-track candidates; never expose an unlicensed stream as downloadable. */
export function parseHearThisTracks(raw: unknown): Track[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => toTrack(e as Json)).filter((t): t is Track => !!t);
}

export class HearThis {
  readonly name = 'hearthis';
  readonly label = 'HearThis (creator-downloadable Creative Commons)';
  constructor(private readonly http: Http, private readonly store?: Store) {}
  /**
   * SOURCE-HEARTHIS-002: a remembered link is NOT standing permission. The license and the
   * creator's download switch can both change after a hit is cached, so a cached HearThis link is
   * re-read from the track's own public JSON and re-gated before it is handed to the downloader.
   * Any failure (withdrawn download, changed license, unreachable API) answers null, not the link.
   */
  async revalidate(trackPage: string, c: Ctx = {}): Promise<Track | null> {
    // Re-run the same canonical-page gate the search path uses, so a corrupted cache entry can
    // never turn into an arbitrary api-v2.hearthis.at request.
    const page = safeTrackPage(trackPage);
    if (!page) return null;
    const path = new URL(page).pathname;
    const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 500_000, retries: 1 };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    try {
      const row = parseHearThisTracks([await this.http.getJson<unknown>(`${API}${path}`, o)])[0];
      // A redirect could answer with a different, self-consistent upload: only the same page counts.
      return row && row.url === page ? row : null;
    } catch { return null; }
  }
  search(q: string, limit = 10, c: Ctx = {}): Promise<Track[]> {
    return cached(c.refresh ? undefined : this.store, `hearthis:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const count = Math.max(1, Math.min(LIMIT, limit));
      const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 2_000_000 };
      if (c.meter) o.meter = c.meter;
      if (c.token) o.token = c.token;
      const url = `${API}/search/?${new URLSearchParams({ t: q, count: String(count) })}`;
      return parseHearThisTracks(await this.http.getJson<unknown>(url, o)).slice(0, limit);
    });
  }
}
