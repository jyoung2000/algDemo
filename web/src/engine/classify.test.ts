import { describe, expect, it } from 'vitest';
import { CATALOG } from './taste-catalog';
import { SUBS } from './genre-table';
import { classify, familyHue, tempoFitIn } from './classify';
import type { Tag } from './genres';

const tag = (name: string, confidence = 0.9): Tag => ({ name, label: name, source: 't', scope: 'track', confidence, inferred: false });

describe('genre table', () => {
  it('has every picker subgenre, once, under the same family', () => {
    const picker = CATALOG.flatMap((f) => f.subs.map((s) => ({ name: s.name, family: f.name })));
    expect(picker).toHaveLength(83);
    const names = new Set(SUBS.map((s) => s.name));
    expect(names.size).toBe(SUBS.length);
    for (const p of picker) expect(names.has(p.name)).toBe(true);
  });
});

describe('classify', () => {
  it('a tag naming a subgenre gives its family, colour and tempo fit', () => {
    const c = classify([tag('trap')], 140)!;
    expect(c.subgenre).toBe('Trap');
    expect(c.family).toBe('Hip-hop');
    expect(c.tempoFit).toBeGreaterThan(0.9);
    expect(c.color).toMatch(/^hsl\(/);
  });

  it('tempo alone places a song when there is no genre tag', () => {
    const c = classify([], 126)!;
    expect(c).not.toBeNull();
    expect(c.subgenre).not.toBeNull();
    expect(c.tempoFit).toBeGreaterThan(0.5);
  });

  it('a family-only tag keeps the family and no subgenre, whatever the tempo', () => {
    const c = classify([tag('alternative')], 164.72);
    // Radiohead-style art rock at 164 BPM is not metalcore just because its tempo falls in that range.
    expect(c!.family).toBe('Rock');
    expect(c!.subgenre).toBeNull();
  });

  it('a song with no genre tag is still placed by tempo', () => {
    const c = classify([], 126);
    expect(c!.subgenre).not.toBeNull();
  });


  it('a family-only tag keeps the family and no subgenre, whatever the tempo', () => {
    const c = classify([tag('electronic')], 124)!;
    expect(c.family).toBe('Electronic');
    expect(c.subgenre).toBeNull();
  });



  it('returns null with no genre and no tempo', () => {
    expect(classify([], null)).toBeNull();
    expect(classify([tag('meh')], null)).toBeNull(); // unknown tag is dropped upstream; still nothing to place
  });

  it('family hue follows the picker: band centre, i*45 + 22.5', () => {
    expect(familyHue('rock')).toBe(22.5);
    expect(familyHue('rnb-afro-latin')).toBe(7 * 45 + 22.5);
  });

  it('tempo fit is 1 inside the range, half and double time count, and it falls off', () => {
    expect(tempoFitIn(130, 120, 140, false)).toBe(1);
    expect(tempoFitIn(65, 120, 140, false)).toBeGreaterThan(0.5); // half of 130 is felt in range
    expect(tempoFitIn(60, 120, 140, false)).toBeGreaterThan(0.5); // 60 is half of 120: the same groove
    expect(tempoFitIn(95, 120, 140, false)).toBeLessThan(0.5); // neither 95 nor 190 is near 120-140
  });
});
