/**
 * NEXT-FAV-COLD-001 (owner, 2026-11-23): "the find my new favorite button should work without a starting song and
 * with no songs in queue. It should use the users listening algorithm, taste map, and favorite artist to find music
 * the user would like".
 *
 * With no starting song and an empty queue, a run still has three things to go on, and this picks the artists it
 * starts from out of them:
 *   1. the starred artists (ARTIST-FAV-001) — the listener said these outright, so they come first;
 *   2. what the listening algorithm has learned — the artists of the songs liked, saved, replayed or played to the
 *      end, weighted by how strong the judgement was and how recent it is;
 *   3. the taste map's colours (COLOR-DISCOVERY-001) — each colour names reference artists, and the strongest
 *      colours fill any room left, so a listener whose history is thin still starts somewhere true to their sound.
 *
 * The result is run-only: these are never written into the listener's starting songs or their starred artists. The
 * taste map also keeps its usual jobs — it scores the candidates and asks for music of its own during gathering.
 */
import { fold } from './identity';
import { colourArtists, type Colour } from './taste-gather';

type Dict = Record<string, unknown>;

/** One artist a seedless run starts from, and why it was picked (shown in the run's reason). */
export interface ColdStarter {
  name: string;
  from: 'starred' | 'listening' | 'taste';
}

export interface ColdRow {
  kind: string;
  ts: number;
  track?: Dict | null;
}

/** How much each kind of event says the listener likes that artist. Everything else says nothing. */
const WEIGHT: Record<string, number> = { like: 6, save: 6, replay: 4, complete: 2, qualified: 1 };
/** A judgement from the last fortnight counts double; older ones fade to a third over a year. */
const HALF_LIFE_DAYS = 45;

const artistsOf = (track: Dict | null | undefined): string[] => {
  if (!track) return [];
  const list = Array.isArray(track['artists']) ? (track['artists'] as unknown[]) : [];
  const names = list.filter((a): a is string => typeof a === 'string' && a.trim().length > 0);
  if (names.length) return names.slice(0, 3);
  const one = track['artist'];
  return typeof one === 'string' && one.trim() ? [one] : [];
};

/**
 * The artists the listening algorithm has learned to like, strongest first. [] when nothing has been
 * judged yet — a fresh install has no listening to read.
 */
export function listeningArtists(rows: readonly ColdRow[], now: number, want = 6): string[] {
  const score = new Map<string, { name: string; score: number; last: number }>();
  for (const r of rows) {
    const w = WEIGHT[r.kind];
    if (!w) continue;
    const ageDays = Math.max(0, (now - r.ts) / 86400);
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    for (const name of artistsOf(r.track)) {
      const key = fold(name);
      if (!key) continue;
      const at = score.get(key) ?? { name, score: 0, last: 0 };
      at.score += w * recency;
      at.last = Math.max(at.last, r.ts);
      score.set(key, at);
    }
  }
  return [...score.values()]
    .sort((a, b) => b.score - a.score || b.last - a.last)
    .slice(0, Math.max(0, want))
    .map((a) => a.name);
}

/** Reference artists of the strongest colours, strongest colour first, never repeating a name. */
export function tasteArtists(colours: readonly Colour[], want = 6, cursor = 0): string[] {
  const strong = [...colours].filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
  const out: string[] = [];
  const seen = new Set<string>();
  // One name per colour per lap, so the strongest colour leads but no single colour fills the run.
  for (let lap = 0; out.length < want && lap < 4; lap++) {
    for (const c of strong) {
      if (out.length >= want) break;
      const pool = colourArtists(c.name);
      if (!pool.length) continue;
      const name = pool[(Math.trunc(cursor) + lap) % pool.length] as string;
      if (seen.has(fold(name))) continue;
      seen.add(fold(name));
      out.push(name);
    }
  }
  return out;
}

/**
 * The artists a run with no starting song begins from: the listener's stars, then what their listening
 * says, then their taste map's colours — each source only filling what the one before left.
 */
export function coldStarters(
  input: { starred: readonly string[]; rows: readonly ColdRow[]; colours: readonly Colour[]; now: number; cursor?: number },
  want = 6,
): ColdStarter[] {
  const out: ColdStarter[] = [];
  const seen = new Set<string>();
  const take = (name: string, from: ColdStarter['from']) => {
    const key = fold(name);
    if (!key || seen.has(key) || out.length >= want) return;
    seen.add(key);
    out.push({ name, from });
  };
  for (const s of input.starred) take(s, 'starred');
  for (const a of listeningArtists(input.rows, input.now, want)) take(a, 'listening');
  for (const a of tasteArtists(input.colours, want, input.cursor ?? 0)) take(a, 'taste');
  return out;
}

/** What the run says it started from, for the listener. */
export function coldReason(starters: readonly ColdStarter[]): string {
  if (!starters.length) return '';
  const names = starters.slice(0, 3).map((s) => s.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const kinds = new Set(starters.map((s) => s.from));
  const where = kinds.has('starred')
    ? kinds.size > 1 ? 'your starred artists and your listening' : 'your starred artists'
    : kinds.has('listening')
      ? kinds.has('taste') ? 'your listening and your sound' : 'your listening'
      : 'your sound';
  return `Started from ${where}: ${list}.`;
}
