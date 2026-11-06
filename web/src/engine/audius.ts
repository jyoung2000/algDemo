/**
 * Audius adapter (SOURCE-MORE-001).
 *
 * api.audius.co/v1 is Audius's own documented, keyless read API (an `app_name` is asked for by the
 * docs and sent here; no key, no account, no paid tier). It is in this app for one reason: every
 * track it returns is a whole upload with a real length, and yt-dlp's `audius` extractor downloads
 * it from the same stream endpoint the site plays, so a match here is genuinely downloadable in
 * full rather than identified and then unavailable.
 *
 * Verified live 2026-11-05: the search endpoint answered 200; `yt-dlp --dump-single-json` on
 * https://audius.co/Lofibeat/stars-in-the-sky-lofi-beats-370899 reported duration 71 s from
 * https://api.audius.co/v1/tracks/95wro/stream, exactly the length the API declares.
 *
 * Nothing here loosens identity: the mapping only reports what Audius says, and `matchRecordings`
 * still decides whether the upload is the same recording.
 */
import type { CancelToken, Http, Meter } from './net';
import { cached } from './deezer';
import * as G from './genres';
import { fold } from './identity';
import type { Store } from './store';
import { makeTrack, release, type Track } from './track';

type Json = Record<string, any>;

export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
  /** A user-driven retry: ask again instead of replaying a cached (often empty) answer. */
  refresh?: boolean;
}

const API = 'https://api.audius.co/v1';
/** The docs ask every caller to name itself; this is that name, not a credential. */
export const AUDIUS_APP = 'AirwaveDiscovery';
const SITE = 'https://audius.co';

/**
 * One upload to a Track, or null when the public audio is not the whole song.
 *
 * A gated track (`is_stream_gated`, or any `preview_start_seconds`) plays only a clip without a
 * purchase or an unlock, so it is refused outright: this app downloads whole songs or nothing.
 */
function toTrack(e: Json): Track | null {
  if (!e || typeof e !== 'object') return null;
  if (e.is_delete || e.is_unlisted || e.is_available === false) return null;
  if (e.is_stream_gated || e.preview_start_seconds !== null && e.preview_start_seconds !== undefined) return null;
  const id = String(e.id ?? '');
  const permalink = typeof e.permalink === 'string' ? e.permalink : '';
  const duration = Number(e.duration);
  if (!id || !permalink || !Number.isFinite(duration) || duration <= 0) return null;
  const artist = String(e.user?.name ?? e.user?.handle ?? '').trim();
  const tags: (G.Tag | null)[] = [];
  if (e.genre) tags.push(G.makeTag(String(e.genre), 'Audius uploader genre', 'track', 0.6));
  if (e.mood) tags.push(G.makeTag(String(e.mood), 'Audius uploader mood', 'track', 0.3));
  for (const tg of String(e.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)) {
    tags.push(G.makeTag(tg, 'Audius uploader tag', 'track', 0.4));
  }
  const art: string | null = e.artwork?.['480x480'] ?? e.artwork?.['1000x1000'] ?? e.artwork?.['150x150'] ?? null;
  return makeTrack({
    provider: 'audius',
    platformId: id,
    title: String(e.title ?? ''),
    artists: artist ? [artist] : ['Unknown artist'],
    album: null,
    duration,
    artwork: art,
    url: `${SITE}${permalink.startsWith('/') ? '' : '/'}${permalink}`,
    isrc: typeof e.isrc === 'string' && e.isrc ? e.isrc : null,
    rel: release(String(e.release_date ?? '').slice(0, 10), 'upload', 'Audius'),
    tags,
    // Audius serves the whole upload; this app has no use for a clip and never records one.
    preview: null,
  });
}

/** `{data: [...]}` from /v1/tracks/search to Tracks, dropping anything not downloadable in full. */
export function parseAudiusTracks(d: unknown): Track[] {
  const rows = (d as Json)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((e) => toTrack(e as Json)).filter((t): t is Track => !!t);
}

export class Audius {
  readonly name = 'audius';
  readonly label = 'Audius';

  constructor(private readonly http: Http, private readonly store?: Store) {}

  search(q: string, limit = 10, c: Ctx = {}): Promise<Track[]> {
    return cached(c.refresh ? undefined : this.store, `audius:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 2_000_000 };
      if (c.meter) o.meter = c.meter;
      if (c.token) o.token = c.token;
      const url = `${API}/tracks/search?query=${encodeURIComponent(q)}&limit=${Math.max(1, Math.min(20, limit))}&app_name=${AUDIUS_APP}`;
      return parseAudiusTracks(await this.http.getJson<Json>(url, o)).slice(0, limit);
    });
  }
}
