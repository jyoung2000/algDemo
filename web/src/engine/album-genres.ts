/**
 * ALBUM-GENRE-DETAIL-001: the genres of one song on an album page.
 *
 * Album songs come straight from a provider, so they almost never carry tags of their own: Deezer
 * states a genre for the album, YouTube Music states nothing. One flat family ("R&B") is true but
 * not useful, so the artist's remembered MusicBrainz subgenres name the kind - the same rule
 * `withArtistSubs` applies to the listening history, through the same `needsSub` test, so a song
 * that names nothing at all is still never given a genre it has no evidence for.
 */
import { withArtistSubs, type ArtistSubsMap } from './artist-subs';
import { fold } from './identity';
import { familyOfGenre } from './classify';
import { FAMILY_TAGS } from './genre-table';
import { makeTag, type Tag } from './genres';
import type { Dict } from './shape';

export const MB_ALBUM_SOURCE = 'MusicBrainz album tags';

/** Words a service adds to an album title for a reissue; the record is the same one. */
const EDITION = /^(deluxe|deluxe edition|super deluxe|expanded|expanded edition|extended|bonus track version|bonus tracks?|remaster(?:ed)?(?:\s*\d{4})?|\d+(?:st|nd|rd|th) anniversary(?: edition)?|anniversary edition|special edition|explicit|clean|original motion picture soundtrack)$/i;

/**
 * An album title without its edition suffix: "A Great Chaos (Deluxe)" is the same record as
 * "A Great Chaos", and MusicBrainz files it under the plain name. Brackets that are part of a name
 * ("Untitled (Rise)") are left alone, because only known edition words are stripped.
 */
export function baseAlbumTitle(title: string): string {
  let out = title.trim();
  for (;;) {
    const m = /^(.*\S)\s*[([]([^)\]]+)[)\]]\s*$/.exec(out);
    if (!m || !EDITION.test(m[2]!.trim())) return out;
    out = m[1]!.trim();
  }
}

/**
 * ALBUM-GENRE-DETAIL-001: the community tags MusicBrainz holds for THIS release, which name a
 * record far more finely than a service's one-word album genre ("neo soul", "alternative r&b"
 * rather than "R&B"). Only an exact title and artist match is trusted, only tags the catalogue
 * knows as a genre are kept, and the three most-voted are returned. Pure, so it needs no network
 * to test, and it invents nothing when MusicBrainz has nothing.
 */
/**
 * The release-group MusicBrainz means, from its search answer: only an exact title and artist match
 * is trusted, so another record with a similar name is never read. Search answers carry no tags of
 * their own, which is why the id is what this returns.
 */
export function releaseGroupId(body: Dict, title: string, artist: string): string | null {
  const hit = ((body['release-groups'] as Dict[] | undefined) ?? [])[0];
  if (!hit) return null;
  const credited = ((hit['artist-credit'] as Dict[] | undefined) ?? []).map((c) => fold(String((c['artist'] as Dict | undefined)?.['name'] ?? c['name'] ?? '')));
  const theirs = fold(String(hit['title'] ?? ''));
  if (theirs !== fold(title) && theirs !== fold(baseAlbumTitle(title))) return null;
  if (artist && credited.length > 0 && !credited.includes(fold(artist))) return null;
  const id = String(hit['id'] ?? '');
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/**
 * ALBUM-GENRE-DETAIL-001: what MusicBrainz's listeners call THIS record, from a release-group
 * lookup with `inc=tags+genres`. These name a record far more finely than a service's one-word
 * album genre - "A Great Chaos" comes back as cloud rap, rage and hardcore hip hop where Deezer
 * says only "Rap/Hip Hop". Only words the catalogue knows as genres are kept, votes order them,
 * three at most, and an untagged release adds nothing. Pure: no network needed to test it.
 */
export function tagsFromReleaseGroup(body: Dict, title?: string, artist?: string, artistTags: Tag[] = []): Tag[] {
  // Accept either a lookup body (tags at the top level) or the one hit of a search answer.
  const hit = (body['release-groups'] as Dict[] | undefined)?.[0] ?? body;
  if (title !== undefined && (body['release-groups'] as Dict[] | undefined)) {
    if (!releaseGroupId(body, title, artist ?? '')) return [];
  }
  const votes = new Map<string, number>();
  const label = new Map<string, string>();
  for (const t of [...((hit['genres'] as Dict[] | undefined) ?? []), ...((hit['tags'] as Dict[] | undefined) ?? [])]) {
    const tag = makeTag(String(t['name'] ?? ''), MB_ALBUM_SOURCE, 'album', 0.55);
    if (!tag || !(FAMILY_TAGS[tag.name] || familyOfGenre(tag.name))) continue;
    votes.set(tag.name, (votes.get(tag.name) ?? 0) + Math.max(1, Number(t['count'] ?? 1)));
    if (!label.has(tag.name)) label.set(tag.name, tag.label);
  }
  // Votes first; when they tie - which is usual, most album tags have one vote - the tags the
  // artist is also known for come before an outlier, so a rage record keeps "rage" instead of
  // losing its slot to a single "chicago drill" vote.
  const known = new Set(artistTags.map((t) => t.name));
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1] || Number(known.has(b[0])) - Number(known.has(a[0])))
    .slice(0, 3)
    .map(([name, count]) => ({
      name,
      label: label.get(name) ?? name,
      source: MB_ALBUM_SOURCE,
      scope: 'album',
      // Votes raise it a little; being what the artist is known for raises it a lot, because one
      // listener's tag on one record is thin evidence beside an artist's whole catalogue.
      confidence: Math.min(0.95, 0.5 + Math.min(0.15, 0.05 * (count - 1)) + (known.has(name) ? 0.25 : 0)),
      inferred: false,
    }));
}

export interface AlbumGenreSources {
  /** What the service says about the album itself, already made into tags. */
  albumTags: Tag[];
  /** Artists whose subgenres this app has looked up before, by folded name. */
  subs: ArtistSubsMap;
  /** The album's artist, for songs whose own credit is missing. */
  artist?: string;
}

export function albumGenres(track: Dict, src: AlbumGenreSources): Tag[] {
  const own = ((track['tags'] as Tag[] | undefined) ?? []).filter((g) => g && typeof g.name === 'string');
  const base = own.length ? own : src.albumTags;
  if (!base.length) return [];
  const withSubs = withArtistSubs({ ...track, tags: base }, src.subs, src.artist);
  return dropCoveredFamilies((withSubs['tags'] as Tag[]) ?? base);
}

/**
 * ALBUM-RAGE-001: "Hip-hop" beside "Rage" adds nothing but takes a third of the bar. A bare family
 * word is dropped when a subgenre of that same family is present; a family nothing finer covers
 * stays, because then it is all that is known.
 */
export function dropCoveredFamilies(tags: Tag[]): Tag[] {
  const covered = new Set<string>();
  for (const t of tags) {
    if (FAMILY_TAGS[t.name]) continue;
    const fam = familyOfGenre(t.name);
    if (fam) covered.add(fam);
  }
  const kept = tags.filter((t) => !(FAMILY_TAGS[t.name] && covered.has(familyOfGenre(t.name) ?? FAMILY_TAGS[t.name] ?? '')));
  return kept.length ? kept : tags;
}
