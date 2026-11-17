/**
 * GENRE-ALL-001 — owner: "all songs need to have genres and sub genre tags".
 *
 * Two things kept a row from showing a main genre and a subgenre:
 *
 *  1. The services often DO name a subgenre ("sophisti-pop", "smooth jazz", "contemporary R&B",
 *     "new jack swing"), but every word the Taste Picker has no cell for was thrown away. Such a
 *     word is a STYLE here: a genre word with something said about it. It is shown as it was said.
 *  2. For many songs no service names one at all (MusicBrainz has no tags for the artist, Deezer
 *     states one word for the album). Then the gap is filled from what IS known, each fill carrying
 *     where it came from: the song's era (a fact), or an estimate from the artist's other songs or
 *     from the songs around it. An estimate is marked `guess`, so the row can show it as one and
 *     never passes it off as the service's word.
 *
 * Nothing is invented when nothing is known: a song with no evidence in an empty list stays bare.
 * Pure, so every rule is tested without a network.
 */
import { classifyAll, familyOfGenre } from './classify';
import { FAMILIES } from './genre-table';
import { genreIdentity } from './genre-identity';
import { normalize, type Tag } from './genres';
import { fold } from './identity';
import type { Dict } from './shape';

export interface Fill {
  label: string;
  /** A subgenre rather than a main genre. */
  sub: boolean;
  /** An estimate of ours, not a fact and not a service's word. */
  guess: boolean;
  /** Where it came from, in words the row can show. */
  why: string;
}

/** Whole phrases that are only another way of writing one plain genre (the alias table's synonyms). */
const SAME = new Set(['rhythm and blues', 'soul funk', 'rnb soul', 'electronic dance music', 'lo fi hiphop', 'children s music'].map((w) => fold(w)));
/** Words in a tag that say nothing about the music. */
const FILLER = new Set(['music', 'musica', 'and', 'the', 'n', 'of']);
const NOT_MUSIC = new Set([
  'american', 'british', 'english', 'usa', 'us', 'canadian', 'australian', 'german', 'french', 'swedish', 'irish', 'scottish',
  'male', 'female', 'vocal', 'vocals', 'vocalist', 'vocalists', 'singer', 'singers', 'artist', 'artists', 'band', 'bands', 'group', 'girl', 'boy',
  'songs', 'best', 'favorite', 'favourite', 'favorites', 'favourites', 'my', 'good', 'great', 'seen', 'live', 'general', 'other', 'various',
  'top', 'hits', 'charts', 'billboard', 'grammy', 'awards', 'winner', 'hall', 'fame',
]);
/** Well-known styles whose name holds no genre word, and the genre each belongs to (null: none the picker has). */
const NAMED: Record<string, string | null> = {
  'new jack swing': 'r&b', 'quiet storm': 'r&b', motown: 'soul', 'doo wop': 'soul', britpop: 'pop', krautrock: 'rock',
  'yacht rock': 'rock', bhangra: null, bollywood: null,
};

interface Parsed {
  /** The canonical genre the style belongs to, when it names one. */
  core: string | null;
}

function parse(word: string): Parsed | null {
  const raw = (word ?? '').toLowerCase().trim();
  if (!raw || raw.length > 40) return null;
  const pre = raw.replace(/\br\s*(?:&|'?n'?|and)\s*b\b/g, 'rnb').replace(/hip[\s-]?hop/g, 'hiphop');
  // "Rap/Hip Hop", "Soul & Funk", "singer/songwriter": a list of genres, not a style of one.
  if (/[&/,+;]/.test(pre)) return null;
  const f = fold(pre);
  if (Object.prototype.hasOwnProperty.call(NAMED, f)) return { core: NAMED[f] ?? null };
  const toks = f.split(' ').filter(Boolean);
  if (!toks.length || toks.length > 3 || SAME.has(f)) return null;
  // A picker subgenre has a bubble of its own; a word that IS a canonical genre's name is that genre.
  if (genreIdentity(word)?.sub) return null;
  const canon = normalize(word);
  if (canon && fold(canon) === fold(raw)) return null;
  const cores = toks.map((t) => normalize(t)).filter((c): c is string => c !== null);
  if (!cores.length) return null;
  // "Jazz and blues", "dance and EDM": two genres joined, which is a list however it is punctuated.
  if (toks.includes('and') && new Set(cores).size > 1) return null;
  const said = toks.filter((t) => normalize(t) === null && !FILLER.has(t) && !NOT_MUSIC.has(t) && !/^\d+s?$/.test(t));
  // Something said about the genre ("smooth" jazz), or two genres fused ("pop rock").
  if (!said.length && new Set(cores).size < 2) return null;
  return { core: cores[cores.length - 1]! };
}

/** Whether a word a service used names a style: a genre with something said about it. */
export function isStyleWord(word: string): boolean {
  return parse(word) !== null;
}

/** The canonical genre a style belongs to ('smooth jazz' -> 'jazz'), or null. */
export function styleCore(word: string): string | null {
  return parse(word)?.core ?? null;
}

/** The picker family a style or an off-picker genre falls in, or null when the picker has none for it. */
export function styleFamily(word: string): string | null {
  const core = parse(word)?.core ?? normalize(word);
  return core ? familyOfGenre(core) : null;
}

/** One case for every style: "Contemporary R&B", "Sophisti-pop", "UK hard house". */
export function styleLabel(word: string): string {
  const s = (word ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    .replace(/\br\s*(?:&|'?n'?|and)\s*b\b|\brnb\b/g, 'R&B').replace(/\buk\b/g, 'UK').replace(/\bedm\b/g, 'EDM');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The style words MusicBrainz's listeners use for exactly this artist, most-voted first. The same
 * trust rule as subsFromArtist: only an exact, top-scoring name match.
 */
export function stylesFromArtist(body: Dict, artist: string, max = 2): string[] {
  const hit = ((body?.['artists'] as Dict[] | undefined) ?? [])[0];
  if (!hit || Number(hit['score'] ?? 0) < 95 || fold(String(hit['name'] ?? '')) !== fold(artist)) return [];
  const seen = new Set<string>();
  return ((hit['tags'] as Dict[] | undefined) ?? [])
    .filter((t) => Number(t['count'] ?? 0) > 0)
    .map((t, i) => ({ name: String(t['name'] ?? ''), count: Number(t['count']), i }))
    .sort((a, b) => b.count - a.count || a.i - b.i)
    .map((t) => t.name)
    .filter((n) => isStyleWord(n) && !seen.has(fold(n)) && (seen.add(fold(n)), true))
    .slice(0, max);
}

/** Style words a service wrote on the song itself: a tag whose own word says more than the genre it was filed under. */
export function stylesOfTags(tags: readonly Tag[] | null | undefined): string[] {
  const seen = new Set<string>();
  return (tags ?? [])
    .filter((t) => t && !t.inferred && typeof t.label === 'string' && isStyleWord(t.label))
    .map((t) => t.label)
    .filter((n) => !seen.has(fold(n)) && (seen.add(fold(n)), true));
}

/**
 * The styles shown on one song: its own, then its artist's that fall in the song's own genre (an
 * artist's "jazz pop" is not lent to a song filed under jazz). Two at most, each once, in one case.
 */
export function stylesFor(tags: readonly Tag[] | null | undefined, artistStyles: readonly string[] | null | undefined, max = 2): string[] {
  const main = mainGenre(tags);
  const lent = (artistStyles ?? []).filter((w) => isStyleWord(w) && (!main?.family || styleFamily(w) === main.family));
  const seen = new Set<string>(main ? [fold(main.label)] : []);
  return [...stylesOfTags(tags), ...lent].filter((w) => !seen.has(fold(w)) && (seen.add(fold(w)), true)).slice(0, max).map(styleLabel);
}

const byStrength = (tags: readonly Tag[]): Tag[] => [...tags].filter((t) => t && typeof t.name === 'string').sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
/** A word's identity never changes, and a long queue asks for the same few words on every poll. */
const SEEN_ID = new Map<string, ReturnType<typeof genreIdentity>>();
function identityOf(t: Tag): ReturnType<typeof genreIdentity> {
  const k = `${t.label ?? ''}\n${t.name}`;
  let id = SEEN_ID.get(k);
  if (id === undefined) {
    // As the row's bubble reads it: the first genre a joined label names ("Rap/Hip Hop" is "Rap").
    const first = (t.label ?? '').split(/\s*[/\u00b7,]\s*/).map((w) => genreIdentity(w.trim())).find((x) => x !== null);
    id = first ?? genreIdentity(t.label ?? '') ?? genreIdentity(t.name);
    if (SEEN_ID.size < 4000) SEEN_ID.set(k, id);
  }
  return id;
}
const FAMILY_NAME = new Map(FAMILIES.map((f) => [f.slug, f.name.split(/\s*\/\s*/)[0]!.trim()] as const));

export interface MainGenre {
  /** Shared by every spelling of the genre, so "Rap" and "hip hop" count as one. */
  key: string;
  label: string;
  /** Its picker family, or null when the picker has no place for it. */
  family: string | null;
  onPicker: boolean;
}

/**
 * The main genre a song's tags name: a genre the picker places, else the family of a subgenre it
 * places, else a genre a service named that the picker has no place for ("Asian music").
 */
export function mainGenre(tags: readonly Tag[] | null | undefined): MainGenre | null {
  const tg = byStrength(tags ?? []);
  const ids = tg.map(identityOf).filter((x): x is NonNullable<typeof x> => x !== null);
  const plain = ids.find((id) => !id.sub);
  if (plain) return { key: plain.key, label: plain.label, family: plain.family, onPicker: true };
  const sub = ids[0];
  if (sub) return { key: `family:${sub.family}`, label: FAMILY_NAME.get(sub.family) ?? sub.label, family: sub.family, onPicker: true };
  const off = tg.find((t) => !t.inferred && !identityOf(t));
  if (!off) return null;
  const label = styleLabel(off.label || off.name);
  return { key: `off:${label.toLowerCase()}`, label, family: null, onPicker: false };
}

/** The picker subgenres a song's tags name, as their bubble names. */
export function subLabels(tags: readonly Tag[] | null | undefined, bpm: number | null = null): string[] {
  const tg = byStrength(tags ?? []);
  const out = new Set<string>();
  for (const id of tg.map(identityOf)) if (id?.sub) out.add(id.label);
  for (const c of classifyAll(tg, bpm)) if (c.subgenre) out.add(genreIdentity(c.key ?? '')?.label ?? c.subgenre);
  return [...out];
}

const KEEP_CASE = /^(R&B|UK |EDM|[A-Z]-|Asian|Indian|African|Brazilian|Latin)/;
const lower = (label: string): string => (KEEP_CASE.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

/** "80s pop", "90s R&B", "2010s hip-hop": the decade a song came out in, and its genre. */
export function eraLabel(main: string, year: number): string {
  const decade = Math.floor(year / 10) * 10;
  const d = decade >= 1940 && decade < 2000 ? `${String(decade).slice(2)}s` : `${decade}s`;
  return `${d} ${lower(main)}`;
}

export interface FillInput {
  tags: readonly Tag[];
  /** Style words already found for the song (its own and its artist's). */
  styles: readonly string[];
  year: number | null;
  /** The year of a same-named song by the artist that could not be proved to be this recording. */
  yearHint?: number | null;
  bpm?: number | null;
  artist: string;
  /** What each artist's other songs were tagged, by weight (the store's `artist_genres`). */
  artistGenres?: Record<string, Record<string, number>>;
  /** The songs around it: the queue and its starting songs. */
  list: readonly { tags: readonly Tag[]; styles: readonly string[]; year?: number | null }[];
}

const ARTIST_WHY = 'The artist\u2019s other songs';
const validYear = (y: number | null | undefined): y is number => typeof y === 'number' && y > 1900 && y < 2100;

interface ListSummary {
  mains: MainGenre[];
  /** For each main genre, how many of its songs carry each subgenre or style. */
  subs: Map<string, Map<string, number>>;
  /** How many of the list's songs came out in each decade, and how many have a known year. */
  decades: Map<number, number>;
  dated: number;
}
const SUMMARY = new WeakMap<object, ListSummary>();
/** What the songs around a row say, read once per list however many rows ask. */
function summary(list: FillInput['list']): ListSummary {
  const hit = SUMMARY.get(list);
  if (hit) return hit;
  const out: ListSummary = { mains: [], subs: new Map(), decades: new Map(), dated: 0 };
  for (const o of list) {
    if (validYear(o.year)) {
      const d = Math.floor(o.year / 10) * 10;
      out.decades.set(d, (out.decades.get(d) ?? 0) + 1);
      out.dated += 1;
    }
    const tags = real(o.tags);
    const m = mainGenre(tags);
    if (!m) continue;
    out.mains.push(m);
    const counts = out.subs.get(m.key) ?? new Map<string, number>();
    for (const l of [...subLabels(tags), ...o.styles]) counts.set(l, (counts.get(l) ?? 0) + 1);
    out.subs.set(m.key, counts);
  }
  SUMMARY.set(list, out);
  return out;
}
const real = (tags: readonly Tag[]): Tag[] => tags.filter((t) => t && !t.inferred);
const top = <K>(counts: Map<K, number>): [K, number] | null => [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;

/**
 * What a song still lacks of "a main genre and a subgenre", filled from what is known. Strongest
 * first for each: the artist's other songs, then (for a subgenre) the song's own era, then the
 * subgenre and last the era of the songs around it. Returns nothing when the song already has both, or when nothing is known.
 */
export function fillGenres(x: FillInput): Fill[] {
  const out: Fill[] = [];
  const row = Object.entries(x.artistGenres?.[x.artist.toLowerCase().trim()] ?? {}).filter(([, w]) => w >= 0.5).sort((a, b) => b[1] - a[1]);
  let main = mainGenre(x.tags);
  if (!main) {
    let why = ARTIST_WHY;
    const fromArtist = row.map(([name]) => genreIdentity(name)).find((id) => id !== null);
    let got: MainGenre | null = fromArtist
      ? { key: fromArtist.sub ? `family:${fromArtist.family}` : fromArtist.key, label: fromArtist.sub ? (FAMILY_NAME.get(fromArtist.family) ?? fromArtist.label) : fromArtist.label, family: fromArtist.family, onPicker: true }
      : null;
    if (!got) {
      const { mains } = summary(x.list);
      const counts = new Map<string, number>();
      for (const m of mains) counts.set(m.key, (counts.get(m.key) ?? 0) + 1);
      const best = top(counts);
      if (best) {
        got = mains.find((m) => m.key === best[0])!;
        why = best[1] * 2 > mains.length ? 'Most songs in this list' : 'Other songs in this list';
      }
    }
    if (!got) return out;
    main = got;
    out.push({ label: main.label, sub: false, guess: true, why });
  }
  if (subLabels(x.tags, x.bpm ?? null).length || x.styles.length) return out;
  const sub = (label: string, guess: boolean, why: string): Fill[] => [...out, { label, sub: true, guess, why }];
  const own = row.map(([name]) => genreIdentity(name)).find((id) => id?.sub && (!main!.family || id.family === main!.family));
  if (own) return sub(own.label, true, ARTIST_WHY);
  if (validYear(x.year)) return sub(eraLabel(main.label, x.year), false, `Released in ${x.year}`);
  if (validYear(x.yearHint)) return sub(eraLabel(main.label, x.yearHint), true, `A song of this name by the artist came out in ${x.yearHint}`);
  const around = summary(x.list);
  const best = top(around.subs.get(main.key) ?? new Map<string, number>());
  if (best) return sub(best[0], true, `Other ${lower(main.label)} songs in this list`);
  // Last of all, the era of the songs around it: a discovery list keeps to one time far more often than not.
  const decade = top(around.decades);
  if (decade && decade[1] * 2 > around.dated) return sub(eraLabel(main.label, decade[0]), true, `Most dated songs in this list are from the ${eraLabel('', decade[0]).trim()}`);
  return out;
}
