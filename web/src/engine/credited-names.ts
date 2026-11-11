import type { Track } from '../api';

/**
 * Display-only credits, not a recording-identity or artist-Features inference. Some providers give
 * only the lead in `artists` and explicitly write `(feat. Guest)` in the title. Preserve those names
 * as links too. Never guess a guest from ordinary title words such as "With or Without You".
 */
export function creditedTrack(track: Track): Track {
  const artists = (track.artists?.length ? track.artists : track.artist ? [track.artist] : []).map(n => n.trim()).filter(Boolean);
  const key = (s: string) => s.normalize('NFKC').toLowerCase();
  const seen = new Set(artists.map(key));
  const credits = [...track.title.matchAll(/[([]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]/gi)].map(m => m[1]!);
  const suffix = /\s+(?:feat\.?|ft\.?|featuring)\s+([^()[\]]+)$/i.exec(track.title);
  if (suffix) credits.push(suffix[1]!);
  for (const credit of credits) {
    // A known band name containing separators stays one name. For explicit guest lists, comma,
    // ampersand and "and" separate the individual links, preserving spelling from the title.
    if (seen.has(key(credit.trim()))) continue;
    for (const raw of credit.split(/\s*(?:,|\s&\s|\sand\s)\s*/i)) {
      const name = raw.trim();
      if (!name || seen.has(key(name))) continue;
      artists.push(name); seen.add(key(name));
    }
  }
  return { ...track, artists };
}
