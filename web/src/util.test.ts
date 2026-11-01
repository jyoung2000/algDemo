import { describe, expect, it } from 'vitest';
import type { RecItem, TasteSummary } from './api';
import { ListenMeter, describeCharacteristics, describeTaste, mergeRerank, qualifiesCompletion, toneLabel } from './util';

const item = (key: string, rank: number): RecItem => ({ rank, track: { key } }) as unknown as RecItem;

describe('describeCharacteristics', () => {
  it('lists tempo, genres, year and fit; says nothing for unknowns', () => {
    expect(describeCharacteristics({ bpm: 92, genres: ['Hip Hop', 'Rap', 'Soul'], explicit: true, duration: 200, release_year: '2024', popularity: null, taste_fit: 0.824 })).toEqual([
      '92 BPM', 'Hip Hop / Rap', '2024', 'Explicit', '82% fit to your listening',
    ]);
    expect(describeCharacteristics({ bpm: null, genres: [], explicit: null, duration: null, release_year: null, popularity: null, taste_fit: null })).toEqual([]);
    expect(describeCharacteristics(undefined)).toEqual([]);
  });

  it('names the family and subgenre, or the family alone, and exposes it as the tone label', () => {
    const base = { bpm: null, genres: [], explicit: null, duration: null, release_year: null, popularity: null, taste_fit: null };
    expect(describeCharacteristics({ ...base, family: 'Hip-hop', subgenre: 'Trap' })).toEqual(['Hip-hop · Trap']);
    expect(describeCharacteristics({ ...base, family: 'Rock', subgenre: null })).toEqual(['Rock']);
    // the family is not repeated when a genre label already says it
    expect(describeCharacteristics({ ...base, genres: ['Rock'], family: 'Rock', subgenre: null })).toEqual(['Rock']);
    expect(toneLabel({ ...base, genres: ['Pop / Rock'], family: 'Rock', subgenre: null })).toBeNull();
    expect(toneLabel({ ...base, family: 'Rock', subgenre: null })).toBe('Rock');
    expect(toneLabel({ ...base })).toBeNull();
  });
});

describe('describeTaste', () => {
  const t: TasteSummary = { events: 5, positives: 3, negatives: 2, bpm: 92, skip_bpm: 170, likes: [{ name: 'hip hop', label: 'Hip Hop', score: 0.6 }], avoids: [{ name: 'metal', label: 'Metal', score: -0.5 }] };
  it('says what was learned in words', () => {
    expect(describeTaste(t)).toBe('Learned from 5 songs you played: you keep Hip Hop; you skip Metal; you stay near 92 BPM.');
  });
  it('is empty with no listening', () => {
    expect(describeTaste(null)).toBe('');
    expect(describeTaste({ ...t, events: 0 })).toBe('');
  });
});

describe('ListenMeter: actual time and unique content coverage', () => {
  it('excludes seeks, pauses and buffering; a replay adds time but not coverage', () => {
    const m = new ListenMeter();
    m.tick(0, true);
    m.tick(0.5, true);
    m.tick(1, true);
    m.tick(1, false);
    m.tick(1, false); // paused interval
    m.seeked(20); // seeking forward does not count as heard
    m.tick(20.5, true);
    m.tick(21, true);
    m.seeked(0); // replay the first second
    m.tick(0.5, true);
    m.tick(1, true);
    expect(m.listened).toBeCloseTo(3);
    expect(m.coverage).toBeCloseTo(2);
    m.tick(50, true); // discontinuity/buffering: not an actual playing interval
    expect(m.listened).toBeCloseTo(3);
    expect(m.coverage).toBeCloseTo(2);
  });
  it('an end reached by seeking ahead is not a full-track completion', () => {
    expect(qualifiesCompletion('full', 20, 180)).toBe(false);
    expect(qualifiesCompletion('full', 130, 180)).toBe(true);
    expect(qualifiesCompletion('preview', 20, 30)).toBe(false);
    expect(qualifiesCompletion('preview', 25, 30)).toBe(true);
    expect(qualifiesCompletion('full', 20, null)).toBe(true); // duration unknown; no ratio claimed
  });
});

describe('mergeRerank', () => {
  it('keeps played songs first, drops duplicates, renumbers', () => {
    const prev = [item('a', 1), item('b', 2), item('c', 3)];
    const next = [item('d', 1), item('b', 2), item('c', 3)];
    const out = mergeRerank(prev, next, new Set(['a', 'b']));
    expect(out.map((x) => x.track.key)).toEqual(['a', 'b', 'd', 'c']);
    expect(out.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
  });
});
