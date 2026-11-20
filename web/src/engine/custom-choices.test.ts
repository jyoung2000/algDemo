// DISCOVER-TIDY-002: custom discovery counts as chosen once a genre or an artist is picked.
import { describe, expect, it } from 'vitest';
import { hasCustomChoices, normaliseCriteria } from './custom-discovery';

describe('hasCustomChoices', () => {
  it('needs a genre or an artist; counts and sliders alone are defaults', () => {
    expect(hasCustomChoices(normaliseCriteria({ count: 20, adventurous: 0.9, era: 0.8 }))).toBe(false);
    expect(hasCustomChoices(normaliseCriteria({ genres: ['family:hip-hop'] }))).toBe(true);
    expect(hasCustomChoices(normaliseCriteria({ artists: [{ name: 'MF DOOM' }] }))).toBe(true);
  });
});
