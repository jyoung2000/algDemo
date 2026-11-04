import { describe, expect, it } from 'vitest';
import { artistsToAsk, withArtistSubs } from './artist-subs';
import { makeTag as make, type Tag } from './genres';

const makeTag = (name: string, source: string): Tag => make(name, source, 'artist', 0.8)!;

const hip = makeTag('hip-hop', 'Deezer genre');
const row = (artist: string, tags = [hip]) => ({ artist, track: { artists: [artist], tags } });

describe('artist subgenres', () => {
  it('adds an artist\'s remembered subgenre to a track that only names the family', () => {
    const jazz = makeTag('trap', 'MusicBrainz artist tags');
    const t = withArtistSubs({ artists: ['Kendrick Lamar'], tags: [hip] }, { 'kendrick lamar': { at: 1, tags: [jazz] } });
    expect((t['tags'] as { name: string }[]).map((g) => g.name)).toEqual(['hip-hop', 'trap']);
  });
  it('leaves a track that already names a subgenre, and an unknown artist, alone', () => {
    const own = { artists: ['X'], tags: [hip, makeTag('trap', 'Last.fm')] };
    expect(withArtistSubs(own, { x: { at: 1, tags: [makeTag('boom bap', 'MusicBrainz artist tags')] } })).toBe(own);
    const other = { artists: ['Y'], tags: [hip] };
    expect(withArtistSubs(other, {})).toBe(other);
  });
  it('asks the most-played artists whose songs name a family but nothing finer, skipping answered ones and recent empties', () => {
    // TAGS-MULTI-001: 'D' is a pop artist and is asked about too. The lookup used to be hip-hop
    // only, which is how a Beyoncé song stayed hip-hop with no R&B anywhere.
    const rows = [row('A'), row('B'), row('B'), row('C'), row('D', [makeTag('pop', 'x')])];
    const map = { a: { at: 1000, tags: [makeTag('trap', 'x')] }, c: { at: 1000, tags: [] } };
    expect(artistsToAsk(rows, map, 1500)).toEqual(['B', 'D']);
    expect(artistsToAsk(rows, map, 1000 + 15 * 24 * 3600)).toEqual(['B', 'C', 'D']);
  });
});
