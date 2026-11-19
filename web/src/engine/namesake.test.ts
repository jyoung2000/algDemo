import { describe, expect, it } from 'vitest';
import { artistTagsFit, currentTags, withoutNamesake, MB_ARTIST_SOURCE } from './infer';
import { genreIdentity } from './genre-identity';
import type { Tag } from './genres';

const deezer = (name: string, label = name): Tag => ({ name, label, source: 'Deezer album genre', scope: 'album', confidence: 0.8, inferred: false });
const mb = (name: string, label = name): Tag => ({ name, label, source: MB_ARTIST_SOURCE, scope: 'artist', confidence: 0.5, inferred: false });

describe('NAMESAKE-001: artist tags from someone else with the same name are not used', () => {
  it('drops a folk-rock band\'s tags from a rap song by a rapper of the same name (Cochise)', () => {
    expect(artistTagsFit([deezer('hip-hop', 'Rap/Hip Hop')], [mb('folk', 'folk rock')])).toBe(false);
    expect(withoutNamesake([deezer('hip-hop', 'Rap/Hip Hop'), mb('folk', 'folk rock')]).map((t) => t.label)).toEqual(['Rap/Hip Hop']);
  });
  it('keeps every tag of an artist who shares the song\'s family, even a second family (BigXthaPlug country)', () => {
    const tags = [deezer('hip-hop', 'Rap/Hip Hop'), mb('hip-hop', 'hip hop'), mb('trap'), mb('country')];
    expect(withoutNamesake(tags)).toHaveLength(4);
  });
  it('keeps artist tags for a song nothing else has placed', () => {
    expect(artistTagsFit([], [mb('folk', 'folk rock')])).toBe(true);
  });
});

describe('East Coast is a coast, not boom bap (owner, 2026-11-19)', () => {
  it('names "east coast hip hop" East Coast hip-hop, and keeps boom bap for boom bap', () => {
    expect(genreIdentity('east coast hip hop')?.label).toMatch(/East Coast/);
    expect(genreIdentity('boom bap')?.label).toMatch(/Boom bap/i);
  });
  it('renames a tag saved as boom bap from the words "east coast hip hop" when the list is read again', () => {
    const tags = [deezer('hip-hop', 'Rap/Hip Hop'), mb('boom-bap', 'east coast hip hop'), mb('trap')];
    expect(currentTags(tags).map((x) => x.name)).toEqual(['hip-hop', 'east-coast', 'trap']);
    const fine = [deezer('hip-hop', 'Rap/Hip Hop'), mb('trap')];
    expect(currentTags(fine)).toBe(fine);
  });
});
