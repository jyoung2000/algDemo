/**
 * What one genre IS, however a provider spells it (TAGS-CANON-001).
 *
 * Providers name the same genre many ways: Deezer says "R&B", YouTube Music "r&b", Last.fm "rnb".
 * Each card used to show the provider's own spelling and colour a bubble by looking that spelling
 * up, so "rnb", "R&B" and "r&b" were three bubbles, and a spelling the lookup missed fell back to
 * the song's own colour (every bubble on a pop song came out pop-green). Here every word resolves to
 * one identity: a key that two spellings of one genre share, one name in one case, and the colour
 * the Taste Picker paints that genre (its family's band, shaded for a subgenre). A word the picker
 * has no place for has no identity, and gets no bubble.
 */
import { classify } from './classify';
import { FAMILIES, FAMILY_TAGS, SUBS, type SubDef } from './genre-table';
import { normalize, type Tag } from './genres';
import { fold } from './identity';

export interface GenreIdentity {
  /** Shared by every spelling of the genre: 'genre:r&b', 'sub:nu-disco', 'family:rnb-afro-latin'. */
  key: string;
  /** The one name shown for it, e.g. 'R&B', 'Hip-hop', 'Nu-disco'. */
  label: string;
  /** The Taste Picker's colour for it. */
  color: string;
  /** A picker subgenre rather than a main genre. */
  sub: boolean;
  /** The picker family it belongs to, e.g. 'rnb-afro-latin'. */
  family: string;
}

/** The slash-free name a picker subgenre goes by on a bubble: "Nu-disco / disco revival" is "Nu-disco". */
export function subShortName(s: SubDef): string {
  return s.short ?? s.name.replace(/\s*\(.*?\)\s*/g, ' ').split(/\s*\/\s*/)[0]!.trim();
}

const SUB_BY_NAME = new Map(SUBS.map((s) => [s.name, s] as const));
const SUB_BY_SHORT = new Map(SUBS.map((s) => [fold(subShortName(s)), s] as const));
const FAMILY_BY_NAME = new Map(FAMILIES.map((f) => [f.name, f] as const));

/** Names whose case is not just "capitalise the first letter". */
const DISPLAY: Record<string, string> = {
  'r&b': 'R&B',
  'hip-hop': 'Hip-hop',
  'k-pop': 'K-pop',
  'j-pop': 'J-pop',
  'drum-and-bass': 'Drum & bass',
  'uk-garage': 'UK garage',
};

const display = (canon: string) => DISPLAY[canon] ?? canon.charAt(0).toUpperCase() + canon.slice(1);
const tag = (name: string, label: string) => [{ name, label, confidence: 1 }] as unknown as Tag[];

function ofSub(s: SubDef): GenreIdentity | null {
  const c = classify(tag(s.key, s.name), null);
  if (!c) return null;
  return { key: `sub:${s.key}`, label: subShortName(s), color: c.color, sub: true, family: s.family };
}

/** The identity of a genre word as a provider writes it, or null when the picker has no place for it. */
export function genreIdentity(word: string): GenreIdentity | null {
  const f = fold(word);
  if (!f) return null;
  // A bubble's own short name leads back to its subgenre ("Garage rock", not UK garage's "garage").
  const short = SUB_BY_SHORT.get(f);
  if (short) return ofSub(short);
  const canon = normalize(word) ?? f;
  const c = classify(tag(canon, word), null);
  if (!c) return null;
  if (c.subgenre) {
    const s = SUB_BY_NAME.get(c.subgenre);
    return s ? ofSub(s) : null;
  }
  // "Rap" and "Hip Hop" are one genre (one key); the listener's own word for it is kept.
  const label = f === 'rap' ? 'Rap' : display(canon);
  return { key: `genre:${canon}`, label, color: c.color, sub: false, family: c.familySlug };
}

/** A picker subgenre by its full picker name ("Nu-disco / disco revival"). */
export function subIdentity(name: string): GenreIdentity | null {
  const s = SUB_BY_NAME.get(name);
  return s ? ofSub(s) : genreIdentity(name);
}

/** A picker family by its name ("R&B/Afro/Latin"), shown by its first genre ("R&B"). */
export function familyIdentity(name: string): GenreIdentity | null {
  const fam = FAMILY_BY_NAME.get(name);
  if (!fam) return genreIdentity(name);
  const first = name.split(/\s*\/\s*/)[0]!.trim();
  const own = genreIdentity(first);
  if (own && !own.sub && own.family === fam.slug) return own;
  // The first word is also one of the family's subgenres ("Ambient"): show the family, in its band colour.
  const color = FAMILY_COLOR.get(fam.slug) ?? own?.color;
  return color ? { key: `family:${fam.slug}`, label: first, color, sub: false, family: fam.slug } : null;
}

/**
 * A family's own band colour, read from one of its plain genre words ('r&b' for R&B/Afro/Latin).
 * classify() reads genre words, not family slugs: asking it for 'rnb-afro-latin' answers nothing,
 * which is how R&B bubbles lost their colour.
 */
const FAMILY_COLOR = new Map<string, string>();
for (const [word, slug] of Object.entries(FAMILY_TAGS)) {
  if (FAMILY_COLOR.has(slug)) continue;
  const c = classify(tag(word, word), null);
  if (c && !c.subgenre && c.familySlug === slug) FAMILY_COLOR.set(slug, c.color);
}
