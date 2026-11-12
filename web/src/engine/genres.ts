/**
 * Genre/tag normalisation with a small documented hierarchy. TypeScript port of
 * server/airwave_discovery/genres.py. Tags keep provenance; unknown stays unknown: free-form text and
 * provider relatedness never become tags.
 */
import { fold } from './identity';
import { SUBS } from './genre-table';

// alias -> canonical
const ALIASES: Record<string, string> = {
  'r b': 'r&b', rnb: 'r&b', 'r and b': 'r&b', 'rhythm and blues': 'r&b', 'contemporary r b': 'r&b', 'contemporary r and b': 'r&b', 'r and b soul': 'r&b', 'neo soul': 'neo-soul', neosoul: 'neo-soul', motown: 'soul',
  'hip hop': 'hip-hop', 'rap hip hop': 'hip-hop', rap: 'hip-hop', hiphop: 'hip-hop', 'hip hop rap': 'hip-hop', trap: 'trap',
  'boom bap': 'hip-hop', crunk: 'hip-hop', 'g funk': 'hip-hop', 'uk drill': 'drill', drill: 'drill', grime: 'grime', phonk: 'phonk',
  // ALBUM-GENRE-DETAIL-001: both describe a manner, not a scene, and MusicBrainz puts them on
  // records from every city. They name the family and stop there, rather than borrowing West Coast
  // or conscious rap from a neighbouring cell.
  'gangsta rap': 'hip-hop', gangsta: 'hip-hop', 'hardcore hip hop': 'hip-hop', 'hardcore rap': 'hip-hop',
  'chicago drill': 'hip-hop', 'industrial hip hop': 'hip-hop',
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
  // GENRE-CLASS-001: SoundCloud's own genre menu joins two genres with '&' (fold reads it as 'and'),
  // and these were dropped. Each names its first genre's family.
  'hip hop and rap': 'hip-hop', 'r and b and soul': 'r&b', 'dance and edm': 'electronic', 'jazz and blues': 'jazz',
  'folk and singer songwriter': 'folk', 'drum and bass and jungle': 'drum-and-bass', 'electronic and dance': 'electronic',
  // Common genre words the services and MusicBrainz send that had no place.
  'new jack swing': 'r&b', 'quiet storm': 'r&b', 'p funk': 'funk', 'acid jazz': 'jazz', 'jazz fusion': 'jazz', 'delta blues': 'blues',
  'black metal': 'metal', 'death metal': 'metal', 'doom metal': 'metal', 'thrash metal': 'metal', 'power metal': 'metal', 'stoner rock': 'rock',
  'post rock': 'post-rock', 'progressive rock': 'rock', 'prog rock': 'rock', 'surf rock': 'rock', 'punk rock': 'punk',
  'noise rock': 'alternative', 'art rock': 'alternative', 'soft rock': 'rock', 'glam rock': 'rock', 'blues rock': 'rock',
  psytrance: 'trance', 'psy trance': 'trance', 'progressive trance': 'trance', 'hard dance': 'electronic', gabber: 'hardstyle', 'hardcore techno': 'hardstyle',
  minimal: 'techno', 'acid house': 'house', 'bass house': 'house', 'future house': 'house', 'afro tech': 'house', glitch: 'electronic', breakcore: 'drum-and-bass',
  neurofunk: 'drum-and-bass', darkwave: 'synth-pop', 'witch house': 'electronic', 'electro swing': 'electronic', chiptune: 'electronic',
  'teen pop': 'pop', 'europop': 'pop', 'latin pop': 'latin', 'mandopop': 'pop', 'c pop': 'pop', 'chamber pop': 'indie-pop', 'baroque pop': 'indie-pop',
  dembow: 'reggaeton', 'corridos tumbados': 'latin', merengue: 'latin', tango: 'latin', 'latin urbano': 'reggaeton', 'musica mexicana': 'latin',
  'roots reggae': 'reggae', 'lovers rock': 'reggae', soca: 'dancehall', calypso: 'reggae', zouk: 'african', highlife: 'african', alte: 'afrobeats',
  horrorcore: 'hip-hop', lounge: 'lounge', 'video game music': 'soundtrack', 'game soundtrack': 'soundtrack', 'film score': 'soundtrack', score: 'soundtrack', 'contemporary classical': 'classical',
  'contemporary christian': 'gospel', ccm: 'gospel', 'christian hip hop': 'hip-hop', blues: 'blues', 'country rock': 'country', 'alt country': 'country', 'outlaw country': 'country',
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
  // GENRE-CLASS-001: families for genres that had none, so the taste map can place them.
  gospel: 'soul', blues: 'jazz', 'post-rock': 'alternative', soundtrack: 'classical', lounge: 'downtempo',
};

const KNOWN = new Set<string>([
  ...Object.values(ALIASES), ...Object.keys(PARENT), ...Object.values(PARENT),
  'pop', 'rock', 'jazz', 'classical', 'country', 'folk', 'blues', 'reggae', 'electronic', 'house', 'techno',
  'soul', 'r&b', 'hip-hop', 'latin', 'metal', 'punk', 'gospel', 'world', 'soundtrack', 'kids',
]);

// Hip-hop subgenres (genre-table.ts) are real tags. Their words used to collapse into plain 'hip-hop'
// ('boom bap', 'crunk', 'g funk') or be dropped, which is why every rap song read "General hip-hop".
// Only the hip-hop family is taken from the table: other families keep their existing names, so their
// tags, taste and golden results do not move. 'soundcloud' is a platform, not a sound.
const NOT_A_GENRE = new Set(['soundcloud']);
const HIPHOP_SUB = new Map<string, string>();
for (const s of SUBS) {
  if (s.family !== 'hip-hop') continue;
  KNOWN.add(s.key);
  if (!Object.prototype.hasOwnProperty.call(PARENT, s.key)) PARENT[s.key] = 'hip-hop';
  for (const a of [s.key, s.name, ...s.aliases]) {
    const k = fold(a);
    if (k && !NOT_A_GENRE.has(k) && !HIPHOP_SUB.has(k)) HIPHOP_SUB.set(k, s.key);
  }
}

/**
 * GENRE-CLASS-001: the other families' picker subgenres. A word that already had a canonical genre keeps
 * it (so stored tags, taste and the golden results do not move); a word that was dropped now becomes a
 * real tag. The tag is the existing canonical one of the same subgenre when there is one ('80s' and 'new
 * wave' join 'synth-pop'), otherwise the subgenre's own key ('slowcore', 'alt-rnb', 'afro-house'), with a
 * parent so it counts toward its family in every comparison.
 */
const SUB_PARENT: Record<string, string> = {
  'nu-metal': 'metal', djent: 'metal', metalcore: 'metal', 'midwest-emo': 'emo', 'pop-punk': 'punk', 'hardcore-punk': 'punk', 'post-punk': 'punk',
  'indie-sleaze': 'alternative', slowcore: 'alternative',
  'alt-pop': 'pop', 'bedroom-pop': 'indie-pop', 'country-pop': 'country', digicore: 'hyperpop', 'pop-rap': 'hip-hop',
  'indie-folk': 'folk', 'art-pop': 'indie', 'slacker-rock': 'indie', 'garage-psych': 'psychedelic', 'jangle-pop': 'indie-pop', 'math-rock': 'indie', indietronica: 'indie',
  'nu-jazz': 'jazz', 'spiritual-jazz': 'jazz', 'jazz-funk': 'funk', boogie: 'funk', 'retro-soul': 'soul', 'nu-disco': 'disco', 'soul-pop': 'soul', bruk: 'jazz', 'uk-soul': 'soul',
  'melodic-techno': 'techno', 'hard-techno': 'techno', hypertechno: 'techno', 'slap-house': 'house', 'trap-edm': 'electronic', 'liquid-dnb': 'drum-and-bass',
  neoclassical: 'classical', 'organic-house': 'house', 'dub-techno': 'techno', 'future-garage': 'uk-garage', chillstep: 'dubstep', vaporwave: 'synthwave',
  'alt-rnb': 'r&b', trapsoul: 'r&b', afroswing: 'afrobeats', moombahton: 'reggaeton', 'afro-house': 'african', gqom: 'african', 'baile-funk': 'brazilian', 'latin-trap': 'reggaeton',
};
const FAMILY_WORD: Record<string, string> = {
  rock: 'rock', pop: 'pop', indie: 'indie', 'soul-jazz-funk': 'soul', electronic: 'electronic', 'ambient-chill': 'ambient', 'rnb-afro-latin': 'r&b',
};
const SUB_WORD = new Map<string, string>();
{
  const before = (w: string): string | null => {
    const f = fold(w);
    if (!f || f.length > 40) return null;
    if (HIPHOP_SUB.has(f)) return HIPHOP_SUB.get(f)!;
    const canon = Object.prototype.hasOwnProperty.call(ALIASES, f) ? (ALIASES[f] ?? f) : f.replace(/ /g, '-');
    return KNOWN.has(canon) ? canon : null;
  };
  for (const s of SUBS) {
    if (s.family === 'hip-hop') continue;
    const words = [s.key, s.name, ...s.aliases];
    const existing = words.map(before).find((c): c is string => c !== null);
    const canon = existing ?? s.key;
    if (!existing) {
      KNOWN.add(s.key);
      if (!Object.prototype.hasOwnProperty.call(PARENT, s.key)) PARENT[s.key] = SUB_PARENT[s.key] ?? FAMILY_WORD[s.family] ?? s.family;
    }
    for (const a of words) {
      const k = fold(a);
      if (k && before(a) === null && !SUB_WORD.has(k)) SUB_WORD.set(k, canon);
    }
  }
}

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
  const sub = HIPHOP_SUB.get(f);
  if (sub) return sub;
  const other = SUB_WORD.get(f);
  if (other) return other;
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
