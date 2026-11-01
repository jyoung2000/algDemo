/**
 * How a track leaves the engine for the UI (port of app.py: TRACK_FIELDS, clean_track, preview_route,
 * playback_for). Kept apart from the pipeline so the queue and the routes share one definition.
 */
import type { Playback } from '../api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dict = Record<string, any>;

export const TRACK_FIELDS = [
  'id', 'provider', 'platform_id', 'key', 'title', 'artists', 'artist', 'album', 'version', 'versions', 'duration', 'artwork', 'url',
  'isrc', 'release', 'tags', 'preview', 'explicit', 'bpm', 'kind', 'warning', 'incomplete', 'embed_url', 'artist_ids', 'album_id',
] as const;

export const SOURCE_LABELS: Record<string, string> = {
  'apple-search': 'Apple Music · search',
  'spotify-search': 'Spotify · search',
  'ytmusic-related': 'YouTube Music · You might also like',
  'ytmusic-radio': 'YouTube Music · radio',
  'ytmusic-similar-artists': 'YouTube Music · similar artists',
  'deezer-artist-radio': 'Deezer · artist radio',
  'deezer-related-artists': 'Deezer · related artists',
  'deezer-artist-top': 'Deezer · artist top tracks',
  'deezer-recent': 'Deezer · recent releases',
  'deezer-genre-chart': 'Deezer · genre chart (exploration)',
  'soundcloud-recommended': 'SoundCloud · recommended',
};

export const PREVIEW_ROUTE = '/api/preview/deezer/';

/**
 * Deezer preview URLs are signed for ~15 minutes, longer than tracks stay cached, so the UI holds a
 * stable route instead and asks for a fresh signed address when it plays (api.previewUrl).
 */
export function previewRoute(t: Dict): string | null {
  const did = t['dz_id'] || t['dz_preview_id'] || (t['provider'] === 'deezer' ? t['platform_id'] : null);
  if (did && /^\d+$/.test(String(did))) return `${PREVIEW_ROUTE}${did}`;
  return (t['preview'] as string | null) ?? null;
}

export function cleanTrack(t: Dict): Dict {
  const out: Dict = {};
  for (const k of TRACK_FIELDS) if (t[k] !== undefined && t[k] !== null) out[k] = t[k];
  if (out['preview']) out['preview'] = previewRoute(t);
  return out;
}

const LABELS: Record<string, string> = { ytmusic: 'YouTube Music', deezer: 'Deezer', soundcloud: 'SoundCloud', spotify: 'Spotify', apple: 'Apple Music' };
const ORDER = ['ytmusic', 'deezer', 'soundcloud', 'spotify', 'apple'] as const;

export function playbackFor(c: Dict): Playback {
  const links: Dict = c['links'] || { [c['provider']]: { url: c['url'], id: c['platform_id'] } };
  const out: Playback = { open: [], preview: c['preview'] ? previewRoute(c) : null, embed: null };
  for (const p of ORDER) {
    if (p in links) out.open.push({ provider: p, label: `Open in ${LABELS[p]}`, url: links[p].url });
  }
  if ('ytmusic' in links) {
    out.embed = { provider: 'ytmusic', url: `https://www.youtube-nocookie.com/embed/${links['ytmusic'].id}?autoplay=1&rel=0` };
  } else if ('soundcloud' in links) {
    out.embed = { provider: 'soundcloud', url: `https://w.soundcloud.com/player/?url=${encodeURIComponent(links['soundcloud'].url)}&auto_play=true&visual=false` };
  }
  return out;
}

export const round = (x: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
