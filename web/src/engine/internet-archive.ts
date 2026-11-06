/**
 * Internet Archive: only single-track audio items explicitly marked with a Creative Commons
 * license and an original, complete MP3/M4A/FLAC. The public metadata API supplies length and
 * file size; neither metadata nor a license claim alone proves the download exists. Native yt-dlp
 * must finish the whole file before the queue marks it ready. This source cannot fill an absent
 * commercial catalogue recording with a different Archive uploader's rendition.
 */
import type { CancelToken, Http, Meter } from './net';
import { cached } from './deezer';
import { fold } from './identity';
import type { Store } from './store';
import { makeTrack, type Track } from './track';

type Json = Record<string, any>;
export interface Ctx { meter?: Meter; token?: CancelToken; refresh?: boolean }
const SITE = 'https://archive.org';
const IDENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,100}$/;
const AUDIO_NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()&+-]{0,180}\.(?:mp3|m4a|flac)$/i;
const MAX_FILE_BYTES = 100_000_000;
const DETAIL_BUDGET = 6;

function declaredLicense(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && u.hostname === 'creativecommons.org' &&
      (/^\/licenses\/(?:by|by-sa|by-nc|by-nc-sa|by-nd|by-nc-nd)\/[234]\.0\/?$/.test(u.pathname) ||
       /^\/publicdomain\/(?:zero|mark)\/1\.0\/?$/.test(u.pathname));
  } catch { return false; }
}

/** A private/missing/ambiguous item is no song. Do not use Archive's generated previews. */
export function parseArchiveItem(raw: unknown, identifier: string): Track[] {
  const d = raw as Json;
  const meta = d?.metadata as Json | undefined;
  if (!IDENT.test(identifier) || meta?.identifier !== identifier || meta.mediatype !== 'audio' ||
      !declaredLicense(meta.licenseurl) || !Array.isArray(d?.files)) return [];
  const original = (d.files as Json[]).filter(f => f && f.source === 'original' &&
    typeof f.name === 'string' && AUDIO_NAME.test(f.name) && !f.name.includes('..') &&
    Number.isFinite(Number(f.size)) && Number(f.size) >= 100_000 && Number(f.size) <= MAX_FILE_BYTES &&
    Number.isFinite(Number(f.length)) && Number(f.length) > 45 && Number(f.length) <= 3600 &&
    f.private !== true && f.is_dark !== true);
  // Multi-song albums require track-specific artist/title metadata; item-level metadata is not it.
  if (original.length !== 1) return [];
  const f = original[0]!;
  const artist = String(meta.creator ?? '').trim();
  if (!artist || artist.length > 120 || Array.isArray(meta.creator)) return [];
  let title = String(meta.title ?? '').replace(/[-_]+/g, ' ').trim();
  if (!title) return [];
  const byArtist = new RegExp(`\\s+by\\s+${fold(artist).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  title = title.replace(byArtist, '').trim();
  // An Archive item may claim a license but still be a mismatched upload: the chain compares
  // title, artist and duration strictly before offering its direct file to the downloader.
  const fileUrl = `${SITE}/download/${encodeURIComponent(identifier)}/${encodeURIComponent(f.name)}`;
  return [makeTrack({ provider: 'archive', platformId: identifier, title, artists: [artist],
    duration: Number(f.length), url: fileUrl, preview: null })];
}

export class InternetArchive {
  readonly name = 'archive';
  readonly label = 'Internet Archive (Creative Commons)';
  constructor(private readonly http: Http, private readonly store?: Store) {}
  private opts(c: Ctx): Parameters<Http['getJson']>[1] {
    const o: Parameters<Http['getJson']>[1] = { category: 'metadata', maxBytes: 2_000_000 };
    if (c.meter) o.meter = c.meter;
    if (c.token) o.token = c.token;
    return o;
  }
  search(q: string, limit = 10, c: Ctx = {}): Promise<Track[]> {
    return cached(c.refresh ? undefined : this.store, `archive:search:${fold(q)}:${limit}`, 'search', 15 * 60, async () => {
      const terms = fold(q).split(' ').filter(Boolean).slice(0, 8).join(' ');
      if (!terms) return [];
      const query = `title:(${terms}) AND mediatype:audio AND licenseurl:(*creativecommons.org*)`;
      const url = `${SITE}/advancedsearch.php?${new URLSearchParams({ q: query, 'fl[]': 'identifier', rows: String(Math.min(DETAIL_BUDGET, Math.max(1, limit))), output: 'json' })}`;
      const data = await this.http.getJson<Json>(url, this.opts(c));
      const docs = Array.isArray(data?.response?.docs) ? data.response.docs as Json[] : [];
      const result: Track[] = [];
      for (const doc of docs.slice(0, DETAIL_BUDGET)) {
        const id = doc?.identifier;
        if (typeof id !== 'string' || !IDENT.test(id)) continue;
        try {
          const item = await this.http.getJson<Json>(`${SITE}/metadata/${id}`, this.opts(c));
          result.push(...parseArchiveItem(item, id));
        } catch { /* One missing item does not hide later candidates. */ }
        if (result.length >= limit) break;
      }
      return result.slice(0, limit);
    });
  }
}
