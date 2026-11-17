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
import { DEEZER_API_UA, type CancelToken, type Http, type Meter } from './net';
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
const BAND = 'https://bandcamp.com/api/mobile/25/band_details';
/** This app's own name, the same one it gives Deezer; never a browser's. */
const APP_UA = DEEZER_API_UA;
const TRACK_URL = /^https:\/\/[a-z0-9-]+\.bandcamp\.com\//i;
const artOf = (id: unknown): string | null => (id ? `https://f4.bcbits.com/img/a${String(id).padStart(10, '0')}_10.jpg` : null);
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
    artwork: artOf(o.art_id),
    url,
    rel,
    tags,
    // Bandcamp's stream is the whole track when it is streamable at all; a clip is never recorded.
    preview: null,
  });
}

/** An artist or label page from the search (`type: 'b'`). */
export interface BandcampBand {
  id: number;
  name: string;
  url: string;
}

export function parseBandcampBands(d: unknown): BandcampBand[] {
  const rows = (d as Json)?.auto?.results;
  if (!Array.isArray(rows)) return [];
  const out: BandcampBand[] = [];
  for (const r of rows as Json[]) {
    const id = Number(r?.id);
    if (!r || r.type !== 'b' || !Number.isSafeInteger(id) || id <= 0) continue;
    out.push({ id, name: String(r.name ?? ''), url: String(r.item_url_root ?? '') });
  }
  return out;
}

/** One row of a page's discography: an album or a track released on its own. */
export interface BandcampItem {
  id: number;
  bandId: number;
  type: 'a' | 't';
  title: string;
  year: string | null;
}

export function parseBandcampDiscography(d: unknown): BandcampItem[] {
  const o = d as Json;
  const rows: Json[] = Array.isArray(o?.discography) ? o.discography : [];
  const out: BandcampItem[] = [];
  for (const r of rows) {
    const id = Number(r?.item_id);
    const bandId = Number(r?.band_id ?? o.id);
    const type = r?.item_type === 'album' ? 'a' : r?.item_type === 'track' ? 't' : null;
    const title = String(r?.title ?? '').trim();
    if (!type || !title || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(bandId) || bandId <= 0) continue;
    out.push({ id, bandId, type, title, year: /\b(\d{4})\b/.exec(String(r.release_date ?? ''))?.[1] ?? null });
  }
  return out;
}

/** An album or a track's own page, with only the songs whose public audio is the whole song. */
export interface BandcampRelease {
  isAlbum: boolean;
  title: string;
  artist: string;
  url: string;
  artwork: string | null;
  year: string | null;
  genres: string[];
  tracks: Track[];
  /** Every song the release lists, playable or not: what makes it an album rather than a single. */
  total: number;
}

export function parseBandcampRelease(d: unknown): BandcampRelease | null {
  const o = d as Json;
  if (!o || typeof o !== 'object' || !Array.isArray(o.tracks)) return null;
  const title = String(o.title ?? '').trim();
  if (!title) return null;
  const isAlbum = o.type === 'a';
  const artist = String(o.tralbum_artist ?? o.band?.name ?? '').trim();
  const secs = Number(o.release_date);
  const day = Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString().slice(0, 10) : null;
  const names: string[] = (Array.isArray(o.tags) ? o.tags : []).map((t: Json) => String(t?.name ?? '').trim()).filter(Boolean).slice(0, 6);
  const tracks: Track[] = [];
  const credits = titleCredits((o.tracks as Json[]).map((row) => String(row?.title ?? '')), isAlbum);
  (o.tracks as Json[]).forEach((row, i) => {
    // Purchase-only songs have no full audio to play: this app plays whole songs or nothing.
    if (!row || row.is_streamable !== true) return;
    const duration = Number(row.duration);
    const url = String(row.track_url ?? (isAlbum ? '' : o.bandcamp_url) ?? '');
    if (!Number.isFinite(duration) || duration <= 0 || !TRACK_URL.test(url)) return;
    const credit = credits?.[i] ?? null;
    const who = credit?.artist || artist || String(row.band_name ?? '').trim();
    tracks.push(makeTrack({
      provider: 'bandcamp',
      platformId: String(row.track_id ?? url),
      title: credit?.title ?? String(row.title ?? ''),
      artists: who ? [who] : ['Unknown artist'],
      album: isAlbum ? title : null,
      duration,
      artwork: artOf(row.art_id) ?? artOf(o.art_id),
      url,
      rel: day ? release(day, 'release', 'Bandcamp') : null,
      tags: names.map((n) => G.makeTag(n, 'Bandcamp artist tag', 'track', 0.4)),
      preview: null,
    }));
  });
  return { isAlbum, title, artist, url: String(o.bandcamp_url ?? ''), artwork: artOf(o.art_id), year: day ? day.slice(0, 4) : null, genres: names, tracks, total: o.tracks.length };
}

const NUMBERING = /^(?:part|pt|act|chapter|side|vol(?:ume)?|track|scene|movement|no|disc|cd|episode|suite|op(?:us)?)\b|^\d+$|^[ivxlc]+$/i;

/**
 * COMPILATION-001. Measured 2026-11-16 on "LateNightTales: Khruangbin": a mix of other artists' music
 * is credited whole to the page it is sold on, and each song's own artist is written into its title,
 * "Carlos Santana - Illuminations". That is Bandcamp's convention for such records, so when an album's
 * titles are written that way the artist is read from the title.
 *
 * Only when it is plainly the convention: an album of at least three songs, more than half of them
 * written "Someone - Something", naming at least two different someones, none of which is numbering
 * ("Part 1 - ..."). One dashed title on an ordinary record is a title. Null when it does not apply.
 */
export function titleCredits(titles: readonly string[], isAlbum: boolean): ({ artist: string; title: string } | null)[] | null {
  if (!isAlbum || titles.length < 3) return null;
  const split = titles.map((t) => {
    const m = /^(.{1,80}?)\s+[-\u2013\u2014]\s+(\S.*)$/.exec(t.trim());
    return m ? { artist: m[1]!.trim(), title: m[2]!.trim() } : null;
  });
  const hits = split.filter((x): x is { artist: string; title: string } => x !== null);
  if (hits.length * 2 <= titles.length) return null;
  if (hits.some((x) => NUMBERING.test(x.artist))) return null;
  if (new Set(hits.map((x) => fold(x.artist))).size < 2) return null;
  return split;
}

export class Bandcamp {
  readonly name = 'bandcamp';
  readonly label = 'Bandcamp';

  constructor(private readonly http: Http, private readonly store?: Store) {}

  private opts(c: Ctx, maxBytes: number): Parameters<Http['getJson']>[1] {
    // Measured 2026-11-16: asked with no User-Agent at all (as the Windows shell sends by default),
    // /api/mobile answers 200 with a "Client Challenge" web page instead of JSON, and every details
    // call then failed unseen. Named honestly as this app, it answers JSON.
    const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes, headers: { 'user-agent': APP_UA } };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    return o;
  }

  /** ARTIST-ALL-SOURCES-001: the artist and label pages a name finds. */
  bands(q: string, c: Ctx = {}): Promise<BandcampBand[]> {
    return cached(c.refresh ? undefined : this.store, `bc:bands:${fold(q)}`, 'search', 15 * 60, async () =>
      parseBandcampBands(await this.http.getJson<Json>(SEARCH, {
        ...this.opts(c, 1_500_000),
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': APP_UA },
        body: JSON.stringify({ search_text: q, search_filter: 'b', full_page: false, fan_id: null }),
      })));
  }

  /** A page's discography, newest first as Bandcamp lists it. */
  discography(bandId: number, c: Ctx = {}): Promise<BandcampItem[]> {
    return cached(c.refresh ? undefined : this.store, `bc:band:${bandId}`, 'artist', 24 * 3600, async () =>
      parseBandcampDiscography(await this.http.getJson<Json>(`${BAND}?band_id=${bandId}`, this.opts(c, 2_000_000))));
  }

  /** One album (`a`) or lone track (`t`) with its playable songs. */
  async release(bandId: number, type: 'a' | 't', id: number, c: Ctx = {}): Promise<BandcampRelease | null> {
    return parseBandcampRelease(await this.http.getJson<Json>(`${DETAILS}?band_id=${bandId}&tralbum_id=${id}&tralbum_type=${type}`, this.opts(c, 1_500_000)));
  }

  search(q: string, limit = 10, c: Ctx = {}): Promise<Track[]> {
    return cached(c.refresh ? undefined : this.store, `bc:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const hits = parseBandcampHits(await this.http.getJson<Json>(SEARCH, {
        ...this.opts(c, 1_500_000),
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': APP_UA },
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
