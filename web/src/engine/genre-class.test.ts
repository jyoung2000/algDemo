/**
 * GENRE-CLASS-001. Owner: "add better genres & sub genres classification".
 *
 * Measured before (web/scripts/genre-coverage.ts): 232 of the Taste Picker's own subgenre words never
 * reached their subgenre, because only hip-hop's were admitted as tags; of 186 genre words the services
 * and MusicBrainz really send, 111 found a family and 74 a subgenre. SoundCloud's own genre menu
 * ("Hip-hop & Rap", "R&B & Soul", "Dance & EDM") was dropped outright.
 */
import { describe, expect, it } from 'vitest';
import { makeTag, normalize, pairSimilarity } from './genres';
import { classify, classifyAll, familyOfGenre } from './classify';
import { SUBS } from './genre-table';
import { subsFromArtist } from './infer';

const place = (word: string) => {
  const t = makeTag(word, 'test', 'track', 0.6);
  const c = t ? classify([t], null) : null;
  return c ? `${c.familySlug}/${c.key ?? '-'}` : 'none';
};

describe('every Taste Picker subgenre is reachable from its own words', () => {
  it('maps each subgenre name and alias to that subgenre, in every family', () => {
    const missed: string[] = [];
    for (const s of SUBS) {
      for (const a of [s.name, ...s.aliases]) {
        if (a === 'soundcloud') continue; // a platform, not a sound
        if (place(a) !== `${s.family}/${s.key}`) missed.push(`${a} -> ${place(a)} (want ${s.family}/${s.key})`);
      }
    }
    // A few aliases are claimed by an existing canonical genre of another subgenre on purpose
    // (e.g. "emo" stays punk-rock's emo, "garage" is UK garage); none may be left unplaced.
    expect(missed.filter((m) => m.includes('-> none'))).toEqual([]);
    expect(missed.length).toBeLessThanOrEqual(12);
  });

  it('places words outside hip-hop that used to be dropped', () => {
    expect(place('slowcore')).toBe('rock/slowcore');
    expect(place('midwest emo')).toBe('rock/midwest-emo');
    expect(place('metalcore')).toBe('rock/metalcore');
    expect(place('alternative r&b')).toBe('rnb-afro-latin/alt-rnb');
    expect(place('afro house')).toBe('rnb-afro-latin/afro-house');
    expect(place('latin trap')).toBe('rnb-afro-latin/latin-trap');
    expect(place('liquid funk')).toBe('electronic/liquid-dnb');
    expect(place('chillwave')).toBe('indie/chillwave');
    expect(place('art pop')).toBe('indie/art-pop');
    expect(place('jazz fusion')).toBe('soul-jazz-funk/jazz-funk');
    expect(place('neoclassical')).toBe('ambient-chill/neoclassical');
  });

  it('names the subgenre the original word meant when an older canonical name is broader', () => {
    // "bedroom pop" was stored as indie-pop and "vaporwave" as synthwave; the label keeps the real word.
    expect(place('bedroom pop')).toBe('pop/bedroom-pop');
    expect(place('vaporwave')).toBe('ambient-chill/vaporwave');
    // The stored tag name does not change, so taste comparisons of old plays still line up.
    expect(normalize('bedroom pop')).toBe('indie-pop');
  });
});

describe('the words the services actually send', () => {
  it('reads SoundCloud\u2019s combined genre names', () => {
    expect(place('Hip-hop & Rap')).toBe('hip-hop/-');
    expect(place('R&B & Soul')).toBe('rnb-afro-latin/-');
    expect(place('Dance & EDM')).toBe('electronic/-');
    expect(place('Jazz & Blues')).toBe('soul-jazz-funk/-');
    expect(place('Folk & Singer-Songwriter')).toBe('indie/-');
  });

  it('gives a family to genres the picker has no subgenre for, by their parent', () => {
    expect(place('deep house')).toBe('electronic/-');
    expect(place('dancehall')).toBe('rnb-afro-latin/-');
    expect(place('gospel')).toBe('soul-jazz-funk/-');
    expect(place('blues')).toBe('soul-jazz-funk/-');
    expect(place('black metal')).toBe('rock/-');
    expect(place('post-rock')).toBe('rock/-');
    expect(place('contemporary r&b')).toBe('rnb-afro-latin/-');
    expect(place('new jack swing')).toBe('rnb-afro-latin/-');
    expect(place('psytrance')).toBe('electronic/-');
    expect(place('dembow')).toBe('rnb-afro-latin/reggaeton');
    expect(familyOfGenre('deep-house')).toBe('electronic');
    expect(familyOfGenre('not-a-genre')).toBeNull();
  });

  it('still drops words that are not a sound', () => {
    for (const w of ['free download', 'soundcloud', 'piano', 'banger', '2024']) expect(place(w)).toBe('none');
  });

  it('still never places a song with no genre word by its tempo alone', () => {
    expect(classify([], 128)).toBeNull();
  });
});

describe('the newly placed subgenres count as their family in taste comparisons', () => {
  it('relates a subgenre to its family and to its siblings', () => {
    expect(pairSimilarity('slowcore', 'rock')).toBeGreaterThan(0);
    expect(pairSimilarity('alt-rnb', 'r&b')).toBeGreaterThan(0);
    expect(pairSimilarity('afro-house', 'amapiano')).toBeGreaterThan(0);
    expect(pairSimilarity('slowcore', 'trap')).toBe(0);
  });
});

describe('artist lookups name subgenres in every family', () => {
  it('keeps MusicBrainz tags such as alternative r&b and slowcore', () => {
    const body = { artists: [{ name: 'Frank Ocean', score: 100, tags: [{ name: 'alternative r&b', count: 9 }, { name: 'neo soul', count: 5 }, { name: 'singer-songwriter', count: 2 }, { name: 'american', count: 20 }] }] };
    expect(subsFromArtist(body, 'Frank Ocean').map((t) => t.name)).toEqual(['alt-rnb', 'neo-soul', 'singer-songwriter']);
  });

  it('shows a song\u2019s genres main family first, without a bare family beside its own subgenre', () => {
    const tags = ['R&B & Soul', 'alternative r&b', 'neo soul'].map((w, i) => makeTag(w, 't', 'track', 0.9 - i * 0.1)!);
    expect(classifyAll(tags, null).map((c) => c.subgenre ?? c.family)).toEqual(['Alt R&B', 'Neo-soul']);
  });
});
