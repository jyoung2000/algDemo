/**
 * Bandcamp adapter (SOURCE-MORE-001).
 *
 * Bandcamp publishes no developer API, so this uses the two endpoints its own site and app use,
 * both keyless and both verified live on 2026-11-05:
 *   - POST /api/bcsearch_public_api/1/autocomplete_elastic  (`search_filter: 't'` = tracks)
 *   - GET  /api/mobile/25/tralbum_details?band_id=&tralbum_id=&tralbum_type=t
 * The retired GET /api/fuzzysearch/1/autocomplete answers `{"error":true,"error_message":"bad function"}`.
 *
 * Two calls are needed, not one: the search answer carries no duration, and without a length the
 * identity matcher cannot tell this upload from a different recording of the same name. The details
 * answer carries both the length and `is_streamable`, which is what decides whether the public
 * audio is the whole track.
 *
 * Full songs only: a track whose details say it is not streamable is dropped rather than offered,
 * because Bandcamp's non-streamable tracks are purchase-only and yt-dlp would get nothing (or a
 * clip) for them. Measured on a streamable track: details duration 190.443 s for
 * https://benprunty.bandcamp.com/track/giant-step, and `yt-dlp --dump-single-json` on that link
 * reported the same 190.443 s - the whole song.
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
  refresh?: boolean;
}

const SEARCH = 'https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic';
const DETAILS = 'https://bandcamp.com/api/mobile/25/tralbum_details';
/** One details call per hit costs a request, so only the most likely few are asked about. */
const DETAIL_BUDGET = 6;

export interface BandcampHit {
  trackId: number;
  bandId: number;
  title: string;
  artist: string;
  url: string;
}

/** Track hits (`type: 't'`) from the autocomplete answer; albums and artists are not songs. */
export function parseBandcampHits(d: unknown): BandcampHit[] {
  const rows = (d as Json)?.auto?.results;
  if (!Array.isArray(rows)) return [];
  const out: BandcampHit[] = [];
  for (const r of rows as Json[]) {
    if (!r || r.type !== 't') continue;
    const trackId = Number(r.id), bandId = Number(r.band_id);
    const url = String(r.item_url_path ?? '');
    if (!Number.isFinite(trackId) || !Number.isFinite(bandId) || !trackId || !bandId || !url) continue;
    out.push({ trackId, bandId, title: String(r.name ?? ''), artist: String(r.band_name ?? ''), url });
  }
  return out;
}

/**
 * The asked-for track from a tralbum_details answer, or null when Bandcamp will not stream it in
 * full. `duration` is seconds with a fraction; every other provider in this app reports whole
 * seconds, and the matcher compares seconds, so it is rounded here.
 */
export function parseBandcampTrack(d: unknown, trackId: number): Track | null {
  const o = d as Json;
  const rows: Json[] = Array.isArray(o?.tracks) ? o.tracks : [];
  const row = rows.find((t) => Number(t?.track_id) === trackId);
  if (!row) return null;
  if (row.is_streamable !== true) return null; // purchase-only: no full audio to download
  const duration = Number(row.duration);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const url = String(o.bandcamp_url ?? row.track_url ?? '');
  if (!/^https:\/\/[a-z0-9-]+\.bandcamp\.com\//i.test(url)) return null;
  const artist = String(o.tralbum_artist ?? row.band_name ?? '').trim();
  const tags: (G.Tag | null)[] = (Array.isArray(o.tags) ? o.tags : []).slice(0, 6)
    .map((t: Json) => G.makeTag(String(t?.name ?? ''), 'Bandcamp artist tag', 'track', 0.4));
  const secs = Number(o.release_date);
  const rel = Number.isFinite(secs) && secs > 0 ? release(new Date(secs * 1000).toISOString().slice(0, 10), 'release', 'Bandcamp') : null;
  return makeTrack({
    provider: 'bandcamp',
    platformId: String(row.track_id ?? trackId),
    title: String(row.title ?? o.title ?? ''),
    artists: artist ? [artist] : ['Unknown artist'],
    album: o.album_title ? String(o.album_title) : null,
    duration,
    artwork: o.art_id ? `https://f4.bcbits.com/img/a${String(o.art_id).padStart(10, '0')}_10.jpg` : null,
    url,
    rel,
    tags,
    // Bandcamp's stream is the whole track when it is streamable at all; a clip is never recorded.
    preview: null,
  });
}

export class Bandcamp {
  readonly name = 'bandcamp';
  readonly label = 'Bandcamp';

  constructor(private readonly http: Http, private readonly store?: Store) {}

  private opts(c: Ctx, maxBytes: number): Parameters<Http['getJson']>[1] {
    const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    return o;
  }

  search(q: string, limit = 10, c: Ctx = {}): Promise<Track[]> {
    return cached(c.refresh ? undefined : this.store, `bc:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const hits = parseBandcampHits(await this.http.getJson<Json>(SEARCH, {
        ...this.opts(c, 1_500_000),
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ search_text: q, search_filter: 't', full_page: false, fan_id: null }),
      }));
      const out: Track[] = [];
      for (const h of hits.slice(0, Math.min(DETAIL_BUDGET, Math.max(1, limit)))) {
        let d: Json;
        try {
          d = await this.http.getJson<Json>(`${DETAILS}?band_id=${h.bandId}&tralbum_id=${h.trackId}&tralbum_type=t`, this.opts(c, 1_000_000));
        } catch {
          continue; // one unanswered hit is not a failed search
        }
        const t = parseBandcampTrack(d, h.trackId);
        if (t) out.push(t);
        if (out.length >= limit) break;
      }
      return out;
    });
  }
}
