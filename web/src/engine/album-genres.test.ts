import { describe, expect, it, vi } from 'vitest';
import { withArtistSubs } from './artist-subs';
import { albumGenres, releaseGroupId, tagsFromReleaseGroup } from './album-genres';
import type { Tag } from './genres';
import type { Dict } from './shape';

/**
 * ALBUM-GENRE-DETAIL-001. Owner: "album tag / genre & sub genre classification is detailed and
 * correct."
 *
 * An album page used to read one flat family ("General R&B 100%") because album songs arrive from a
 * provider with no tags and only the album's own genre was left to fall back on. The album now gets
 * the same chain discovery uses: the song's own tags, then the album's stated genre, then the
 * artist's remembered MusicBrainz subgenres, so the bar names the kind of R&B - and never invents
 * one for an artist nothing knows.
 */
const tag = (name: string, scope = 'track'): Tag => ({ name, label: name, source: 'test', scope, confidence: 0.7, inferred: false });
const song = (over: Partial<Dict> = {}): Dict => ({ key: 'k', title: 'A song', artists: ['Sasha Keable'], tags: [], ...over });

describe('an album is classified in detail (ALBUM-GENRE-DETAIL-001)', () => {
  it('keeps a song\u2019s own tags when it has them', () => {
    const own = [tag('neo soul')];
    const out = albumGenres(song({ tags: own }), { albumTags: [tag('r&b', 'album')], subs: {} });
    expect(out.map((t) => t.name)).toEqual(['neo soul']);
  });

  it('falls back to the genre the service states for the album', () => {
    const out = albumGenres(song(), { albumTags: [tag('r&b', 'album')], subs: {} });
    expect(out.map((t) => t.name)).toEqual(['r&b']);
  });

  it('names the subgenre from the artist\u2019s remembered tags', () => {
    const subs = { 'sasha keable': { at: 1, tags: [tag('alternative r&b', 'artist')] } };
    const out = albumGenres(song(), { albumTags: [tag('r&b', 'album')], subs });
    expect(out.map((t) => t.name).sort()).toEqual(['alternative r&b', 'r&b']);
  });

  it('adds no subgenre when the family is not known either', () => {
    const subs = { 'sasha keable': { at: 1, tags: [tag('alternative r&b', 'artist')] } };
    expect(albumGenres(song(), { albumTags: [], subs })).toEqual([]);
  });

  it('does not borrow another artist\u2019s subgenres', () => {
    const subs = { 'someone else': { at: 1, tags: [tag('drill', 'artist')] } };
    const out = albumGenres(song(), { albumTags: [tag('r&b', 'album')], subs });
    expect(out.map((t) => t.name)).toEqual(['r&b']);
  });

  it('is the same rule withArtistSubs applies elsewhere', () => {
    const subs = { 'sasha keable': { at: 1, tags: [tag('alternative r&b', 'artist')] } };
    const viaShared = withArtistSubs(song({ tags: [tag('r&b', 'album')] }), subs);
    expect((viaShared['tags'] as Tag[]).map((t) => t.name).sort()).toEqual(
      albumGenres(song(), { albumTags: [tag('r&b', 'album')], subs }).map((t) => t.name).sort(),
    );
  });
});

describe('what MusicBrainz says about this release (ALBUM-GENRE-DETAIL-001)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    'release-groups': [{
      id: 'd3653ca9-c07a-4c03-84fb-fb14726fab56',
      title: 'Live From NPR\u2019s Tiny Desk',
      'artist-credit': [{ artist: { name: 'Sasha Keable' } }],
      tags: [{ name: 'neo soul', count: 9 }, { name: 'alternative r&b', count: 4 }, { name: 'live', count: 7 }],
      ...over,
    }],
  });

  it('refuses a different release with a similar name', () => {
    expect(tagsFromReleaseGroup(body(), 'Some Other Record', 'Sasha Keable')).toEqual([]);
  });

  it('refuses another artist\u2019s record of the same name', () => {
    expect(tagsFromReleaseGroup(body(), 'Live From NPR\u2019s Tiny Desk', 'Someone Else')).toEqual([]);
  });

  it('invents nothing when MusicBrainz knows the release but tagged it with nothing', () => {
    expect(tagsFromReleaseGroup(body({ tags: [] }), 'Live From NPR\u2019s Tiny Desk', 'Sasha Keable')).toEqual([]);
  });

  it('invents nothing when MusicBrainz has no such release', () => {
    expect(tagsFromReleaseGroup({ 'release-groups': [] }, 'Anything', 'Anyone')).toEqual([]);
  });
});

describe('the release MusicBrainz means (ALBUM-GENRE-DETAIL-001)', () => {
  const search = (over: Record<string, unknown> = {}) => ({
    'release-groups': [{
      id: 'd3653ca9-c07a-4c03-84fb-fb14726fab56',
      title: 'Live from NPR\u2019s Tiny Desk',
      'artist-credit': [{ artist: { name: 'Sasha Keable' } }],
      ...over,
    }],
  });

  it('takes the id of an exact title and artist match', () => {
    expect(releaseGroupId(search(), "Live From NPR's Tiny Desk", 'Sasha Keable')).toBe('d3653ca9-c07a-4c03-84fb-fb14726fab56');
  });

  it('takes no id for another record with a similar name', () => {
    expect(releaseGroupId(search(), 'Tiny Desk Concerts', 'Sasha Keable')).toBeNull();
  });

  it('takes no id for another artist', () => {
    expect(releaseGroupId(search(), "Live From NPR's Tiny Desk", 'Someone Else')).toBeNull();
  });

  it('reads the genres of a lookup answer, most voted first', () => {
    // The shape MusicBrainz really returns for A Great Chaos.
    const lookup = {
      title: 'A Great Chaos',
      genres: [{ name: 'cloud rap', count: 2 }, { name: 'gangsta rap', count: 1 }, { name: 'hardcore hip hop', count: 2 }, { name: 'rage', count: 2 }],
      tags: [{ name: 'english', count: 1 }, { name: 'offizielle charts', count: 1 }, { name: 'cloud rap', count: 2 }],
    };
    const out = tagsFromReleaseGroup(lookup);
    expect(out.length).toBe(3);
    expect(out.map((t) => t.label)).not.toContain('english');
    expect(out.map((t) => t.name)).toContain('cloud-rap');
  });

  it('adds nothing for a release nobody has tagged', () => {
    expect(tagsFromReleaseGroup({ title: 'Live from NPR\u2019s Tiny Desk', tags: [], genres: [] })).toEqual([]);
  });
});

describe('ties are broken by what the artist is known for (ALBUM-GENRE-DETAIL-001)', () => {
  // More Chaos (Ken Carson) is tagged chicago drill, hardcore hip hop, hip hop, industrial hip hop,
  // pop rap and rage - every one with a single vote. Cutting at three by arrival order showed
  // "drill" and dropped "rage", which is the one thing this record is actually known for.
  const lookup = {
    title: 'More Chaos',
    genres: [
      { name: 'chicago drill', count: 1 }, { name: 'hardcore hip hop', count: 1 },
      { name: 'hip hop', count: 1 }, { name: 'industrial hip hop', count: 1 },
      { name: 'pop rap', count: 1 }, { name: 'rage', count: 1 },
    ],
  };
  const artistTags = [
    { name: 'rage', label: 'rage', source: 'mb', scope: 'artist', confidence: 0.5, inferred: false },
    { name: 'trap', label: 'trap', source: 'mb', scope: 'artist', confidence: 0.5, inferred: false },
  ];

  it('keeps a tied tag the artist is also tagged with', () => {
    const out = tagsFromReleaseGroup(lookup, undefined, undefined, artistTags);
    expect(out.map((t) => t.name)).toContain('rage');
  });

  it('still takes votes first when they are not tied', () => {
    const voted = { title: 'x', genres: [{ name: 'drill', count: 9 }, { name: 'rage', count: 1 }] };
    expect(tagsFromReleaseGroup(voted, undefined, undefined, artistTags)[0]!.name).toBe('drill');
  });

  it('works with nothing known about the artist', () => {
    expect(tagsFromReleaseGroup(lookup).length).toBe(3);
  });
});
