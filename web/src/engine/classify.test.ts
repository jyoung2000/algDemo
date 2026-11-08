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
    expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('tempo alone places NOTHING when there is no genre tag', () => {
    // TASTE-ACCURACY-001. This used to pick the best tempo match across the whole catalog, so every
    // untagged song from 87 to 125 BPM came back as Rock / 'Nu-metal revival'. A hip-hop listener's
    // own history was then read back to them as rock. The same principle the family-only case
    // already applied ("art rock at 164 BPM is not metalcore") holds with no genre evidence at all.
    expect(classify([], 126)).toBeNull();
    expect(classify([], 101)).toBeNull();
  });

  it('a family-only tag keeps the family and no subgenre, whatever the tempo', () => {
    const c = classify([tag('alternative')], 164.72);
    // Radiohead-style art rock at 164 BPM is not metalcore just because its tempo falls in that range.
    expect(c!.family).toBe('Rock');
    expect(c!.subgenre).toBeNull();
  });

  it('a song with a family tag and a tempo is still placed, by its tag', () => {
    // Tempo is not thrown away: it still sharpens a song whose tag names a family, and it still
    // gives the map its vertical position. It just never invents the family itself.
    const c = classify([tag('hip-hop')], 101);
    expect(c).not.toBeNull();
    expect(c!.family).toBe('Hip-hop');
    expect(c!.subgenre).toBeNull();
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
