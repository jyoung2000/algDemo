/** Track record shape and constructors, ported from providers.py (release, make_track, preview_expiry). */
import { parseTitle, recordingKey } from './identity';
import type { Tag } from './genres';

export interface Release {
  date: string;
  precision: 'day' | 'month' | 'year';
  kind: string;
  source: string;
}

export interface Track {
  id: string;
  provider: string;
  platform_id: string;
  key: string;
  title: string;
  artists: string[];
  artist: string;
  album: string | null;
  version: string | null;
  versions: string[];
  duration: number | null;
  artwork: string | null;
  url: string;
  isrc: string | null;
  release: Release | null;
  tags: Tag[];
  artist_ids: Record<string, string>;
  preview: string | null;
  explicit: boolean | null;
  bpm: number | null;
  kind: string;
  [extra: string]: unknown;
}

const PREVIEW_EXP = /exp=(\d+)/;

/** Unix seconds a signed Deezer preview URL stops working; 0 when unsigned. */
export function previewExpiry(url: string): number {
  const m = PREVIEW_EXP.exec(url || '');
  return m ? Number(m[1]) : 0;
}

/** Release info with explicit precision. `kind`: release | upload | first_seen. */
export function release(dateStr: string | null | undefined, kind: string, source: string): Release | null {
  if (!dateStr) return null;
  let s = String(dateStr);
  if (/^\d{8}$/.test(s)) s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    if (s.startsWith('0000')) return null;
    return { date: s, precision: 'day', kind, source };
  }
  if (/^\d{4}-\d{2}$/.test(s)) return { date: s, precision: 'month', kind, source };
  if (/^\d{4}$/.test(s)) return { date: s, precision: 'year', kind, source };
  return null;
}

export function makeTrack(p: {
  provider: string; platformId: string; title: string; artists: string[]; version?: string; album?: string | null;
  duration?: number | null; artwork?: string | null; url: string; isrc?: string | null; rel?: Release | null;
  tags?: (Tag | null)[]; artistIds?: Record<string, string>; preview?: string | null; explicit?: boolean | null;
  bpm?: number | null; kind?: string; extra?: Record<string, unknown>;
}): Track {
  const parsed = parseTitle(p.title, p.version || '');
  const t: Track = {
    id: `${p.provider}:${p.platformId}`,
    provider: p.provider,
    platform_id: p.platformId,
    key: recordingKey(p.title, p.artists, p.version || ''),
    title: p.title,
    artists: p.artists,
    artist: p.artists.join(', '),
    album: p.album ?? null,
    version: parsed.displayVersion,
    versions: [...parsed.versions].sort(),
    duration: p.duration ? Math.round(p.duration) : null,
    artwork: p.artwork ?? null,
    url: p.url,
    isrc: p.isrc ?? null,
    release: p.rel ?? null,
    tags: ((p.tags ?? []).filter((x) => x) as Tag[]),
    artist_ids: p.artistIds ?? {},
    preview: p.preview ?? null,
    explicit: p.explicit ?? null,
    bpm: p.bpm && p.bpm > 0 ? p.bpm : null,
    kind: p.kind ?? 'song',
  };
  if (p.extra) Object.assign(t, p.extra);
  return t;
}
