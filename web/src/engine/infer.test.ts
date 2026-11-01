import { describe, expect, it } from 'vitest';
import { inferFromArtist, inferFromSeed, inferFromSound, tagsFromMusicBrainz } from './infer';
import type { Dict } from './shape';

const tag = (name: string, confidence = 0.8, inferred = false) => ({ name, label: name, source: 't', scope: 'album', confidence, inferred });

describe('inferFromArtist', () => {
  const map = { radiohead: { alternative: 2.4, rock: 0.8 }, thin: { pop: 0.2 } };
  it('inherits the genre the artist carries most, marked inferred', () => {
    const t = inferFromArtist({ artists: ['Radiohead'] } as Dict, map);
    expect(t?.name).toBe('alternative');
    expect(t?.inferred).toBe(true);
    expect(t!.confidence).toBeLessThan(0.8); // never outranks real album metadata
  });
  it('needs real evidence: unknown artists and thin rows give nothing', () => {
    expect(inferFromArtist({ artists: ['Nobody'] } as Dict, map)).toBeNull();
    expect(inferFromArtist({ artists: ['Thin'] } as Dict, map)).toBeNull();
  });
});

describe('inferFromSound', () => {
  // Orthogonal unit vectors: a and b sound identical, c is unrelated.
  const v = (i: number) => {
    const a = new Float64Array(4);
    a[i] = 1;
    return a;
  };
  const vectors = new Map([
    ['x', v(0)],
    ['n1', v(0)],
    ['n2', v(0)],
    ['far', v(2)],
  ]);
  const labeled = [
    { key: 'n1', tags: [tag('trap')] },
    { key: 'n2', tags: [tag('trap')] },
    { key: 'far', tags: [tag('jazz')] },
  ] as Dict[];
  it('lets near neighbours vote and marks the result inferred', () => {
    const t = inferFromSound({ key: 'x' } as Dict, vectors, labeled);
    expect(t?.name).toBe('trap');
    expect(t?.inferred).toBe(true);
  });
  it('gives nothing without a vector or with too few neighbours', () => {
    expect(inferFromSound({ key: 'no-vec' } as Dict, vectors, labeled)).toBeNull();
    expect(inferFromSound({ key: 'x' } as Dict, vectors, labeled.slice(0, 1))).toBeNull();
  });
  it('ignores neighbours whose only tags are themselves inferred', () => {
    const guessed = [
      { key: 'n1', tags: [{ ...tag('trap'), inferred: true }] },
      { key: 'n2', tags: [{ ...tag('trap'), inferred: true }] },
    ] as Dict[];
    expect(inferFromSound({ key: 'x' } as Dict, vectors, guessed)).toBeNull();
  });
});

describe('inferFromSeed', () => {
  it('lends the seed leading real tag at low confidence', () => {
    const t = inferFromSeed({ tags: [tag('indie'), { ...tag('noise', 0.9), inferred: true }] } as Dict);
    expect(t?.name).toBe('indie');
    expect(t?.confidence).toBe(0.25);
    expect(t?.inferred).toBe(true);
  });
  it('gives nothing from a seed with no real tags', () => {
    expect(inferFromSeed(undefined)).toBeNull();
    expect(inferFromSeed({ tags: [{ ...tag('x'), inferred: true }] } as Dict)).toBeNull();
  });
});

describe('tagsFromMusicBrainz', () => {
  it('takes the most-voted community tags, marked inferred', () => {
    const body = { recordings: [{ tags: [{ name: 'grunge', count: 7 }, { name: 'rock', count: 3 }, { name: 'zero', count: 0 }] }] } as Dict;
    const tags = tagsFromMusicBrainz(body);
    expect(tags.map((t) => t.name)).toEqual(['grunge', 'rock']); // most-voted first; zero-vote tags dropped
    expect(tags.every((t) => t.inferred)).toBe(true);
  });
  it('handles empty answers', () => {
    expect(tagsFromMusicBrainz({} as Dict)).toEqual([]);
    expect(tagsFromMusicBrainz({ recordings: [] } as Dict)).toEqual([]);
  });
});
