/**
 * Outbound HTTP guard, ported from server/airwave_discovery/net.py: host allowlist, https-only URL
 * validation, byte caps, per-host pacing, backoff and transfer metering.
 *
 * The page never calls a music service directly (CORS). The transport is an HttpPort:
 * the Android WebView routes through the native bridge (native-http.ts), the browser uses fetch.
 * The allowlist is enforced here, before any transport sees the request, and again in the native
 * bridge (MainActivity.kt HOSTS / SUFFIXES must mirror ALLOWED_HOSTS / ALLOWED_SUFFIXES below).
 */

export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  // Deezer public API, previews and artwork
  'api.deezer.com', 'www.deezer.com', 'deezer.com', 'deezer.page.link', 'link.deezer.com',
  // Spotify public oEmbed and share links
  'open.spotify.com', 'spotify.link', 'spotify.app.link',
  // SoundCloud pages, oEmbed and share links
  'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com', 'api-v2.soundcloud.com',
  // YouTube / YouTube Music pages and short links
  'www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  // Search providers (MusicSearch): Apple, Spotify search API and token, Qobuz, Amazon, Tidal,
  // song.link and lyric/metadata lookups. Search and metadata only; no download resolver host is listed.
  'itunes.apple.com', 'music.apple.com',
  'api-partner.spotify.com', 'clienttoken.spotify.com', 'open.spotifycdn.com',
  'open.qobuz.com',
  'music.amazon.com', 'na.web.skill.music.a2z.com',
  'tidal.com', 'resources.tidal.com',
  'api.song.link',
  'lrclib.net', 'musicbrainz.org',
  // Song identification: Genius lyric search (words typed by the user) and Shazam's tag endpoint (an audio fingerprint, never sound).
  'genius.com', 'amp.shazam.com',
  // Audius (keyless, documented read API) and Bandcamp's own site endpoints: both answer with whole-track
  // lengths and both are downloadable in full by yt-dlp (SOURCE-MORE-001).
  'api.audius.co', 'audius.co', 'bandcamp.com', 'www.bandcamp.com',
  // Archive.org's public search/item metadata (licensed whole-audio items only).
  'archive.org',
  'i.ytimg.com',
]);
// Deezer preview/image CDN and SoundCloud media CDN. Keep in step with MainActivity.kt.
export const ALLOWED_SUFFIXES: readonly string[] = ['.dzcdn.net', '.sndcdn.com'];

export class FetchError extends Error {}
export class BlockedUrl extends FetchError {}
export class BudgetExceeded extends FetchError {}
export class Cancelled extends FetchError {}

export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The transport. Implementations must not follow redirects themselves: Http re-checks every hop. */
export interface HttpPort {
  request(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

export function hostAllowed(host: string): boolean {
  const h = (host || '').toLowerCase().replace(/\.+$/, '');
  return ALLOWED_HOSTS.has(h) || ALLOWED_SUFFIXES.some((s) => h.endsWith(s));
}

/** Mirrors net.py validate_url: https only, no credentials, standard port, allowlisted host. */
export function validateUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrl('not a valid URL');
  }
  if (u.protocol !== 'https:') throw new BlockedUrl('only https links are accepted');
  if (u.username || u.password) throw new BlockedUrl('links with credentials are refused');
  if (u.port !== '' && u.port !== '443') throw new BlockedUrl('non-standard ports are refused');
  if (!hostAllowed(u.hostname)) throw new BlockedUrl(`${u.hostname} is not a supported music host`);
  return url;
}

export class CancelToken {
  reason = '';
  private flag = false;
  cancel(reason = 'cancelled'): void {
    this.reason = reason;
    this.flag = true;
  }
  get cancelled(): boolean {
    return this.flag;
  }
  check(): void {
    if (this.flag) throw new Cancelled(this.reason || 'cancelled');
  }
}

/** Counts bytes per category for one request and reports them to the daily store. */
export class Meter {
  counts: Record<string, number> = {};
  constructor(
    readonly cap: number,
    readonly daily: number,
    private readonly sink?: (category: string, n: number) => void,
  ) {}
  get total(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }
  remaining(): number {
    return Math.max(0, Math.min(this.cap - this.total, this.daily - this.total));
  }
  add(category: string, n: number): void {
    this.counts[category] = (this.counts[category] ?? 0) + n;
    this.sink?.(category, n);
  }
  /**
   * A small allowance for work that must still run after a request has used up its own cap (a few
   * kilobytes of artist tags). It has its own cap but never exceeds what is left of the DAY, and what
   * it reads is still counted against the day through `sink`.
   */
  reserve(cap: number, sink?: (category: string, n: number) => void): Meter {
    return new Meter(cap, Math.max(0, this.daily - this.total), sink ?? this.sink);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Minimum spacing between calls to one host (Deezer documents 50 requests / 5 s). */
export class HostPacer {
  private next = new Map<string, number>();
  constructor(
    private readonly spacing: Record<string, number>,
    private readonly fallback = 0.05,
  ) {}
  async wait(host: string): Promise<void> {
    const gapMs = (this.spacing[host] ?? this.fallback) * 1000;
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + gapMs);
    const delay = at - now;
    if (delay > 0) await sleep(delay);
  }
}

export const PACER = new HostPacer({ 'api.deezer.com': 0.11, 'soundcloud.com': 0.3, 'open.spotify.com': 0.2, 'genius.com': 1, 'amp.shazam.com': 1, 'musicbrainz.org': 1.1 });

export interface GetOptions {
  maxBytes: number;
  meter?: Meter;
  category?: string;
  token?: CancelToken;
  retries?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Defaults to GET. A POST body is sent on the first hop only; any redirect then continues as GET. */
  method?: 'GET' | 'POST';
  body?: string;
}

class Retryable extends Error {}

export class Http {
  constructor(private readonly port: HttpPort, private readonly pacer: HostPacer = PACER) {}

  async get(url: string, opt: GetOptions): Promise<{ response: HttpResponse; finalUrl: string }> {
    const retries = opt.retries ?? 2;
    let attempt = 0;
    for (;;) {
      try {
        return await this.getOnce(url, opt);
      } catch (e) {
        if (!(e instanceof Retryable) && !isTransportError(e)) throw e;
        attempt += 1;
        if (attempt > retries) throw new FetchError(`${hostOf(url)}: ${(e as Error).message}`);
        opt.token?.check();
        await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
      }
    }
  }

  async getJson<T = unknown>(url: string, opt: GetOptions): Promise<T> {
    const { response, finalUrl } = await this.get(url, { ...opt, maxBytes: opt.maxBytes });
    if (response.status >= 400) throw new FetchError(`HTTP ${response.status} from ${hostOf(finalUrl)}`);
    try {
      return JSON.parse(new TextDecoder().decode(response.body)) as T;
    } catch {
      throw new FetchError('invalid JSON');
    }
  }

  /** Follow (validated) redirects of a share link without reading the body beyond 64 KB. */
  async resolveRedirects(url: string, opt: { meter?: Meter; token?: CancelToken } = {}): Promise<string> {
    const { finalUrl } = await this.get(url, { maxBytes: 262_144, meter: opt.meter, token: opt.token, category: 'metadata', retries: 1 });
    return finalUrl;
  }

  private async getOnce(url: string, opt: GetOptions): Promise<{ response: HttpResponse; finalUrl: string }> {
    const maxRedirects = opt.maxRedirects ?? 4;
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      opt.token?.check();
      validateUrl(current);
      const host = hostOf(current);
      await this.pacer.wait(host);
      let cap = opt.maxBytes;
      if (opt.meter) {
        cap = Math.min(cap, opt.meter.remaining());
        if (cap <= 0) throw new BudgetExceeded('transfer allowance for this request is used up');
      }
      const post = hop === 0 && opt.method === 'POST';
      const response = await this.port.request(
        post
          ? { url: current, method: 'POST', headers: opt.headers, body: opt.body ?? '', timeoutMs: opt.timeoutMs }
          : { url: current, method: 'GET', headers: opt.headers, timeoutMs: opt.timeoutMs },
        undefined,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const loc = response.headers['location'];
        if (!loc) throw new FetchError('redirect without location');
        current = new URL(loc, current).toString();
        continue;
      }
      if (response.status === 429 || response.status >= 500) throw new Retryable(`HTTP ${response.status}`);
      const declared = response.headers['content-length'];
      if (declared && /^\d+$/.test(declared) && Number(declared) > cap) {
        throw new BudgetExceeded(`${host} declared ${declared} bytes, over the ${cap}-byte cap`);
      }
      // The transport has already buffered the body; the cap is enforced on what actually arrived.
      if (response.body.byteLength > cap) {
        opt.meter?.add(opt.category ?? 'metadata', response.body.byteLength);
        throw new BudgetExceeded(`${host} sent more than the ${cap}-byte cap; aborted`);
      }
      opt.meter?.add(opt.category ?? 'metadata', response.body.byteLength);
      return { response, finalUrl: current };
    }
    throw new FetchError('too many redirects');
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isTransportError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof Error && /network|timed out|fetch/i.test(e.message) && !(e instanceof FetchError));
}
