/**
 * Genre/tag normalisation with a small documented hierarchy. TypeScript port of
 * server/airwave_discovery/genres.py. Tags keep provenance; unknown stays unknown: free-form text and
 * provider relatedness never become tags.
 */
import { fold } from './identity';

// alias -> canonical
const ALIASES: Record<string, string> = {
  'r b': 'r&b', rnb: 'r&b', 'r and b': 'r&b', 'rhythm and blues': 'r&b', 'contemporary r b': 'r&b',
  'hip hop': 'hip-hop', 'rap hip hop': 'hip-hop', rap: 'hip-hop', hiphop: 'hip-hop', 'hip hop rap': 'hip-hop', trap: 'trap',
  electro: 'electronic', electronica: 'electronic', edm: 'electronic', 'electronic dance music': 'electronic',
  dance: 'dance', 'dance pop': 'dance-pop',
  'soul funk': 'soul', 'soul and funk': 'soul', funk: 'funk',
  'latin music': 'latin', 'musica latina': 'latin', reggaeton: 'reggaeton',
  alternative: 'alternative', 'alternative rock': 'alternative', indie: 'indie', 'indie rock': 'indie', 'indie pop': 'indie-pop',
  'films games': 'soundtrack', 'film scores': 'soundtrack', soundtrack: 'soundtrack',
  'drum and bass': 'drum-and-bass', dnb: 'drum-and-bass', 'd b': 'drum-and-bass',
  'deep house': 'deep-house', 'tech house': 'tech-house', lofi: 'lo-fi', 'lo fi': 'lo-fi', 'lo fi hip hop': 'lo-fi',
  kpop: 'k-pop', 'k pop': 'k-pop', jpop: 'j-pop', 'j pop': 'j-pop',
  'heavy metal': 'metal', 'hard rock': 'rock', 'classic rock': 'rock',
  'singer songwriter': 'singer-songwriter', downtempo: 'downtempo', chillout: 'downtempo', ambient: 'ambient',
  afrobeats: 'afrobeats', 'african music': 'african', 'asian music': 'asian', 'brazilian music': 'brazilian',
};

// child -> parent
const PARENT: Record<string, string> = {
  trap: 'hip-hop', 'lo-fi': 'hip-hop',
  'dance-pop': 'pop', 'k-pop': 'pop', 'j-pop': 'pop', 'indie-pop': 'indie',
  house: 'electronic', 'deep-house': 'house', 'tech-house': 'house', techno: 'electronic',
  'drum-and-bass': 'electronic', dubstep: 'electronic', trance: 'electronic', downtempo: 'electronic',
  ambient: 'electronic', dance: 'electronic',
  reggaeton: 'latin', funk: 'soul', metal: 'rock', alternative: 'rock', indie: 'alternative',
  afrobeats: 'african', 'singer-songwriter': 'folk',
};

const KNOWN = new Set<string>([
  ...Object.values(ALIASES), ...Object.keys(PARENT), ...Object.values(PARENT),
  'pop', 'rock', 'jazz', 'classical', 'country', 'folk', 'blues', 'reggae', 'electronic', 'house', 'techno',
  'soul', 'r&b', 'hip-hop', 'latin', 'metal', 'punk', 'gospel', 'world', 'soundtrack', 'kids',
]);

const SCOPE_WEIGHT: Record<string, number> = { track: 1.0, album: 0.8, artist: 0.55 };

export interface Tag {
  name: string;
  label: string;
  source: string;
  scope: string;
  confidence: number;
  inferred: boolean;
}

export function normalize(name: string): string | null {
  const f = fold(name);
  if (!f || f.length > 40) return null;
  const canon = Object.prototype.hasOwnProperty.call(ALIASES, f) ? (ALIASES[f] ?? f) : f.replace(/ /g, '-');
  return KNOWN.has(canon) ? canon : null; // free-form uploader tags ("meh", "free download") are dropped
}

export function makeTag(name: string, source: string, scope: string, confidence: number): Tag | null {
  const canon = normalize(name);
  if (!canon) return null;
  return { name: canon, label: name, source, scope, confidence: Math.round(confidence * 100) / 100, inferred: false };
}

export function ancestors(g: string): string[] {
  const out: string[] = [];
  while (Object.prototype.hasOwnProperty.call(PARENT, g)) {
    g = PARENT[g] ?? g;
    out.push(g);
  }
  return out;
}

export function pairSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (ancestors(a).includes(b) || ancestors(b).includes(a)) return 0.6;
  const pa = PARENT[a] ?? null, pb = PARENT[b] ?? null;
  if (pa && pa === pb) return 0.4;
  return 0.0;
}

export function tagStrength(t: Tag): number {
  return (SCOPE_WEIGHT[t.scope ?? 'artist'] ?? 0.5) * (t.confidence ?? 0.5);
}

/** Best-match similarity weighted by tag strength; null when either side has no tags. */
export function similarity(tagsA: Tag[], tagsB: Tag[]): number | null {
  if (!tagsA.length || !tagsB.length) return null;
  let total = 0;
  let weight = 0;
  for (const ta of tagsA) {
    const sa = tagStrength(ta);
    const best = Math.max(...tagsB.map((tb) => pairSimilarity(ta.name, tb.name) * tagStrength(tb)));
    total += sa * best;
    weight += sa;
  }
  return weight ? Math.max(0, Math.min(1, total / weight)) : null;
}
