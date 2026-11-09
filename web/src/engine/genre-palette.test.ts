import { describe, expect, it } from 'vitest';
import { FAMILIES, SUBS } from './genre-table';
import { classify } from './classify';
import { chromaOf, readsKhaki, lightnessOf, SUB_DARKER_MAX, toneFamily, deltaE, familyColor, familyHalfBand, familyHue, hueGap, hueOf, PALETTE_FLOORS, subColorOf } from './genre-palette';

// TAGS-COLOR-001: every genre and subgenre colour is clearly its own, and still the Taste Picker's.
describe('genre palette', () => {
  it('gives every family a colour clearly apart from every other family', () => {
    for (const a of FAMILIES) for (const b of FAMILIES) {
      if (a === b) continue;
      expect(deltaE(familyColor(a.slug), familyColor(b.slug)), `${a.name} vs ${b.name}`).toBeGreaterThanOrEqual(PALETTE_FLOORS.family);
    }
  });

  it('gives every subgenre a colour clearly apart from its family and from every sibling', () => {
    for (const f of FAMILIES) {
      const subs = SUBS.filter((s) => s.family === f.slug);
      for (const s of subs) {
        expect(deltaE(subColorOf(s.key)!, familyColor(f.slug)), `${s.name} vs ${f.name}`).toBeGreaterThanOrEqual(PALETTE_FLOORS.subVsFamily);
        for (const o of subs) {
          if (o === s) continue;
          expect(deltaE(subColorOf(s.key)!, subColorOf(o.key)!), `${s.name} vs ${o.name}`).toBeGreaterThanOrEqual(PALETTE_FLOORS.sibling);
        }
      }
    }
  });

  it('keeps every subgenre inside its own family\u2019s band of the picker\u2019s spectrum', () => {
    for (const s of SUBS) {
      const off = hueGap(hueOf(subColorOf(s.key)!), familyHue(s.family));
      expect(off, s.name).toBeLessThan(familyHalfBand(s.family));
      // The nearest family by hue is its own, so a Rage bubble still reads as hip-hop.
      const nearest = FAMILIES.map((f) => [f.slug, hueGap(hueOf(subColorOf(s.key)!), familyHue(f.slug))] as const).sort((a, b) => a[1] - b[1])[0]![0];
      expect(nearest, s.name).toBe(s.family);
    }
  });

  it('is a plain sRGB hex colour every surface can draw, and the classifier uses it', () => {
    for (const s of SUBS) expect(subColorOf(s.key), s.name).toMatch(/^#[0-9a-f]{6}$/);
    for (const f of FAMILIES) expect(familyColor(f.slug), f.name).toMatch(/^#[0-9a-f]{6}$/);
    const rage = classify([{ name: 'rage', label: 'rage', confidence: 1 }] as never, null)!;
    const rap = classify([{ name: 'rap', label: 'rap', confidence: 1 }] as never, null)!;
    expect(rage.color).toBe(subColorOf('rage'));
    expect(rap.color).toBe(familyColor('hip-hop'));
    expect(deltaE(rage.color, rap.color)).toBeGreaterThanOrEqual(PALETTE_FLOORS.subVsFamily);
  });

  it('measures colour difference the standard way', () => {
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(1, 2);
    expect(deltaE('#336699', '#336699')).toBe(0);
  });
  it('never gives a genre a grey colour (the owner’s rule: no grey tags)', () => {
    for (const f of FAMILIES) expect(chromaOf(familyColor(f.slug)), f.name).toBeGreaterThanOrEqual(PALETTE_FLOORS.chroma);
    for (const s of SUBS) expect(chromaOf(subColorOf(s.key)!), s.name).toBeGreaterThanOrEqual(PALETTE_FLOORS.chroma);
  });
  it('keeps every family the colour its tags had in 0.12.3, which the owner checked (R&B red)', () => {
    // hsl(band centre, 75%, 53%), the Taste Picker's own colour for each family.
    expect(FAMILIES.map((f) => familyColor(f.slug))).toEqual(['#e1712d', '#cbe12d', '#44e12d', '#2de19e', '#2d9ee1', '#442de1', '#cb2de1', '#e12d71']);
    expect(familyColor('rnb-afro-latin')).toBe('#e12d71');
  });
  it('makes sister subgenres look alike: every one has its own family’s colour tone, never a neighbour’s', () => {
    // Owner (0.12.5): "sister subgenres should look alike but distinct". Alike: lightness aside, a
    // subgenre's tone is nearest its own family's (Rage reads as hip-hop, not Pop). Distinct: the
    // sibling floor above.
    for (const s of SUBS) expect(toneFamily(subColorOf(s.key)!), s.name).toBe(s.family);
  });
  it('never makes a sister much darker than its family, so a bright family’s sisters do not turn khaki', () => {
    for (const s of SUBS) {
      expect(lightnessOf(familyColor(s.family)) - lightnessOf(subColorOf(s.key)!), s.name).toBeLessThanOrEqual(SUB_DARKER_MAX + 0.01);
    }
  });
  it('never gives a genre a dark yellow, which reads khaki or brown', () => {
    for (const f of FAMILIES) expect(readsKhaki(familyColor(f.slug)), f.name).toBe(false);
    for (const s of SUBS) expect(readsKhaki(subColorOf(s.key)!), `${s.name} ${subColorOf(s.key)}`).toBe(false);
  });
});
