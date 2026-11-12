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
  if (fold(String(hit['title'] ?? '')) !== fold(title)) return null;
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
    .map(([name]) => ({ name, label: label.get(name) ?? name, source: MB_ALBUM_SOURCE, scope: 'album', confidence: 0.55, inferred: false }));
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
  return (withSubs['tags'] as Tag[]) ?? base;
}
