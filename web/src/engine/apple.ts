/**
 * Apple Music search via the public iTunes Search API (no key). Ported from MusicSearch's
 * backend/applemusic.py search path. Search only: preview and artwork hosts are not on the
 * allowlist, so preview is left null and artwork is passed through for the UI to show.
 */
import type { CancelToken, Http, Meter } from './net';
import { makeTrack, release, type Track } from './track';
import { cached } from './deezer';
import type { Store } from './store';

type Json = Record<string, any>;
export interface Ctx {
  meter?: Meter;
  token?: CancelToken;
}

/** Maps an iTunes `/search?entity=song` response to tracks. Pure, so it can be tested without a network. */
export function parseItunes(resp: Json): Track[] {
  const out: Track[] = [];
  for (const r of (resp['results'] ?? []) as Json[]) {
    if (r['wrapperType'] !== 'track' || r['kind'] !== 'song') continue;
    if (!r['trackId'] || !r['trackName'] || !r['artistName']) continue;
    const art = typeof r['artworkUrl100'] === 'string' ? (r['artworkUrl100'] as string).replace('100x100bb', '600x600bb') : null;
    out.push(
      makeTrack({
        provider: 'apple',
        platformId: String(r['trackId']),
        title: String(r['trackName']),
        artists: [String(r['artistName'])],
        album: r['collectionName'] ? String(r['collectionName']) : null,
        duration: typeof r['trackTimeMillis'] === 'number' ? r['trackTimeMillis'] / 1000 : null,
        artwork: art,
        url: String(r['trackViewUrl'] ?? r['collectionViewUrl'] ?? ''),
        isrc: null,
        rel: release(typeof r['releaseDate'] === 'string' ? r['releaseDate'].slice(0, 10) : null, 'release', 'apple'),
        preview: null,
        explicit: r['trackExplicitness'] === 'explicit' ? true : r['trackExplicitness'] === 'notExplicit' ? false : null,
        extra: { genre: r['primaryGenreName'] ?? null },
      }),
    );
  }
  return out;
}

export class AppleMusic {
  readonly name = 'apple';
  readonly label = 'Apple Music';

  constructor(private readonly http: Http, private readonly store?: Store) {}

  search(q: string, limit = 15, c: Ctx = {}): Promise<Track[]> {
    const term = q.trim();
    return cached(this.store, `ap:search:${term.toLowerCase()}:${limit}`, 'search', 15 * 60, async () => {
      const o: Parameters<Http['getJson']>[1] = { category: 'search', maxBytes: 400_000 };
      if (c.meter) o.meter = c.meter;
      if (c.token) o.token = c.token;
      const d = await this.http.getJson<Json>(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}`,
        o,
      );
      return parseItunes(d);
    });
  }
}
