import { describe, expect, it } from 'vitest';
import { classify } from './classify';
import { makeTag, normalize } from './genres';
import { hipHopSubsFromArtist, needsHipHopSub } from './infer';

const tag = (name: string) => makeTag(name, 'test', 'track', 0.8)!;

describe('hip-hop subgenre words', () => {
  it.each([
    ['cloud rap', 'cloud-rap'],
    ['jazz rap', 'conscious'],
    ['west coast hip hop', 'west-coast'],
    ['g funk', 'west-coast'],
    ['crunk', 'southern'],
    ['boom bap', 'boom-bap'],
    ['east coast hip hop', 'boom-bap'],
    ['alternative hip hop', 'alt-hip-hop'],
    ['uk drill', 'uk-drill'],
    ['pluggnb', 'plugg'],
  ])('%s names %s, not plain hip-hop', (word, key) => {
    expect(normalize(word)).toBe(key);
    const c = classify([tag(word)], null)!;
    expect(c.familySlug).toBe('hip-hop');
    expect(c.key).toBe(key);
  });
  it('keeps the family word as family-only and does not read SoundCloud the platform as a genre', () => {
    expect(classify([tag('hip hop')], 140)!.subgenre).toBeNull();
    expect(normalize('soundcloud')).toBeNull();
  });
  it('leaves other families\' names where they were', () => {
    expect(normalize('synth pop')).toBe('synth-pop');
    expect(normalize('shoegaze')).toBe('shoegaze');
  });
});

describe('artist tags from MusicBrainz', () => {
  const body = (name: string, score: number, tags: [string, number][]) => ({ artists: [{ name, score, tags: tags.map(([n, count]) => ({ name: n, count })) }] });
  it('picks the artist\'s hip-hop subgenres by vote, ignoring non-hip-hop and generic tags', () => {
    const out = hipHopSubsFromArtist(
      body('Playboi Carti', 100, [['hip hop', 7], ['trap', 6], ['rap', 4], ['cloud rap', 4], ['plugg', 4], ['rage', 3], ['english', 2], ['house', 9]]),
      'Playboi Carti',
    );
    expect(out.map((t) => t.name)).toEqual(['trap', 'cloud-rap']);
    expect(out.every((t) => !t.inferred && t.confidence === 0.5)).toBe(true);
  });
  it('trusts only an exact, high-scoring name match', () => {
    expect(hipHopSubsFromArtist(body('Pop Smokey', 100, [['drill', 3]]), 'Pop Smoke')).toEqual([]);
    expect(hipHopSubsFromArtist(body('Pop Smoke', 70, [['drill', 3]]), 'Pop Smoke')).toEqual([]);
    expect(hipHopSubsFromArtist({}, 'x')).toEqual([]);
  });
  it('asks only when hip-hop is named without a subgenre', () => {
    expect(needsHipHopSub([tag('hip hop')])).toBe(true);
    expect(needsHipHopSub([tag('hip hop'), tag('drill')])).toBe(false);
    expect(needsHipHopSub([tag('house')])).toBe(false);
    expect(needsHipHopSub([])).toBe(false);
    expect(needsHipHopSub([{ ...tag('hip hop'), inferred: true }])).toBe(true);
  });
});
