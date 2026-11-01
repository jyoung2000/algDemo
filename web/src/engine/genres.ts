/**
 * Genre/tag normalisation with a small documented hierarchy. TypeScript port of
 * server/airwave_discovery/genres.py. Tags keep provenance; unknown stays unknown: free-form text and
 * provider relatedness never become tags.
 */
import { fold } from './identity';

// alias -> canonical
const ALIASES: Record<string, string> = {
  'r b': 'r&b', rnb: 'r&b', 'r and b': 'r&b', 'rhythm and blues': 'r&b', 'contemporary r b': 'r&b', 'neo soul': 'neo-soul', neosoul: 'neo-soul', motown: 'soul',
  'hip hop': 'hip-hop', 'rap hip hop': 'hip-hop', rap: 'hip-hop', hiphop: 'hip-hop', 'hip hop rap': 'hip-hop', trap: 'trap',
  'boom bap': 'hip-hop', crunk: 'hip-hop', 'g funk': 'hip-hop', 'uk drill': 'drill', drill: 'drill', grime: 'grime', phonk: 'phonk',
  electro: 'electronic', electronica: 'electronic', edm: 'electronic', 'electronic dance music': 'electronic', idm: 'electronic',
  dance: 'dance', 'dance pop': 'dance-pop', eurodance: 'dance', disco: 'disco', 'nu disco': 'disco',
  synthpop: 'synth-pop', 'synth pop': 'synth-pop', electropop: 'synth-pop', 'electro pop': 'synth-pop',
  synthwave: 'synthwave', retrowave: 'synthwave', vaporwave: 'synthwave',
  'soul funk': 'soul', 'soul and funk': 'soul', funk: 'funk',
  'latin music': 'latin', 'musica latina': 'latin', reggaeton: 'reggaeton', salsa: 'latin', bachata: 'latin', cumbia: 'latin', 'regional mexican': 'latin', corridos: 'latin', banda: 'latin',
  alternative: 'alternative', 'alternative rock': 'alternative', 'alt rock': 'alternative', indie: 'indie', 'indie rock': 'indie', 'indie pop': 'indie-pop',
  'bedroom pop': 'indie-pop', 'dream pop': 'dream-pop', shoegaze: 'shoegaze', grunge: 'grunge', 'garage rock': 'rock', 'pop rock': 'rock', 'psychedelic rock': 'psychedelic', psychedelic: 'psychedelic',
  'films games': 'soundtrack', 'film scores': 'soundtrack', soundtrack: 'soundtrack',
  'drum and bass': 'drum-and-bass', dnb: 'drum-and-bass', 'd b': 'drum-and-bass', jungle: 'drum-and-bass', breakbeat: 'breakbeat', breaks: 'breakbeat',
  'deep house': 'deep-house', 'tech house': 'tech-house', 'house music': 'house', 'french house': 'house', 'filter house': 'house', 'progressive house': 'house', 'electro house': 'house', 'big room': 'house',
  'tropical house': 'tropical-house', 'future bass': 'future-bass', hardstyle: 'hardstyle', 'melodic techno': 'techno', 'minimal techno': 'techno',
  'uk garage': 'uk-garage', '2 step': 'uk-garage', 'trip hop': 'trip-hop', triphop: 'trip-hop',
  lofi: 'lo-fi', 'lo fi': 'lo-fi', 'lo fi hip hop': 'lo-fi',
  kpop: 'k-pop', 'k pop': 'k-pop', jpop: 'j-pop', 'j pop': 'j-pop', 'city pop': 'j-pop',
  'heavy metal': 'metal', 'hard rock': 'rock', 'classic rock': 'rock', 'pop punk': 'pop-punk', 'post punk': 'post-punk', emo: 'emo', 'hardcore punk': 'punk',
  'singer songwriter': 'singer-songwriter', downtempo: 'downtempo', chillout: 'downtempo', ambient: 'ambient', 'new age': 'ambient',
  afrobeats: 'afrobeats', afrobeat: 'african', amapiano: 'amapiano', 'african music': 'african', 'asian music': 'asian',
  'brazilian music': 'brazilian', 'bossa nova': 'brazilian', mpb: 'brazilian', samba: 'brazilian',
  ska: 'ska', dancehall: 'dancehall', dub: 'dub',
  opera: 'classical', orchestral: 'classical', baroque: 'classical', bluegrass: 'country', americana: 'folk', 'folk rock': 'folk',
  'smooth jazz': 'jazz', bebop: 'jazz', swing: 'jazz',
  christian: 'gospel', worship: 'gospel', 'children s music': 'kids', children: 'kids',
  hyperpop: 'hyperpop',
};

// child -> parent
const PARENT: Record<string, string> = {
  trap: 'hip-hop', 'lo-fi': 'hip-hop', drill: 'hip-hop', grime: 'hip-hop', phonk: 'hip-hop',
  'dance-pop': 'pop', 'k-pop': 'pop', 'j-pop': 'pop', 'indie-pop': 'indie', 'synth-pop': 'pop', hyperpop: 'pop', 'dream-pop': 'indie-pop',
  house: 'electronic', 'deep-house': 'house', 'tech-house': 'house', 'tropical-house': 'house', techno: 'electronic',
  'drum-and-bass': 'electronic', dubstep: 'electronic', trance: 'electronic', downtempo: 'electronic',
  ambient: 'electronic', dance: 'electronic', disco: 'dance', synthwave: 'electronic', breakbeat: 'electronic',
  'future-bass': 'electronic', hardstyle: 'electronic', 'uk-garage': 'electronic', 'trip-hop': 'downtempo',
  reggaeton: 'latin', funk: 'soul', 'neo-soul': 'soul', metal: 'rock', alternative: 'rock', indie: 'alternative',
  shoegaze: 'alternative', grunge: 'rock', psychedelic: 'rock', punk: 'rock', 'pop-punk': 'punk', 'post-punk': 'punk', emo: 'punk',
  afrobeats: 'african', amapiano: 'african', 'singer-songwriter': 'folk',
  ska: 'reggae', dancehall: 'reggae', dub: 'reggae',
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
