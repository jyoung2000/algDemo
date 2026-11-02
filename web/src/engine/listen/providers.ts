/**
 * Song identification providers. Neither is a catalogue the app plays from: each only names the song, and
 * LocalApi.identify() then finds that song on the services Airwave already plays from.
 *
 *  - Genius lyric search: https://genius.com/api/search/lyric answers a plain GET with no key. The user's
 *    own words are the query. Hits carry the matching lyric snippet with the matched character ranges.
 *  - Shazam: the app sends only a fingerprint (listen/fingerprint.ts), never sound, to the tag endpoint
 *    ShazamIO (MIT) documents. The response names the track and where in the song the clip matched.
 *
 * Both are unofficial endpoints. They can change or throttle without notice, so every failure is reported
 * to the user as such and nothing here retries on its own.
 */
import type { CancelToken, Http, Meter } from '../net';

type Json = Record<string, any>;
export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

export interface LyricHit {
  title: string;
  artist: string;
  artwork: string | null;
  url: string;
  /** The matching lines, plain text. */
  snippet: string;
  /** [start, end) character ranges of the matched words inside `snippet`. */
  ranges: [number, number][];
}

export interface AudioHit {
  title: string;
  artist: string;
  artwork: string | null;
  url: string;
  isrc: string | null;
  /** Seconds into the song where the clip matched, when Shazam says. */
  offset: number | null;
}

export class LyricsError extends Error {}

/** Parses a Genius `search/lyric` answer. Pure, so it is tested against a recorded response. */
export function parseGeniusLyrics(resp: Json, max = 8): LyricHit[] {
  const out: LyricHit[] = [];
  const hits = (resp?.['response']?.['sections'] ?? []).flatMap((s: Json) => (s?.['hits'] ?? []) as Json[]);
  for (const h of hits) {
    if (h?.['type'] !== 'lyric' && h?.['type'] !== 'song') continue;
    const r = h['result'] as Json | undefined;
    const title = r?.['title'];
    const artist = r?.['primary_artist']?.['name'] ?? r?.['artist_names'];
    if (typeof title !== 'string' || typeof artist !== 'string' || !title || !artist) continue;
    const hl = ((h['highlights'] ?? []) as Json[]).find((x) => x?.['property'] === 'lyrics' && typeof x['value'] === 'string');
    const value = (hl?.['value'] as string | undefined) ?? '';
    // Genius sends offsets into `value`; keep only those that fit, and trim lines so the snippet stays short.
    const ranges = ((hl?.['ranges'] ?? []) as Json[])
      .map((x): [number, number] => [Number(x['start']), Number(x['end'])])
      .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= value.length);
    out.push({
      title,
      artist,
      artwork: typeof r?.['song_art_image_thumbnail_url'] === 'string' ? r['song_art_image_thumbnail_url'] : null,
      url: typeof r?.['url'] === 'string' ? r['url'] : '',
      snippet: value,
      ranges,
    });
    if (out.length >= max) break;
  }
  return out;
}

export class Genius {
  readonly name = 'genius';
  readonly label = 'Genius';
  constructor(private readonly http: Http) {}

  async searchLyrics(words: string, c: Ctx = {}): Promise<LyricHit[]> {
    const q = words.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!q) return [];
    const o: Parameters<Http['getJson']>[1] = { category: 'search', maxBytes: 600_000, retries: 0 };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    const d = await this.http.getJson<Json>(`https://genius.com/api/search/lyric?q=${encodeURIComponent(q)}&per_page=8`, o);
    return parseGeniusLyrics(d);
  }
}

const SHAZAM_URL = 'https://amp.shazam.com/discovery/v5/en-US/US/iphone/-/tag/{a}/{b}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3';

const uuid = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(16).slice(2)}-0000-4000-8000-000000000000`).toUpperCase();

/** Parses a Shazam tag answer into at most one hit (the service returns the single best track). */
export function parseShazam(resp: Json): AudioHit | null {
  const t = resp?.['track'] as Json | undefined;
  if (!t || typeof t['title'] !== 'string' || typeof t['subtitle'] !== 'string' || !t['title'] || !t['subtitle']) return null;
  const off = (resp['matches'] as Json[] | undefined)?.[0]?.['offset'];
  const art = t['images']?.['coverart'] ?? t['images']?.['coverarthq'];
  return {
    title: t['title'],
    artist: t['subtitle'],
    artwork: typeof art === 'string' ? art : null,
    url: typeof t['url'] === 'string' ? t['url'] : '',
    isrc: typeof t['isrc'] === 'string' ? t['isrc'] : null,
    offset: typeof off === 'number' && Number.isFinite(off) && off >= 0 ? off : null,
  };
}

export class Shazam {
  readonly name = 'shazam';
  readonly label = 'Shazam';
  constructor(private readonly http: Http) {}

  async identify(signatureUri: string, sampleMs: number, c: Ctx = {}): Promise<AudioHit | null> {
    const body = JSON.stringify({
      // UTC, not the device's zone: the service does not need to know where the phone is.
      timezone: 'UTC',
      signature: { uri: signatureUri, samplems: Math.trunc(sampleMs) },
      timestamp: Date.now(),
      context: {},
      geolocation: {},
    });
    const o: Parameters<Http['getJson']>[1] = {
      category: 'search',
      maxBytes: 600_000,
      retries: 0,
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', 'x-shazam-platform': 'IPHONE', 'x-shazam-appversion': '14.1.0', accept: '*/*', 'accept-language': 'en-US' },
    };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    const d = await this.http.getJson<Json>(SHAZAM_URL.replace('{a}', uuid()).replace('{b}', uuid()), o);
    return parseShazam(d);
  }
}
