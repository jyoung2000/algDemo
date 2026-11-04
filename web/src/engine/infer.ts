/**
 * Genre inference for songs whose providers sent no usable genre. Three rungs, strongest first:
 *
 *  1. the artist's other songs (seen in any earlier run) name a genre -> inherit it;
 *  2. the song's stored audio vector sits near labeled songs -> the neighbours vote;
 *  3. the recommending seed's own tags -> the family is assumed, marked as a guess.
 *
 * Every tag written here carries `inferred: true` and a source naming the rung, so the UI can say
 * "guessed" instead of presenting an inference as metadata. Confidences stay below real metadata
 * (Deezer album genre is 0.8): artist 0.45, sound 0.3..0.55 by similarity, seed 0.25.
 */
import { type Tag, makeTag, tagStrength } from './genres';
import { FAMILY_TAGS, SUBS } from './genre-table';
import { fold } from './identity';
import type { Store } from './store';
import type { Dict } from './shape';

/** Source labels on inferred tags; the engine's v2 scorer treats these as non-independent evidence. */
export const ARTIST_GUESS_SOURCE = "The artist's other songs";
export const SOUND_GUESS_SOURCE = 'Songs that sound the same';
export const SEED_GUESS_SOURCE = 'Guessed from the starting song';

const AKEY = 'artist_genres';
const MAX_ARTISTS = 800;

type ArtistMap = Record<string, Record<string, number>>;

const artistOf = (t: Dict): string => String((t['artists'] as string[] | undefined)?.[0] ?? t['artist'] ?? '').toLowerCase().trim();

const realTags = (t: Dict): Tag[] => ((t['tags'] as Tag[] | undefined) ?? []).filter((g) => g && !g.inferred);

/** Remember which genre names each artist's songs carried; capped, oldest-seen dropped first. */
export async function recordArtistGenres(store: Store, tracks: Dict[]): Promise<void> {
  const map = store.get<ArtistMap>(AKEY) ?? {};
  let changed = false;
  for (const t of tracks) {
    const a = artistOf(t);
    const tags = realTags(t);
    if (!a || !tags.length) continue;
    const row = (map[a] ??= {});
    for (const g of tags.slice(0, 3)) {
      row[g.name] = (row[g.name] ?? 0) + tagStrength(g);
      changed = true;
    }
  }
  const keys = Object.keys(map);
  if (keys.length > MAX_ARTISTS) for (const k of keys.slice(0, keys.length - MAX_ARTISTS)) delete map[k];
  if (changed) await store.put(AKEY, map);
}

/** The genre this artist's other songs carry most, as one low-confidence artist-scope tag. */
export function inferFromArtist(track: Dict, map: ArtistMap): Tag | null {
  const row = map[artistOf(track)];
  if (!row) return null;
  const best = Object.entries(row).sort((x, y) => y[1] - x[1])[0];
  if (!best || best[1] < 0.5) return null;
  const tag = makeTag(best[0], ARTIST_GUESS_SOURCE, 'artist', 0.45);
  return tag ? { ...tag, inferred: true } : null;
}

const cosine = (a: Float64Array, b: Float64Array): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * Nearest labeled songs by stored audio vector vote on the genre. Needs the song's own vector and
 * at least two labeled neighbours above the floor; the winning name must hold a majority of the
 * vote weight, or the sound is ambiguous and nothing is returned.
 */
export function inferFromSound(track: Dict, vectors: Map<string, Float64Array>, labeled: Dict[], k = 5, floor = 0.5): Tag | null {
  const v = vectors.get(String(track['key']));
  if (!v) return null;
  const near: { sim: number; tags: Tag[] }[] = [];
  for (const o of labeled) {
    if (o['key'] === track['key']) continue;
    const tags = realTags(o);
    const ov = tags.length ? vectors.get(String(o['key'])) : undefined;
    if (!ov) continue;
    const sim = cosine(v, ov);
    if (sim >= floor) near.push({ sim, tags });
  }
  if (near.length < 2) return null;
  near.sort((a, b) => b.sim - a.sim);
  const votes = new Map<string, number>();
  let total = 0;
  for (const n of near.slice(0, k)) {
    const g = n.tags[0]!;
    votes.set(g.name, (votes.get(g.name) ?? 0) + n.sim);
    total += n.sim;
  }
  const [name, w] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (w / total <= 0.5) return null;
  const top = near[0]!.sim;
  const tag = makeTag(name, SOUND_GUESS_SOURCE, 'track', Math.max(0.3, Math.min(0.55, 0.3 + (top - floor))));
  return tag ? { ...tag, inferred: true } : null;
}

/** Last resort: the seed that recommended the song lends its leading genre, plainly marked a guess. */
export function inferFromSeed(seed: Dict | undefined, source = SEED_GUESS_SOURCE): Tag | null {
  const tags = seed ? realTags(seed) : [];
  if (!tags.length) return null;
  const lead = [...tags].sort((a, b) => tagStrength(b) - tagStrength(a))[0]!;
  const tag = makeTag(lead.name, source, 'artist', 0.25);
  return tag ? { ...tag, inferred: true } : null;
}

/** MusicBrainz recording search by ISRC; the community tags become low-confidence track tags. */
export function tagsFromMusicBrainz(body: Dict): Tag[] {
  const recs = (body['recordings'] as Dict[] | undefined) ?? [];
  const mb = ((recs[0]?.['tags'] as Dict[] | undefined) ?? [])
    .filter((t) => Number(t['count'] ?? 0) > 0)
    .sort((a, b) => Number(b['count']) - Number(a['count']))
    .slice(0, 3);
  const seen = new Set<string>();
  return mb
    .map((t) => makeTag(String(t['name'] ?? ''), 'MusicBrainz listeners', 'track', 0.6))
    .filter((t): t is Tag => t !== null && !seen.has(t.name) && (seen.add(t.name), true))
    .map((t) => ({ ...t, inferred: true }));
}

const HIPHOP_SUB_KEYS = new Set(SUBS.filter((x) => x.family === 'hip-hop').map((x) => x.key));
/** Every subgenre key, whatever its family: the artist lookup is not a hip-hop lookup (TAGS-MULTI-001). */
const SUB_KEYS = new Set(SUBS.map((x) => x.key));
export const MB_ARTIST_SOURCE = 'MusicBrainz artist tags';

/** True when a song is placed in hip-hop but no tag names which kind. */
export function needsHipHopSub(tags: Tag[] | null | undefined): boolean {
  const t = (tags ?? []).filter(Boolean); // a family guessed from the artist or seed still needs its subgenre named
  return t.some((g) => g.name === 'hip-hop') && !t.some((g) => HIPHOP_SUB_KEYS.has(g.name));
}

/**
 * Whether an artist is worth asking about: the song names a family but nothing finer
 * (TAGS-MULTI-001).
 *
 * This used to be hip-hop only, which is how a Beyoncé song stayed "hip-hop" with no R&B anywhere:
 * her artist tags were fetched for other songs and dropped on the floor. Any family counts now. A
 * song with no genre at all is still not asked about — an artist's tags are not evidence about a
 * song that nothing has placed (TASTE-ACCURACY-001).
 */
export function needsSub(tags: Tag[] | null | undefined): boolean {
  const t = (tags ?? []).filter(Boolean);
  if (!t.length) return false;
  const hasFamily = t.some((g) => FAMILY_TAGS[g.name]);
  const hasSub = t.some((g) => SUB_KEYS.has(g.name));
  return hasFamily && !hasSub;
}

/**
 * MusicBrainz artist search: the artist's community tags ("drill", "cloud rap", "jazz rap") name the
 * hip-hop subgenres a family-only tag cannot. Only an exact, top-scoring name match is trusted, only
 * hip-hop subgenres are kept, and the best two by vote count are returned, each below album-level
 * metadata in confidence. Pure, so it can be tested without a network.
 */
export function subsFromArtist(body: Dict, artist: string): Tag[] {
  const hit = ((body['artists'] as Dict[] | undefined) ?? [])[0];
  if (!hit || Number(hit['score'] ?? 0) < 95 || fold(String(hit['name'] ?? '')) !== fold(artist)) return [];
  const votes = new Map<string, number>();
  const label = new Map<string, string>();
  for (const t of (hit['tags'] as Dict[] | undefined) ?? []) {
    const tag = makeTag(String(t['name'] ?? ''), MB_ARTIST_SOURCE, 'artist', 0.5);
    // Any known subgenre, or a family word that names one of the picker's families: a tag that
    // means nothing to the catalogue is still ignored, so nothing is invented from noise.
    if (!tag || !(SUB_KEYS.has(tag.name) || FAMILY_TAGS[tag.name])) continue;
    votes.set(tag.name, (votes.get(tag.name) ?? 0) + Math.max(1, Number(t['count'] ?? 1)));
    if (!label.has(tag.name)) label.set(tag.name, tag.label);
  }
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    // Three, not two: a song can carry several genres, and an artist usually earns two or three
    // real ones ('r&b', 'soul', 'dance-pop') before the votes thin out.
    .slice(0, 3)
    .map(([name]) => ({ name, label: label.get(name) ?? name, source: MB_ARTIST_SOURCE, scope: 'artist', confidence: 0.5, inferred: false }));
}

/** @deprecated Use {@link subsFromArtist}; kept so the hip-hop rules keep their own name in tests. */
export function hipHopSubsFromArtist(body: Dict, artist: string): Tag[] {
  const hit = ((body['artists'] as Dict[] | undefined) ?? [])[0];
  if (!hit || Number(hit['score'] ?? 0) < 95 || fold(String(hit['name'] ?? '')) !== fold(artist)) return [];
  const votes = new Map<string, number>();
  const label = new Map<string, string>();
  for (const t of (hit['tags'] as Dict[] | undefined) ?? []) {
    const tag = makeTag(String(t['name'] ?? ''), MB_ARTIST_SOURCE, 'artist', 0.5);
    if (!tag || !HIPHOP_SUB_KEYS.has(tag.name)) continue;
    votes.set(tag.name, (votes.get(tag.name) ?? 0) + Math.max(1, Number(t['count'] ?? 1)));
    if (!label.has(tag.name)) label.set(tag.name, tag.label);
  }
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name]) => ({ name, label: label.get(name) ?? name, source: MB_ARTIST_SOURCE, scope: 'artist', confidence: 0.5, inferred: false }));
}
