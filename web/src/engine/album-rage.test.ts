import { describe, expect, it } from 'vitest';
import { playlistMix } from './playlist-mix';
import { albumGenres, tagsFromReleaseGroup } from './album-genres';
import type { Tag } from './genres';
import type { Dict } from './shape';

/**
 * ALBUM-RAGE-001. Owner, looking at More Chaos: "more chaos is a rage album."
 *
 * Every song on an album page is placed from the same album-level tags, so each tag was played
 * exactly as often as the others and the bar split evenly - rage, pop-rap and a bare "hip-hop" at
 * 34/33/33. Even thirds say nothing about what a record sounds like. When an album's songs are
 * placed from album-level evidence, the bar follows the strength of that evidence instead of the
 * play count: votes on MusicBrainz, corroboration by the artist's own tags, and a bare family word
 * never standing beside a subgenre of that same family.
 */
const tag = (name: string, confidence = 0.55, scope = 'album'): Tag =>
  ({ name, label: name, source: 'test', scope, confidence, inferred: false });
const songs = (n: number): Dict[] => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, title: `S${i}`, artists: ['Ken Carson'], tags: [] }));

const mixOf = (albumTags: Tag[], subs = {}) =>
  playlistMix(songs(21), (t) => albumGenres({ ...t, tags: [] }, { albumTags, subs, artist: 'Ken Carson' }), 1_700_000_000, { byEvidence: true });

const sharesOf = (mix: ReturnType<typeof mixOf>): Record<string, number> => {
  const genres = ((mix.taste as Dict | null)?.['genres'] ?? []) as { name: string; score: number }[];
  const total = genres.reduce((a, g) => a + Math.abs(g.score), 0) || 1;
  return Object.fromEntries(genres.map((g) => [g.name, Math.round((Math.abs(g.score) / total) * 100)]));
};

describe('an album bar follows the evidence, not the play count (ALBUM-RAGE-001)', () => {
  it('lets the strongest tag lead instead of splitting evenly', () => {
    const shares = sharesOf(mixOf([tag('rage', 0.75), tag('pop-rap', 0.55)]));
    expect(shares['rage']).toBeGreaterThan(shares['pop-rap']!);
  });

  it('drops a bare family word standing beside a subgenre of that family', () => {
    const out = albumGenres({ key: 'k', tags: [] }, { albumTags: [tag('rage'), tag('hip-hop')], subs: {}, artist: 'Ken Carson' });
    expect(out.map((t) => t.name)).toEqual(['rage']);
  });

  it('keeps a family word when nothing finer is known', () => {
    const out = albumGenres({ key: 'k', tags: [] }, { albumTags: [tag('hip-hop')], subs: {}, artist: 'Ken Carson' });
    expect(out.map((t) => t.name)).toEqual(['hip-hop']);
  });

  it('keeps a family word from another family', () => {
    const out = albumGenres({ key: 'k', tags: [] }, { albumTags: [tag('rage'), tag('pop')], subs: {}, artist: 'Ken Carson' });
    expect(out.map((t) => t.name).sort()).toEqual(['pop', 'rage']);
  });

  it('weights a tag the artist is known for above one stray vote', () => {
    // More Chaos as MusicBrainz really has it: every genre with a single vote.
    const lookup = {
      title: 'More Chaos',
      genres: [
        { name: 'chicago drill', count: 1 }, { name: 'hardcore hip hop', count: 1 },
        { name: 'hip hop', count: 1 }, { name: 'industrial hip hop', count: 1 },
        { name: 'pop rap', count: 1 }, { name: 'rage', count: 1 },
      ],
    };
    const artistTags = [tag('rage', 0.5, 'artist'), tag('trap', 0.5, 'artist')];
    const out = tagsFromReleaseGroup(lookup, undefined, undefined, artistTags);
    const rage = out.find((t) => t.name === 'rage');
    expect(rage).toBeTruthy();
    for (const other of out.filter((t) => t.name !== 'rage')) expect(rage!.confidence).toBeGreaterThan(other.confidence);
  });

  it('a record whose songs carry their own tags still counts songs, not evidence', () => {
    const own = [tag('rage', 0.6, 'track')];
    const mix = playlistMix(
      songs(4).map((s, i) => (i < 3 ? { ...s, tags: own } : { ...s, tags: [tag('trap', 0.6, 'track')] })),
      (t) => (t['tags'] as Tag[]) ?? [],
      1_700_000_000,
    );
    const genres = ((mix.taste as Dict | null)?.['genres'] ?? []) as { name: string; plays: number }[];
    expect(genres.find((g) => g.name === 'rage')?.plays).toBe(3);
  });
});
