/**
 * Turns "this song was named by Genius / Shazam" into rows the app can play and Add: search the catalogues
 * Airwave already uses for "artist title" and keep results that matchRecordings() accepts as the same
 * recording. A named song with no playable match is dropped and counted, never shown as a row that cannot be added.
 */
import type { Ctx as ProviderCtx } from '../deezer';
import { matchRecordings } from '../identity';
import type { Dict } from '../shape';
import { cleanTrack } from '../shape';
import type { AudioHit, LyricHit } from './providers';

interface Searcher {
  search(q: string, n: number, c: ProviderCtx): Promise<Dict[]>;
}

export interface Evidence {
  kind: 'lyrics' | 'audio';
  /** Lyrics: the matching lines and the [start, end) ranges to highlight. */
  snippet?: string;
  ranges?: [number, number][];
  /** Audio: seconds into the song where the clip matched. */
  offset?: number | null;
}

export interface Identified {
  results: Dict[];
  /** How many named songs had no playable catalogue match. */
  unplayable: number;
}

const ORDER = ['deezer', 'ytmusic', 'apple'] as const;

async function playable(hit: { title: string; artist: string; isrc?: string | null }, searchers: Record<string, Searcher>, c: ProviderCtx): Promise<Dict | null> {
  const q = `${hit.artist} ${hit.title}`.slice(0, 200);
  const lists = await Promise.all(
    ORDER.map((name) => (searchers[name] ? searchers[name]!.search(q, 6, c).catch(() => [] as Dict[]) : Promise.resolve([] as Dict[]))),
  );
  const want = { title: hit.title, artists: [hit.artist], isrc: hit.isrc ?? null };
  let uncertain: Dict | null = null;
  for (const list of lists) {
    for (const t of list) {
      const v = matchRecordings(want as never, t as never).verdict;
      if (v === 'same') return t;
      if (v === 'uncertain' && !uncertain) uncertain = t;
    }
  }
  return uncertain;
}

export async function resolveHits(
  hits: ((LyricHit | AudioHit) & { evidence: Evidence })[],
  searchers: Record<string, Searcher>,
  c: ProviderCtx,
  limit = 5,
): Promise<Identified> {
  const results: Dict[] = [];
  const seen = new Set<string>();
  let unplayable = 0;
  const found = await Promise.all(hits.slice(0, limit + 3).map((h) => playable(h as never, searchers, c)));
  hits.slice(0, limit + 3).forEach((h, i) => {
    const t = found[i];
    if (!t) {
      unplayable++;
      return;
    }
    if (seen.has(t['key'])) return;
    seen.add(t['key']);
    if (results.length < limit) results.push({ ...cleanTrack(t), also_on: t['also_on'] ?? [], evidence: h.evidence });
  });
  return { results, unplayable };
}
