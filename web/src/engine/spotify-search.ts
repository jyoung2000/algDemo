/**
 * Spotify search, through spotDL's own `save` command (spotDL 4.6.0, run by the Windows shell).
 *
 * Spotify's search API needs a developer token that a public client cannot get (the anonymous token
 * endpoint answers 403), so the only search path is spotDL: `spotdl save "<query>" --save-file <f>`
 * writes the Spotify songs it finds to a JSON file with their Spotify URLs, artists, album and
 * duration. This module turns that JSON into tracks. The shell does the process call (`run`), so this
 * file has no Node or Electron imports and can be tested with a fixed answer.
 */
import { makeTrack, type Track } from './track';

export type RunSpotdl = (query: string, limit: number) => Promise<unknown>;

const SPOTIFY_TRACK = /^https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]{22})(?:[/?#].*)?$/;

/** Maps spotDL's saved-song records to tracks. Records without a Spotify track URL are dropped. */
export function parseSpotdlSaved(records: unknown, limit: number): Track[] {
  if (!Array.isArray(records)) return [];
  const out: Track[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const url = typeof rec['url'] === 'string' ? rec['url'] : '';
    const m = SPOTIFY_TRACK.exec(url);
    const title = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
    if (!m || !title) continue;
    const artists = Array.isArray(rec['artists']) ? rec['artists'].map(String).filter(Boolean) : [];
    const duration = typeof rec['duration'] === 'number' && rec['duration'] > 0 ? rec['duration'] : null;
    const album = typeof rec['album_name'] === 'string' && rec['album_name'] ? rec['album_name'] : null;
    const artwork = typeof rec['cover_url'] === 'string' && rec['cover_url'] ? rec['cover_url'] : null;
    const year = typeof rec['year'] === 'number' ? String(rec['year']) : null;
    out.push(
      makeTrack({
        provider: 'spotify',
        platformId: m[1] as string,
        title,
        artists,
        album,
        duration,
        artwork,
        url: `https://open.spotify.com/track/${m[1]}`,
        isrc: typeof rec['isrc'] === 'string' && rec['isrc'] ? rec['isrc'] : null,
        rel: year ? { date: year, precision: 'year', kind: 'release', source: 'spotify' } : null,
        extra: { found_by: 'spotdl' },
      }),
    );
    if (out.length >= limit) break;
  }
  return out;
}

/** Search Spotify for `query` through spotDL. Throws when spotDL is not available in this shell. */
export async function searchSpotify(run: RunSpotdl | null, query: string, limit: number): Promise<Track[]> {
  if (!run) throw new Error('Spotify search runs only in the Windows app.');
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  return parseSpotdlSaved(await run(q, limit), limit);
}
