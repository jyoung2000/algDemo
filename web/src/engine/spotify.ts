/**
 * Spotify (public oEmbed only) and link routing, ported from providers.py (Spotify, provider_for_url,
 * looks_like_url, normalise_url). oEmbed gives title + artwork + embed but no artist, so a pasted
 * Spotify link needs a cross-provider match the user confirms.
 */
import type { CancelToken, Http, Meter } from './net';
import { BlockedUrl, validateUrl } from './net';
import { makeTrack, type Track } from './track';
import { cached, ProviderError } from './deezer';
import type { Store } from './store';

export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

const SP_TRACK = /^\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})/;

export class Spotify {
  readonly name = 'spotify';
  readonly label = 'Spotify';

  constructor(private readonly http: Http, private readonly store?: Store) {}

  async resolveLink(url: string, c: Ctx = {}): Promise<Track> {
    let u = new URL(url);
    if (u.hostname === 'spotify.link' || u.hostname === 'spotify.app.link') {
      u = new URL(await this.http.resolveRedirects(url, c));
      if (u.hostname !== 'open.spotify.com') throw new ProviderError('That Spotify short link did not lead to a Spotify page.');
    }
    const m = SP_TRACK.exec(u.pathname);
    if (!m) throw new ProviderError('That Spotify link is not a track link.');
    const [, kind, sid] = m as unknown as [string, string, string];
    if (kind !== 'track') {
      throw new ProviderError(`That is a Spotify ${kind}. Spotify's public oEmbed does not list its tracks; paste a track link instead.`);
    }
    return cached(this.store, `sp:track:${sid}`, 'track', 7 * 86400, async () => {
      const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 100_000 };
      if (c.meter) o.meter = c.meter;
      if (c.token) o.token = c.token;
      let d: Record<string, any>;
      try {
        d = await this.http.getJson(`https://open.spotify.com/oembed?url=https://open.spotify.com/track/${sid}`, o);
      } catch (e) {
        if (/^HTTP 40[04]\b/.test((e as Error).message)) throw new ProviderError('Spotify has no track at that link, or it is not available in public.');
        throw e;
      }
      if (!d['title']) throw new ProviderError('Spotify did not identify that track (it may be unavailable).');
      return makeTrack({
        provider: 'spotify', platformId: sid, title: d['title'], artists: d['author_name'] ? [d['author_name']] : [],
        artwork: d['thumbnail_url'] ?? null, url: `https://open.spotify.com/track/${sid}`,
        extra: { incomplete: !d['author_name'], embed_url: d['iframe_url'] ?? null },
      });
    });
  }

  playbackLink(t: Track): { kind: 'embed'; embed: string; open: string; label: string } {
    return { kind: 'embed', embed: `https://open.spotify.com/embed/track/${t.platform_id}`, open: t.url, label: 'Open in Spotify' };
  }
}

// ---- link routing ---------------------------------------------------------------------------

export type ProviderName = 'deezer' | 'spotify' | 'soundcloud' | 'ytmusic';

export function providerForUrl(url: string): ProviderName {
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith('deezer.com') || host === 'deezer.page.link') return 'deezer';
  if (['open.spotify.com', 'spotify.link', 'spotify.app.link'].includes(host)) return 'spotify';
  if (host.endsWith('soundcloud.com')) return 'soundcloud';
  if (['youtu.be', 'www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) return 'ytmusic';
  throw new BlockedUrl('Paste a Spotify, SoundCloud, YouTube, YouTube Music or Deezer link.');
}

export function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/|$)/i.test(t) && !t.includes(' ');
}

/** Add https://, upgrade http, and refuse anything off the allowlist. */
export function normaliseUrl(text: string): string {
  let t = text.trim();
  if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
  if (t.toLowerCase().startsWith('http://')) t = 'https://' + t.slice(7);
  validateUrl(t);
  return t;
}
